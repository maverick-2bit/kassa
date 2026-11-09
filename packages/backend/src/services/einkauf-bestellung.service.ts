/**
 * Einkaufsbestellungen — Bestellung beim Lieferanten.
 *
 * Mandantentrennung: jede Abfrage und jede Änderung läuft über `mandantId`; Lieferant und Artikel einer
 * Position müssen zum selben Mandanten gehören (vor dem Schreiben geprüft).
 * Bearbeiten (Positionen/Termin/Bemerkung) ist nur im Entwurf möglich; danach nur Statuswechsel.
 */

import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm'
import {
  EINKAUF_BESTELLSTATUS_UEBERGAENGE,
  summeBestellung,
  type EinkaufBestellstatus,
  type EinkaufBestellung,
  type EinkaufBestellungInput,
  type EinkaufBestellungKurz,
  type EinkaufBestellungUpdate,
  type EinkaufBestellpositionInput,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, einkaufBestellpositionen, einkaufBestellungen, lieferanten } from '../db/schema.js'

export class EinkaufError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

type DbOrTx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db

type PositionsRow = typeof einkaufBestellpositionen.$inferSelect
type KopfRow = typeof einkaufBestellungen.$inferSelect

// ---------------------------------------------------------------------------
// DTO-Mapping
// ---------------------------------------------------------------------------

function positionDto(p: PositionsRow) {
  return {
    id:                       p.id,
    position:                 p.position,
    artikelId:                p.artikelId,
    bezeichnung:              p.bezeichnung,
    lieferantenArtikelnummer: p.lieferantenArtikelnummer,
    menge:                    p.menge,
    einkaufspreisCent:        p.einkaufspreisCent,
    gelieferteMenge:          p.gelieferteMenge,
  }
}

function kopfDto(k: KopfRow, lieferantName: string, positionen: PositionsRow[]) {
  const summe = summeBestellung(positionen)
  return {
    id:            k.id,
    mandantId:     k.mandantId,
    nummer:        k.nummer,
    lieferantId:   k.lieferantId,
    lieferantName,
    status:        k.status as EinkaufBestellstatus,
    bemerkung:     k.bemerkung,
    liefertermin:  k.liefertermin,
    gesendetAm:    k.gesendetAm ? k.gesendetAm.toISOString() : null,
    gesendetAn:    k.gesendetAn,
    summeNettoCent: summe.summeNettoCent,
    summeUnvollstaendig: summe.summeUnvollstaendig,
    createdAt:     k.createdAt.toISOString(),
    updatedAt:     k.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

export async function listeBestellungen(
  db: Db, mandantId: string, filter: { status?: EinkaufBestellstatus | undefined; lieferantId?: string | undefined } = {},
): Promise<EinkaufBestellungKurz[]> {
  const bedingungen = [eq(einkaufBestellungen.mandantId, mandantId)]
  if (filter.status)      bedingungen.push(eq(einkaufBestellungen.status, filter.status))
  if (filter.lieferantId) bedingungen.push(eq(einkaufBestellungen.lieferantId, filter.lieferantId))

  const koepfe = await db
    .select({ kopf: einkaufBestellungen, lieferantName: lieferanten.name })
    .from(einkaufBestellungen)
    .innerJoin(lieferanten, eq(lieferanten.id, einkaufBestellungen.lieferantId))
    .where(and(...bedingungen))
    .orderBy(desc(einkaufBestellungen.createdAt), desc(einkaufBestellungen.nummer))
  if (koepfe.length === 0) return []

  const positionen = await db.select().from(einkaufBestellpositionen)
    .where(inArray(einkaufBestellpositionen.bestellungId, koepfe.map(k => k.kopf.id)))
  const jeBestellung = new Map<string, PositionsRow[]>()
  for (const p of positionen) {
    const liste = jeBestellung.get(p.bestellungId) ?? []
    liste.push(p)
    jeBestellung.set(p.bestellungId, liste)
  }
  return koepfe.map(({ kopf, lieferantName }) => {
    const pos = jeBestellung.get(kopf.id) ?? []
    return { ...kopfDto(kopf, lieferantName, pos), anzahlPositionen: pos.length }
  })
}

export async function holeBestellung(db: DbOrTx, id: string, mandantId: string): Promise<EinkaufBestellung | null> {
  const [zeile] = await db
    .select({ kopf: einkaufBestellungen, lieferantName: lieferanten.name })
    .from(einkaufBestellungen)
    .innerJoin(lieferanten, eq(lieferanten.id, einkaufBestellungen.lieferantId))
    .where(and(eq(einkaufBestellungen.id, id), eq(einkaufBestellungen.mandantId, mandantId)))
    .limit(1)
  if (!zeile) return null
  const positionen = await db.select().from(einkaufBestellpositionen)
    .where(eq(einkaufBestellpositionen.bestellungId, id))
    .orderBy(asc(einkaufBestellpositionen.position))
  return { ...kopfDto(zeile.kopf, zeile.lieferantName, positionen), positionen: positionen.map(positionDto) }
}

// ---------------------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------------------

/** Jahr in Wiener Zeit (Mitternachtsgrenze zu Silvester/Neujahr). */
function wienerJahr(jetzt = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric' }).format(jetzt))
}

/** Nächste freie Nummer „B<Jahr><lfd. 3-stellig>" für den Mandanten. */
async function naechsteNummer(db: DbOrTx, mandantId: string, jahr: number): Promise<string> {
  const prefix = `B${jahr}`
  const [zeile] = await db
    .select({ max: sql<string | null>`max(${einkaufBestellungen.nummer})` })
    .from(einkaufBestellungen)
    .where(and(eq(einkaufBestellungen.mandantId, mandantId), like(einkaufBestellungen.nummer, `${prefix}%`)))
  const letzte = zeile?.max ? Number(zeile.max.slice(prefix.length)) : 0
  const naechste = (Number.isFinite(letzte) ? letzte : 0) + 1
  return `${prefix}${String(naechste).padStart(3, '0')}`
}

async function pruefeLieferant(db: DbOrTx, mandantId: string, lieferantId: string): Promise<void> {
  const [l] = await db.select({ id: lieferanten.id, aktiv: lieferanten.aktiv }).from(lieferanten)
    .where(and(eq(lieferanten.id, lieferantId), eq(lieferanten.mandantId, mandantId))).limit(1)
  if (!l) throw new EinkaufError(404, 'Lieferant nicht gefunden')
  if (!l.aktiv) throw new EinkaufError(409, 'Der Lieferant ist deaktiviert')
}

async function pruefeArtikel(db: DbOrTx, mandantId: string, positionen: EinkaufBestellpositionInput[]): Promise<void> {
  const ids = [...new Set(positionen.map(p => p.artikelId).filter((x): x is string => !!x))]
  if (ids.length === 0) return
  const gefunden = await db.select({ id: artikel.id }).from(artikel)
    .where(and(eq(artikel.mandantId, mandantId), inArray(artikel.id, ids)))
  if (gefunden.length !== ids.length) throw new EinkaufError(404, 'Ein Artikel der Bestellung wurde nicht gefunden')
}

function positionsWerte(bestellungId: string, positionen: EinkaufBestellpositionInput[]) {
  return positionen.map((p, i) => ({
    bestellungId,
    position:                 i + 1,
    artikelId:                p.artikelId ?? null,
    bezeichnung:              p.bezeichnung,
    lieferantenArtikelnummer: p.lieferantenArtikelnummer ?? null,
    menge:                    p.menge,
    einkaufspreisCent:        p.einkaufspreisCent ?? null,
  }))
}

const istNummerKollision = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (
    (err as { code?: string }).code === '23505' ||
    (err as { cause?: { code?: string } }).cause?.code === '23505'
  )

export async function erstelleBestellung(db: Db, mandantId: string, input: EinkaufBestellungInput): Promise<EinkaufBestellung> {
  await pruefeLieferant(db, mandantId, input.lieferantId)
  await pruefeArtikel(db, mandantId, input.positionen)

  // Nummer vergeben; bei gleichzeitigem Anlegen fängt der Unique-Index die Kollision ab → neu versuchen
  for (let versuch = 0; versuch < 5; versuch++) {
    try {
      const id = await db.transaction(async (tx) => {
        const nummer = await naechsteNummer(tx, mandantId, wienerJahr())
        const [kopf] = await tx.insert(einkaufBestellungen).values({
          mandantId,
          nummer,
          lieferantId:  input.lieferantId,
          bemerkung:    input.bemerkung ?? null,
          liefertermin: input.liefertermin ?? null,
        }).returning({ id: einkaufBestellungen.id })
        await tx.insert(einkaufBestellpositionen).values(positionsWerte(kopf!.id, input.positionen))
        return kopf!.id
      })
      const neu = await holeBestellung(db, id, mandantId)
      return neu!
    } catch (err) {
      if (!istNummerKollision(err) || versuch === 4) throw err
    }
  }
  throw new EinkaufError(500, 'Bestellnummer konnte nicht vergeben werden')
}

// ---------------------------------------------------------------------------
// Ändern
// ---------------------------------------------------------------------------

async function ladeKopf(db: DbOrTx, id: string, mandantId: string): Promise<KopfRow> {
  const [k] = await db.select().from(einkaufBestellungen)
    .where(and(eq(einkaufBestellungen.id, id), eq(einkaufBestellungen.mandantId, mandantId))).limit(1)
  if (!k) throw new EinkaufError(404, 'Bestellung nicht gefunden')
  return k
}

export async function aktualisiereBestellung(
  db: Db, id: string, mandantId: string, update: EinkaufBestellungUpdate,
): Promise<EinkaufBestellung> {
  if (update.positionen) await pruefeArtikel(db, mandantId, update.positionen)
  await db.transaction(async (tx) => {
    const kopf = await ladeKopf(tx, id, mandantId)
    if (kopf.status !== 'entwurf') throw new EinkaufError(409, 'Nur ein Entwurf kann bearbeitet werden')
    const werte: Partial<typeof einkaufBestellungen.$inferInsert> = { updatedAt: new Date() }
    if (update.bemerkung   !== undefined) werte.bemerkung    = update.bemerkung
    if (update.liefertermin !== undefined) werte.liefertermin = update.liefertermin
    await tx.update(einkaufBestellungen).set(werte).where(eq(einkaufBestellungen.id, id))
    if (update.positionen) {
      await tx.delete(einkaufBestellpositionen).where(eq(einkaufBestellpositionen.bestellungId, id))
      await tx.insert(einkaufBestellpositionen).values(positionsWerte(id, update.positionen))
    }
  })
  return (await holeBestellung(db, id, mandantId))!
}

export async function loescheEntwurf(db: Db, id: string, mandantId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const kopf = await ladeKopf(tx, id, mandantId)
    if (kopf.status !== 'entwurf') throw new EinkaufError(409, 'Nur ein Entwurf kann gelöscht werden — sonst bitte stornieren')
    await tx.delete(einkaufBestellungen).where(eq(einkaufBestellungen.id, id))
  })
}

/**
 * Statuswechsel nach EINKAUF_BESTELLSTATUS_UEBERGAENGE. `gesendetAn` hält fest, wohin die Bestellung ging
 * (E-Mail-Adresse oder Freitext wie „telefonisch"); beim Versand per Mail wiederholbar (Status bleibt gesendet).
 */
export async function wechsleStatus(
  db: Db, id: string, mandantId: string, neu: EinkaufBestellstatus, gesendetAn?: string,
): Promise<EinkaufBestellung> {
  await db.transaction(async (tx) => {
    const kopf = await ladeKopf(tx, id, mandantId)
    const alt = kopf.status as EinkaufBestellstatus
    const erneutSenden = neu === 'gesendet' && alt === 'gesendet'
    if (!erneutSenden && !EINKAUF_BESTELLSTATUS_UEBERGAENGE[alt].includes(neu)) {
      throw new EinkaufError(409, `Statuswechsel von „${alt}" zu „${neu}" ist nicht möglich`)
    }
    const werte: Partial<typeof einkaufBestellungen.$inferInsert> = { status: neu, updatedAt: new Date() }
    if (neu === 'gesendet') {
      werte.gesendetAm = new Date()
      werte.gesendetAn = gesendetAn ?? null
    }
    await tx.update(einkaufBestellungen).set(werte).where(eq(einkaufBestellungen.id, id))
  })
  return (await holeBestellung(db, id, mandantId))!
}
