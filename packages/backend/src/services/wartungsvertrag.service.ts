import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import {
  ersteVertragsperiode,
  letzterVertragsmonat,
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
  kunden,
  lieferscheine,
  mandanten,
  offenePosten,
  sammelrechnungen,
  wartungsvertraege,
  wartungsvertragPositionen,
} from '../db/schema.js'
import { ladeKundeSnapshot } from './kunde.service.js'
import { erstelleSammelrechnung, holeSammelrechnung, LiferscheinError } from './lieferschein.service.js'
import { erstelleOffenerPosten } from './offenerPosten.service.js'
import { isEmailAktiv, sendeBelegzweigEmail, sendeStornoRechnungEmail } from './email.service.js'
import { ladeZahlungsangaben } from './zahlungsangaben.js'
import type { Config } from '../config.js'
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

/** Laufzeit aus der Häufigkeit (Anzahl × Rechnungsintervall); null = unbefristet */
function laufzeitVon(row: VertragRow): { anzahl: number; intervall: WartungsIntervall } | null {
  return row.anzahlAbrechnungen != null
    ? { anzahl: row.anzahlAbrechnungen, intervall: row.rechnungsIntervall as WartungsIntervall }
    : null
}

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

  const letzteAbrechnung = letzterVertragsmonat(row.beginn, row.ende, laufzeitVon(row))

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
    ...(row.anzahlAbrechnungen != null && { anzahlAbrechnungen: row.anzahlAbrechnungen }),
    ...(letzteAbrechnung && { letzteAbrechnung }),
    status:              row.status as WartungsvertragStatus,
    ...(row.notiz && { notiz: row.notiz }),
    positionen: positionen.map((p: PosRow) => ({
      id:                 p.id,
      ...(p.artikelId && { artikelId: p.artikelId }),
      bezeichnung:        p.bezeichnung,
      menge:              p.menge,
      einzelpreisBreutto: p.einzelpreisBruttoCent,
      mwstSatz:           p.mwstSatz as WartungsvertragResponse['positionen'][number]['mwstSatz'],
      ...(p.intervall && { intervall: p.intervall as WartungsIntervall }),
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
    intervall:             p.intervall ?? null,
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
      anzahlAbrechnungen: input.anzahlAbrechnungen ?? null,
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
      ...(input.anzahlAbrechnungen !== undefined && { anzahlAbrechnungen: input.anzahlAbrechnungen }),
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
  return v.positionen
    .filter(p => positionFaellig({ ...p, intervall: p.intervall ?? v.rechnungsIntervall }, periode, erste))
    .map(p => ({
      bezeichnung:        `${p.bezeichnung} (${periodeText(periode)})`.slice(0, 200),
      menge:              p.menge,
      einzelpreisBreutto: p.einzelpreisBreutto,
      mwstSatz:           p.mwstSatz,
      ...(p.artikelId && { artikelId: p.artikelId }),
    }))
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

      const perioden = vertragsPerioden(v.beginn, v.ende, aktuellePeriode, laufzeitVon(row))
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
  opts: { ohneGesperrte?: boolean } = {},
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
    // Nach einem Storno nur noch von Hand verrechenbar — die Automatik lässt diese Lieferscheine liegen
    const verrechenbar = opts.ohneGesperrte ? offene.filter(l => !l.manuellVerrechnen) : offene
    if (verrechenbar.length === 0) continue

    const erste   = ersteVertragsperiode(row.beginn)
    const endeMon = letzterVertragsmonat(row.beginn, row.ende, laufzeitVon(row))
    const faellig = verrechenbar.filter(l => {
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

/** Empfänger des Rechnungs-Mails — nur bei Kunden mit aktiviertem Mailversand und Adresse. */
async function mailEmpfaengerVon(db: Db, mandantId: string, kundeId: string): Promise<string | undefined> {
  const [k] = await db
    .select({ email: kunden.email, perMail: kunden.rechnungPerMail })
    .from(kunden).where(and(eq(kunden.id, kundeId), eq(kunden.mandantId, mandantId))).limit(1)
  return k?.perMail && k.email ? k.email : undefined
}

/**
 * Verschickt die freigegebene Sammelrechnung an den hinterlegten Empfänger. Ein Fehler bricht nichts ab: er wird
 * an der Rechnung vermerkt und vom Cron erneut versucht. Ohne Freigabe geht nie etwas raus.
 */
export async function versendeSammelrechnung(
  db:        Db,
  config:    Config,
  mandantId: string,
  srId:      string,
  log?:      Logger,
): Promise<boolean> {
  const sr = await holeSammelrechnung(db, srId, mandantId)
  if (!sr.emailEmpfaenger || sr.storniertAm || !sr.freigegebenAm) return false
  if (sr.emailVersandtAm)  return true

  const [m] = await db.select({ firmenname: mandanten.firmenname }).from(mandanten)
    .where(eq(mandanten.id, mandantId)).limit(1)
  try {
    await sendeBelegzweigEmail(sr.emailEmpfaenger, {
      art:        'rechnung',
      firmenname: m?.firmenname ?? '',
      nummer:     sr.nummer,
      datum:      sr.datum,
      ...(sr.kunde?.bezeichnung ? { kundeName: sr.kunde.bezeichnung } : {}),
      positionen: sr.lieferscheine.flatMap(ls => ls.positionen).map(p => ({
        bezeichnung: p.bezeichnung, menge: p.menge, einzelpreisBreutto: p.einzelpreisBreutto, ...(p.seriennummern ? { seriennummern: p.seriennummern } : {}),
      })),
      gesamtbetragCent: sr.gesamtbetragCent,
      zahlung: await ladeZahlungsangaben(db, mandantId, sr.datum),
    }, config)
    await db.update(sammelrechnungen)
      .set({ emailVersandtAm: new Date(), emailFehler: null })
      .where(eq(sammelrechnungen.id, srId))
    return true
  } catch (err) {
    const text = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    await db.update(sammelrechnungen).set({ emailFehler: text }).where(eq(sammelrechnungen.id, srId))
    log?.error({ err, sammelrechnung: srId }, 'Rechnungsversand fehlgeschlagen')
    return false
  }
}

/**
 * Storno einer bereits per Mail verschickten Rechnung: Der Kunde bekommt automatisch ein Mail mit der Stornorechnung.
 * (Die korrigierte Rechnung geht danach — wie jede Rechnung — erst nach Freigabe in einem eigenen Mail raus.)
 * Ein Fehler wird vermerkt und vom Cron erneut versucht.
 */
export async function versendeStornoMail(
  db:        Db,
  config:    Config,
  mandantId: string,
  srId:      string,
  log?:      Logger,
): Promise<boolean> {
  const sr = await holeSammelrechnung(db, srId, mandantId)
  if (!sr.storniertAm || sr.stornoNummer === undefined) return false
  if (!sr.emailVersandtAm || !sr.emailEmpfaenger)       return false   // Rechnung ging nie per Mail raus
  if (sr.stornoEmailVersandtAm)                         return true

  try {
    if (!isEmailAktiv(config)) throw new Error('Der Mailversand ist nicht eingerichtet (SMTP)')
    const [m] = await db.select({ firmenname: mandanten.firmenname }).from(mandanten)
      .where(eq(mandanten.id, mandantId)).limit(1)
    await sendeStornoRechnungEmail(sr.emailEmpfaenger, {
      firmenname:     m?.firmenname ?? '',
      stornoNummer:   sr.stornoNummer,
      rechnungNummer: sr.nummer,
      rechnungDatum:  sr.datum,
      datum:          sr.storniertAm,
      ...(sr.kunde?.bezeichnung ? { kundeName: sr.kunde.bezeichnung } : {}),
      positionen: sr.lieferscheine.flatMap(ls => ls.positionen).map(p => ({
        bezeichnung: p.bezeichnung, menge: p.menge, einzelpreisBreutto: p.einzelpreisBreutto, ...(p.seriennummern ? { seriennummern: p.seriennummern } : {}),
      })),
      gesamtbetragCent: sr.gesamtbetragCent,
    }, config)
    await db.update(sammelrechnungen)
      .set({ stornoEmailVersandtAm: new Date(), stornoEmailFehler: null })
      .where(eq(sammelrechnungen.id, srId))
    return true
  } catch (err) {
    const text = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    await db.update(sammelrechnungen).set({ stornoEmailFehler: text }).where(eq(sammelrechnungen.id, srId))
    log?.error({ err, sammelrechnung: srId }, 'Storno-Mail fehlgeschlagen')
    return false
  }
}

/**
 * Fasst die fälligen Wartungslieferscheine eines Vertrags zur Sammelrechnung zusammen und legt den offenen Posten
 * an. Die Rechnung wartet danach auf die Freigabe — versendet oder gedruckt wird erst dann.
 */
export async function rechneWartungsvertragAb(
  db:        Db,
  mandantId: string,
  vertragId: string,
  jetzt:     Date,
  log?:      Logger,
  opts:      { ohneGesperrte?: boolean } = {},
): Promise<SammelrechnungResponse> {
  const vertrag = await holeWartungsvertrag(db, vertragId, mandantId) // 404, falls fremd/unbekannt
  const [faellig] = await ermittleFaelligeRechnungen(db, mandantId, jetzt, vertragId, opts)
  if (!faellig) throw new WartungError(409, 'Für diesen Vertrag ist aktuell nichts zu verrechnen')

  // Zustellung per Mail steht mit der Rechnung fest; verschickt wird erst nach der Freigabe
  const empfaenger = await mailEmpfaengerVon(db, mandantId, vertrag.kundeId)

  let sr: SammelrechnungResponse
  try {
    sr = await erstelleSammelrechnung(db, mandantId, { lieferscheinIds: faellig.lieferscheinIds }, {
      wartungsvertragId: vertragId,
      ...(empfaenger ? { emailEmpfaenger: empfaenger } : {}),
    })
  } catch (err) {
    if (err instanceof LiferscheinError) throw new WartungError(err.httpStatus, err.message)
    throw err
  }

  // Forderung in den Offenen Posten, damit unbezahlte Wartungsrechnungen nachverfolgbar sind
  try {
    const op = await erstelleOffenerPosten(db, mandantId, {
      kundeId:    vertrag.kundeId,
      betragCent: sr.gesamtbetragCent,
      notiz:      `Sammelrechnung SR-${String(sr.nummer).padStart(4, '0')} – Wartungsvertrag W-${String(vertrag.nummer).padStart(4, '0')}`,
    })
    // Verknüpfung, damit der Posten mit einem Storno der Rechnung entfällt
    await db.update(offenePosten).set({ sammelrechnungId: sr.id }).where(eq(offenePosten.id, op.id))
  } catch (err) {
    log?.error({ err, sammelrechnung: sr.id }, 'Offener Posten zur Wartungsrechnung konnte nicht angelegt werden')
  }
  return sr
}

/**
 * Automatik: Für Kunden mit Rechnungsversand per Mail werden fällige Wartungsrechnungen selbst erstellt. Sie landen
 * in der Freigabe — nichts geht ohne Zutun raus. Bereits freigegebene, aber nicht zugestellte Mails werden erneut
 * versucht (nur mit eingerichtetem Mailversand).
 */
export async function fuehreAutoRechnungenDurch(
  db:     Db,
  config: Config,
  jetzt:  Date,
  log?:   Logger,
): Promise<{ erstellt: number; erneutVersendet: number }> {
  const kandidaten = await db
    .select({ id: wartungsvertraege.id, mandantId: wartungsvertraege.mandantId })
    .from(wartungsvertraege)
    .innerJoin(kunden, eq(wartungsvertraege.kundeId, kunden.id))
    .where(and(eq(kunden.rechnungPerMail, true), isNotNull(kunden.email)))

  let erstellt = 0
  for (const k of kandidaten) {
    try {
      const [faellig] = await ermittleFaelligeRechnungen(db, k.mandantId, jetzt, k.id, { ohneGesperrte: true })
      if (!faellig) continue
      await rechneWartungsvertragAb(db, k.mandantId, k.id, jetzt, log, { ohneGesperrte: true })
      erstellt++
    } catch (err) {
      log?.error({ err, vertrag: k.id }, 'Automatische Wartungsrechnung fehlgeschlagen')
    }
  }

  let erneutVersendet = 0
  if (isEmailAktiv(config)) {
    // Nach einem Fehler, oder wenn ein Versand hängen blieb
    const vorEinerStunde = new Date(jetzt.getTime() - 3_600_000)
    const offen = await db
      .select({ id: sammelrechnungen.id, mandantId: sammelrechnungen.mandantId })
      .from(sammelrechnungen)
      .where(and(
        isNotNull(sammelrechnungen.emailEmpfaenger),
        isNull(sammelrechnungen.emailVersandtAm),
        isNotNull(sammelrechnungen.wartungsvertragId),
        isNotNull(sammelrechnungen.freigegebenAm),
        isNull(sammelrechnungen.storniertAm),
        or(isNotNull(sammelrechnungen.emailFehler), lt(sammelrechnungen.freigegebenAm, vorEinerStunde)),
      ))
    for (const sr of offen) {
      if (await versendeSammelrechnung(db, config, sr.mandantId, sr.id, log)) erneutVersendet++
    }

    // Storno-Mails, die nicht rausgegangen sind
    const stornoOffen = await db
      .select({ id: sammelrechnungen.id, mandantId: sammelrechnungen.mandantId })
      .from(sammelrechnungen)
      .where(and(
        isNotNull(sammelrechnungen.storniertAm),
        isNotNull(sammelrechnungen.emailVersandtAm),
        isNull(sammelrechnungen.stornoEmailVersandtAm),
        isNotNull(sammelrechnungen.stornoEmailFehler),
      ))
    for (const sr of stornoOffen) {
      if (await versendeStornoMail(db, config, sr.mandantId, sr.id, log)) erneutVersendet++
    }
  }

  if (erstellt > 0 || erneutVersendet > 0) {
    log?.info(`Wartungsrechnungen: ${erstellt} zur Freigabe erstellt, ${erneutVersendet} Mails erneut versendet`)
  }
  return { erstellt, erneutVersendet }
}

// ---------------------------------------------------------------------------
// Rechnungsübersicht, Freigabe, Ausdruck
// ---------------------------------------------------------------------------

/** Alle Wartungsrechnungen (neueste zuerst) mit ihren verrechneten Lieferscheinen. */
export async function listeWartungsRechnungen(db: Db, mandantId: string): Promise<SammelrechnungResponse[]> {
  const ids = await db
    .select({ id: sammelrechnungen.id })
    .from(sammelrechnungen)
    .where(and(eq(sammelrechnungen.mandantId, mandantId), isNotNull(sammelrechnungen.wartungsvertragId)))
    .orderBy(desc(sammelrechnungen.nummer))
    .limit(300)
  return Promise.all(ids.map(r => holeSammelrechnung(db, r.id, mandantId)))
}

export interface FreigabeErgebnis {
  freigegeben: SammelrechnungResponse[]
  abgelehnt:   Array<{ id: string; nummer: number; grund: string }>
}

/**
 * Gibt Wartungsrechnungen frei: Erst jetzt geht die Mail raus (Kunden mit Mailversand). Der Ausdruck — ein
 * Exemplar für die Buchhaltung bei Mail-Kunden, zwei (Kunde + Buchhaltung) bei allen anderen — erfolgt am Bildschirm
 * direkt nach der Freigabe. Mail-Kunden ohne eingerichteten Mailversand lassen sich nicht freigeben.
 */
export async function gibRechnungenFrei(
  db:        Db,
  config:    Config,
  mandantId: string,
  ids:       string[],
  log?:      Logger,
): Promise<FreigabeErgebnis> {
  const ergebnis: FreigabeErgebnis = { freigegeben: [], abgelehnt: [] }
  for (const id of ids) {
    const [row] = await db.select().from(sammelrechnungen)
      .where(and(eq(sammelrechnungen.id, id), eq(sammelrechnungen.mandantId, mandantId))).limit(1)
    if (!row) { ergebnis.abgelehnt.push({ id, nummer: 0, grund: 'Rechnung nicht gefunden' }); continue }
    const ablehnen = (grund: string) => ergebnis.abgelehnt.push({ id, nummer: row.nummer, grund })

    if (!row.wartungsvertragId)  { ablehnen('Keine Wartungsrechnung'); continue }
    if (row.storniertAm)         { ablehnen('Die Rechnung ist storniert'); continue }
    if (row.freigegebenAm)       { ablehnen('Schon freigegeben'); continue }
    if (row.emailEmpfaenger && !isEmailAktiv(config)) {
      ablehnen('Der Mailversand ist nicht eingerichtet (SMTP) — die Rechnung kann nicht per Mail verschickt werden')
      continue
    }

    // Nur der erste Zugriff gibt frei (Doppelklick/zweites Fenster)
    const gesetzt = await db.update(sammelrechnungen)
      .set({ freigegebenAm: new Date() })
      .where(and(eq(sammelrechnungen.id, id), isNull(sammelrechnungen.freigegebenAm), isNull(sammelrechnungen.storniertAm)))
      .returning({ id: sammelrechnungen.id })
    if (gesetzt.length === 0) { ablehnen('Schon freigegeben'); continue }

    if (row.emailEmpfaenger) await versendeSammelrechnung(db, config, mandantId, id, log)
    ergebnis.freigegeben.push(await holeSammelrechnung(db, id, mandantId))
  }
  return ergebnis
}

/** Freigegebene Rechnungen, deren Ausdruck (Buchhaltung bzw. Kunde + Buchhaltung) noch nicht bestätigt ist. */
export async function listeBuchhaltungsRechnungen(db: Db, mandantId: string): Promise<SammelrechnungResponse[]> {
  const ids = await db
    .select({ id: sammelrechnungen.id })
    .from(sammelrechnungen)
    .where(and(
      eq(sammelrechnungen.mandantId, mandantId),
      isNotNull(sammelrechnungen.wartungsvertragId),
      isNotNull(sammelrechnungen.freigegebenAm),
      isNull(sammelrechnungen.buchhaltungGedrucktAm),
      isNull(sammelrechnungen.storniertAm),
    ))
    .orderBy(asc(sammelrechnungen.nummer))
  return Promise.all(ids.map(r => holeSammelrechnung(db, r.id, mandantId)))
}

export async function markiereBuchhaltungGedruckt(db: Db, mandantId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .update(sammelrechnungen)
    .set({ buchhaltungGedrucktAm: new Date() })
    .where(and(
      eq(sammelrechnungen.mandantId, mandantId),
      inArray(sammelrechnungen.id, ids),
      isNotNull(sammelrechnungen.freigegebenAm),
      isNull(sammelrechnungen.buchhaltungGedrucktAm),
    ))
    .returning({ id: sammelrechnungen.id })
  return rows.length
}
