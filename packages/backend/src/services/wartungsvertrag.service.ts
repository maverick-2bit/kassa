import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  ersteVertragsperiode,
  letzteVertragsperiode,
  positionFaellig,
  rechnungsBlockEnde,
  vertragsPerioden,
  addMonate,
  type AngebotPosition,
  type KundeSnapshot,
  type SammelrechnungResponse,
  type WartungRechnungFaellig,
  type WartungsIntervall,
  type WartungslaufEintrag,
  type WartungslaufResponse,
  type WartungsvertragInput,
  type WartungsvertragResponse,
  type WartungsvertragStatus,
  type WartungsvertragUpdate,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  kassen,
  lieferscheine,
  wartungsvertraege,
  wartungsvertragPositionen,
} from '../db/schema.js'
import { ladeKundeSnapshot } from './kunde.service.js'
import { erstelleSammelrechnung, LiferscheinError } from './lieferschein.service.js'
import { wienJetzt } from './auto-abschluss.service.js'

export class WartungError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

/** Ältere Monate werden beim Nachholen nicht mehr automatisch erzeugt (Schutz vor Tippfehler im Beginn). */
export const MAX_NACHHOL_MONATE = 12

type VertragRow = typeof wartungsvertraege.$inferSelect
type PosRow     = typeof wartungsvertragPositionen.$inferSelect

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

async function zuDto(db: Db, row: VertragRow): Promise<WartungsvertragResponse> {
  const positionen = await db
    .select().from(wartungsvertragPositionen)
    .where(eq(wartungsvertragPositionen.vertragId, row.id))
    .orderBy(asc(wartungsvertragPositionen.reihenfolge))

  const ls = await db
    .select({ periode: lieferscheine.periode, status: lieferscheine.status })
    .from(lieferscheine)
    .where(eq(lieferscheine.wartungsvertragId, row.id))

  const perioden = ls.map(l => l.periode).filter((p): p is string => !!p).sort()
  const letzte   = perioden[perioden.length - 1]

  let kunde: KundeSnapshot | undefined
  try { kunde = await ladeKundeSnapshot(db, row.kundeId, row.mandantId) } catch { /* Kunde gelöscht → ohne Snapshot */ }

  return {
    id:                  row.id,
    nummer:              row.nummer,
    kasseId:             row.kasseId,
    kundeId:             row.kundeId,
    ...(kunde && { kunde }),
    bezeichnung:         row.bezeichnung,
    beginn:              row.beginn,
    ...(row.ende  && { ende:  row.ende }),
    rechnungsIntervall:  row.rechnungsIntervall as WartungsIntervall,
    status:              row.status as WartungsvertragStatus,
    ...(row.notiz && { notiz: row.notiz }),
    positionen: positionen.map((p: PosRow) => ({
      id:                 p.id,
      ...(p.artikelId && { artikelId: p.artikelId }),
      bezeichnung:        p.bezeichnung,
      menge:              p.menge,
      einzelpreisBreutto: p.einzelpreisBruttoCent,
      mwstSatz:           p.mwstSatz as WartungsvertragResponse['positionen'][number]['mwstSatz'],
      intervall:          p.intervall as WartungsIntervall,
      ...(p.ankerMonat != null && { ankerMonat: p.ankerMonat }),
    })),
    ...(letzte && { letztePeriode: letzte }),
    offeneLieferscheine: ls.filter(l => l.status === 'offen').length,
    createdAt:           row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listeWartungsvertraege(
  db:        Db,
  mandantId: string,
  opts: { kundeId?: string; status?: WartungsvertragStatus } = {},
): Promise<WartungsvertragResponse[]> {
  const bedingungen = [eq(wartungsvertraege.mandantId, mandantId)]
  if (opts.kundeId) bedingungen.push(eq(wartungsvertraege.kundeId, opts.kundeId))
  if (opts.status)  bedingungen.push(eq(wartungsvertraege.status,  opts.status))
  const rows = await db.select().from(wartungsvertraege)
    .where(and(...bedingungen)).orderBy(desc(wartungsvertraege.nummer))
  return Promise.all(rows.map(r => zuDto(db, r)))
}

export async function holeWartungsvertrag(db: Db, id: string, mandantId: string): Promise<WartungsvertragResponse> {
  const [row] = await db.select().from(wartungsvertraege)
    .where(and(eq(wartungsvertraege.id, id), eq(wartungsvertraege.mandantId, mandantId))).limit(1)
  if (!row) throw new WartungError(404, 'Wartungsvertrag nicht gefunden')
  return zuDto(db, row)
}

async function pruefeKasseUndKunde(db: Db, mandantId: string, kasseId: string | undefined, kundeId: string | undefined): Promise<void> {
  if (kasseId) {
    const [k] = await db.select({ id: kassen.id }).from(kassen)
      .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId))).limit(1)
    if (!k) throw new WartungError(404, 'Kasse nicht gefunden')
  }
  if (kundeId) {
    try { await ladeKundeSnapshot(db, kundeId, mandantId) }
    catch { throw new WartungError(404, 'Kunde nicht gefunden') }
  }
}

function posWerte(vertragId: string, positionen: WartungsvertragInput['positionen']) {
  return positionen.map((p, i) => ({
    vertragId,
    reihenfolge:           i,
    ...(p.artikelId && { artikelId: p.artikelId }),
    bezeichnung:           p.bezeichnung,
    menge:                 p.menge,
    einzelpreisBruttoCent: p.einzelpreisBreutto,
    mwstSatz:              p.mwstSatz,
    intervall:             p.intervall,
    ankerMonat:            p.ankerMonat ?? null,
  }))
}

export async function erstelleWartungsvertrag(
  db:        Db,
  mandantId: string,
  input:     WartungsvertragInput,
): Promise<WartungsvertragResponse> {
  await pruefeKasseUndKunde(db, mandantId, input.kasseId, input.kundeId)

  const id = await db.transaction(async (tx) => {
    const [n] = await tx
      .select({ n: sql<number>`COALESCE(MAX(${wartungsvertraege.nummer}), 0) + 1` })
      .from(wartungsvertraege).where(eq(wartungsvertraege.mandantId, mandantId))
    const [row] = await tx.insert(wartungsvertraege).values({
      mandantId,
      kasseId:            input.kasseId,
      kundeId:            input.kundeId,
      nummer:             n?.n ?? 1,
      bezeichnung:        input.bezeichnung,
      beginn:             input.beginn,
      ende:               input.ende ?? null,
      rechnungsIntervall: input.rechnungsIntervall,
      status:             input.status,
      notiz:              input.notiz ?? null,
    }).returning({ id: wartungsvertraege.id })
    if (!row) throw new WartungError(500, 'Wartungsvertrag konnte nicht angelegt werden')
    await tx.insert(wartungsvertragPositionen).values(posWerte(row.id, input.positionen))
    return row.id
  })
  return holeWartungsvertrag(db, id, mandantId)
}

export async function aktualisiereWartungsvertrag(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     WartungsvertragUpdate,
): Promise<WartungsvertragResponse> {
  const aktuell = await holeWartungsvertrag(db, id, mandantId)
  await pruefeKasseUndKunde(db, mandantId, undefined, input.kundeId)

  // Beginn nachträglich ändern wäre nur sauber, solange noch nichts erzeugt wurde
  if (input.beginn && input.beginn !== aktuell.beginn && aktuell.letztePeriode) {
    throw new WartungError(409, 'Der Vertragsbeginn lässt sich nicht mehr ändern, sobald Lieferscheine erzeugt wurden')
  }
  const beginn = input.beginn ?? aktuell.beginn
  const ende   = input.ende === undefined ? aktuell.ende : (input.ende ?? undefined)
  if (ende && ende < beginn) throw new WartungError(400, 'Das Ende liegt vor dem Beginn')

  await db.transaction(async (tx) => {
    await tx.update(wartungsvertraege).set({
      ...(input.kundeId            !== undefined && { kundeId:            input.kundeId }),
      ...(input.bezeichnung        !== undefined && { bezeichnung:        input.bezeichnung }),
      ...(input.beginn             !== undefined && { beginn:             input.beginn }),
      ...(input.ende               !== undefined && { ende:               input.ende }),
      ...(input.rechnungsIntervall !== undefined && { rechnungsIntervall: input.rechnungsIntervall }),
      ...(input.status             !== undefined && { status:             input.status }),
      ...(input.notiz              !== undefined && { notiz:              input.notiz }),
      updatedAt: new Date(),
    }).where(and(eq(wartungsvertraege.id, id), eq(wartungsvertraege.mandantId, mandantId)))

    if (input.positionen) {
      await tx.delete(wartungsvertragPositionen).where(eq(wartungsvertragPositionen.vertragId, id))
      await tx.insert(wartungsvertragPositionen).values(posWerte(id, input.positionen))
    }
  })
  return holeWartungsvertrag(db, id, mandantId)
}

// ---------------------------------------------------------------------------
// Monatslauf: Wartungslieferscheine
// ---------------------------------------------------------------------------

type Logger = { info: (msg: string) => void; error: (obj: unknown, msg: string) => void }

function periodeText(periode: string): string {
  return `${periode.slice(5, 7)}/${periode.slice(0, 4)}`
}

/** Positionen, die der Vertrag in dieser Periode berechnet (aufgelöst für den Lieferschein). */
function faelligePositionen(v: WartungsvertragResponse, periode: string): AngebotPosition[] {
  const erste = ersteVertragsperiode(v.beginn)
  // Beginn ab dem 16.: im ersten Monat nur 50 % der monatlichen Positionen
  const halb  = periode === erste && ersterMonatFaktor(v.beginn) === 0.5
  return v.positionen
    .filter(p => positionFaellig(p, periode, erste))
    .map(p => {
      const anteilig = halb && p.intervall === 'monatlich'
      const preis    = anteilig
        ? (p.einzelpreisBreutto < 0 ? -Math.round(-p.einzelpreisBreutto / 2) : Math.round(p.einzelpreisBreutto / 2))
        : p.einzelpreisBreutto
      return {
        bezeichnung:        `${p.bezeichnung} (${periodeText(periode)}${anteilig ? ', anteilig 50 %' : ''})`.slice(0, 200),
        menge:              p.menge,
        einzelpreisBreutto: preis,
        mwstSatz:           p.mwstSatz,
        ...(p.artikelId && { artikelId: p.artikelId }),
      }
    })
}

function betrag(positionen: AngebotPosition[]): number {
  return positionen.reduce((s, p) => s + Math.round(p.menge * p.einzelpreisBreutto), 0)
}

/**
 * Erzeugt für alle aktiven Verträge die fehlenden Wartungslieferscheine bis zum aktuellen
 * Monat (Wiener Zeit). Wiederholbar: pro Vertrag und Monat entsteht höchstens einer.
 * Mit `vorschau` wird nur berechnet, was erzeugt würde.
 */
export async function fuehreWartungslaufDurch(
  db:   Db,
  opts: { jetzt: Date; mandantId?: string; vorschau?: boolean; log?: Logger },
): Promise<WartungslaufResponse> {
  const vorschau = opts.vorschau ?? false
  const aktuellePeriode = wienJetzt(opts.jetzt).datum.slice(0, 7)
  const fruehestens     = addMonate(aktuellePeriode, -(MAX_NACHHOL_MONATE - 1))

  const bedingungen = [eq(wartungsvertraege.status, 'aktiv')]
  if (opts.mandantId) bedingungen.push(eq(wartungsvertraege.mandantId, opts.mandantId))
  const vertraege = await db.select().from(wartungsvertraege).where(and(...bedingungen))

  const eintraege: WartungslaufEintrag[] = []

  for (const row of vertraege) {
    try {
      const v = await zuDto(db, row)
      const vorhanden = new Set(
        (await db.select({ periode: lieferscheine.periode }).from(lieferscheine)
          .where(eq(lieferscheine.wartungsvertragId, row.id)))
          .map(l => l.periode),
      )

      const perioden = vertragsPerioden(v.beginn, v.ende, aktuellePeriode)
        .filter(p => p >= fruehestens && !vorhanden.has(p))

      for (const periode of perioden) {
        const positionen = faelligePositionen(v, periode)
        if (positionen.length === 0) continue

        const eintrag: WartungslaufEintrag = {
          vertragId: v.id, vertragNummer: v.nummer, periode,
          positionen: positionen.length, betragCent: betrag(positionen),
        }
        if (!vorschau) {
          const nummer = await legeLieferscheinAn(db, row, v, periode, positionen)
          if (nummer === null) continue // parallel schon erzeugt
          eintrag.lieferscheinNummer = nummer
        }
        eintraege.push(eintrag)
      }
    } catch (err) {
      opts.log?.error({ err, vertrag: row.id }, 'Wartungslauf für Vertrag fehlgeschlagen')
    }
  }

  if (!vorschau && eintraege.length > 0) {
    opts.log?.info(`Wartungslauf: ${eintraege.length} Lieferschein(e) erzeugt`)
  }
  return { vorschau, eintraege }
}

async function legeLieferscheinAn(
  db:         Db,
  row:        VertragRow,
  v:          WartungsvertragResponse,
  periode:    string,
  positionen: AngebotPosition[],
): Promise<number | null> {
  const kundeSnapshot = await ladeKundeSnapshot(db, row.kundeId, row.mandantId)
  try {
    return await db.transaction(async (tx) => {
      const [n] = await tx
        .select({ n: sql<number>`COALESCE(MAX(${lieferscheine.nummer}), 0) + 1` })
        .from(lieferscheine).where(eq(lieferscheine.mandantId, row.mandantId))
      const nummer = n?.n ?? 1
      await tx.insert(lieferscheine).values({
        mandantId:         row.mandantId,
        kasseId:           row.kasseId,
        wartungsvertragId: row.id,
        periode,
        nummer,
        datum:             new Date(`${periode}-01T12:00:00Z`),
        positionen,
        notiz:             `Wartungsvertrag W-${String(v.nummer).padStart(4, '0')} – ${v.bezeichnung}, ${periodeText(periode)}`,
        kundeId:           row.kundeId,
        kundeSnapshot,
      })
      return nummer
    })
  } catch (err) {
    // Eindeutiger Index (Vertrag, Periode): ein paralleler Lauf war schneller
    if ((err as { code?: string }).code === '23505' &&
        String((err as { constraint_name?: string }).constraint_name ?? '').includes('vertrag_periode')) return null
    throw err
  }
}

// ---------------------------------------------------------------------------
// Sammelrechnung: fällige Verrechnung
// ---------------------------------------------------------------------------

/**
 * Welche offenen Wartungslieferscheine sind verrechenbar? Ein Lieferschein ist verrechenbar,
 * sobald der Monat erreicht ist, der seinen Rechnungsblock abschließt (bei „quartal" also
 * der dritte Monat), oder der Vertrag beendet ist.
 */
export async function ermittleFaelligeRechnungen(
  db:        Db,
  mandantId: string,
  jetzt:     Date,
  nurVertragId?: string,
): Promise<WartungRechnungFaellig[]> {
  const aktuellePeriode = wienJetzt(jetzt).datum.slice(0, 7)

  const bedingungen = [eq(wartungsvertraege.mandantId, mandantId)]
  if (nurVertragId) bedingungen.push(eq(wartungsvertraege.id, nurVertragId))
  const vertraege = await db.select().from(wartungsvertraege).where(and(...bedingungen)).orderBy(asc(wartungsvertraege.nummer))

  const ergebnis: WartungRechnungFaellig[] = []
  for (const row of vertraege) {
    const offene = await db.select().from(lieferscheine).where(and(
      eq(lieferscheine.wartungsvertragId, row.id),
      eq(lieferscheine.status, 'offen'),
    )).orderBy(asc(lieferscheine.periode))
    if (offene.length === 0) continue

    const erste   = ersteVertragsperiode(row.beginn)
    const endeMon = row.ende ? letzteVertragsperiode(row.ende) : undefined
    const faellig = offene.filter(l => {
      const blockEnde = rechnungsBlockEnde(row.rechnungsIntervall as WartungsIntervall, l.periode!, erste)
      return blockEnde <= aktuellePeriode || (endeMon !== undefined && endeMon <= aktuellePeriode)
    })
    if (faellig.length === 0) continue

    let kunde: KundeSnapshot | undefined
    try { kunde = await ladeKundeSnapshot(db, row.kundeId, mandantId) } catch { /* ohne Snapshot */ }

    ergebnis.push({
      vertragId:       row.id,
      vertragNummer:   row.nummer,
      bezeichnung:     row.bezeichnung,
      ...(kunde && { kunde }),
      lieferscheinIds: faellig.map(l => l.id),
      perioden:        faellig.map(l => l.periode!),
      betragCent:      faellig.reduce((s, l) => s + betrag(l.positionen as AngebotPosition[]), 0),
    })
  }
  return ergebnis
}

/** Fasst die fälligen Wartungslieferscheine eines Vertrags zur Sammelrechnung zusammen. */
export async function rechneWartungsvertragAb(
  db:        Db,
  mandantId: string,
  vertragId: string,
  jetzt:     Date,
): Promise<SammelrechnungResponse> {
  await holeWartungsvertrag(db, vertragId, mandantId) // 404, falls fremd/unbekannt
  const [faellig] = await ermittleFaelligeRechnungen(db, mandantId, jetzt, vertragId)
  if (!faellig) throw new WartungError(409, 'Für diesen Vertrag ist aktuell nichts zu verrechnen')
  try {
    return await erstelleSammelrechnung(db, mandantId, { lieferscheinIds: faellig.lieferscheinIds })
  } catch (err) {
    if (err instanceof LiferscheinError) throw new WartungError(err.httpStatus, err.message)
    throw err
  }
}
