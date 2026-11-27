/**
 * Verwaltung der Betriebe und Boxen sowie die Flottenübersicht.
 */

import { asc, desc, eq } from 'drizzle-orm'
import {
  PortalMeldungSchema,
  type BetriebAktualisieren, type BetriebAnlegen, type BetriebUebersicht, type BoxAktualisieren, type BoxDetail,
  type BoxKurz, type BoxMitToken, type Uebersicht,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { portalBetriebe, portalBoxen, portalFehler } from '../db/schema.js'
import { PortalFehler } from '../fehler.js'
import { erzeugeBoxToken } from '../auth/box-token.js'
import { bewerteBox, schlechtesterStatus } from './bewertung.js'

export interface Zeitrahmen {
  jetzt:               Date
  offlineNachSekunden: number
}

type BoxZeile = typeof portalBoxen.$inferSelect

/** Die gespeicherte Meldung ist beim Empfang geprüft worden; ändert sich das Schema später, wird sie hier nicht zum Absturz. */
function leseMeldung(zeile: BoxZeile) {
  if (zeile.meldung === null) return null
  const r = PortalMeldungSchema.safeParse(zeile.meldung)
  return r.success ? r.data : null
}

function boxKurz(zeile: BoxZeile, z: Zeitrahmen): BoxKurz {
  const bewertung = bewerteBox({
    meldung: leseMeldung(zeile), zuletztGesehen: zeile.zuletztGesehen, jetzt: z.jetzt, offlineNachSekunden: z.offlineNachSekunden,
  })
  return {
    id:             zeile.id,
    name:           zeile.name,
    aktiv:          zeile.aktiv,
    status:         bewertung.status,
    gruende:        bewertung.gruende,
    zuletztGesehen: zeile.zuletztGesehen ? zeile.zuletztGesehen.toISOString() : null,
    version:        zeile.version,
  }
}

function pruefeUnique(err: unknown, meldung: string): never {
  // Postgres-Fehlercode 23505 = Verletzung einer Eindeutigkeit (postgres.js: Code steht an err bzw. err.cause)
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code
  if (code === '23505') throw new PortalFehler(409, meldung)
  throw err
}

// ---- Übersicht --------------------------------------------------------------

export async function holeUebersicht(db: Db, z: Zeitrahmen): Promise<Uebersicht> {
  const betriebe = await db.select().from(portalBetriebe).orderBy(asc(portalBetriebe.name))
  const boxen = await db.select().from(portalBoxen).orderBy(asc(portalBoxen.name))

  const zusammenfassung = { boxen: 0, ok: 0, warnung: 0, kritisch: 0, offline: 0, neu: 0 }
  const ergebnis: BetriebUebersicht[] = betriebe.map((b) => {
    const kurz = boxen.filter(x => x.betriebId === b.id).map(x => boxKurz(x, z))
    const aktive = kurz.filter(x => x.aktiv)
    if (b.aktiv) {
      for (const x of aktive) { zusammenfassung.boxen += 1; zusammenfassung[x.status] += 1 }
    }
    return {
      id: b.id, name: b.name, notiz: b.notiz, aktiv: b.aktiv,
      module: b.module as BetriebUebersicht['module'],
      status: schlechtesterStatus(aktive.map(x => x.status)),
      boxen:  kurz,
    }
  })
  return { betriebe: ergebnis, zusammenfassung }
}

export async function holeBoxDetail(db: Db, boxId: string, z: Zeitrahmen): Promise<BoxDetail> {
  const [zeile] = await db
    .select({ box: portalBoxen, betriebName: portalBetriebe.name })
    .from(portalBoxen)
    .innerJoin(portalBetriebe, eq(portalBetriebe.id, portalBoxen.betriebId))
    .where(eq(portalBoxen.id, boxId))
    .limit(1)
  if (!zeile) throw new PortalFehler(404, 'Box nicht gefunden.')

  const fehler = await db.select().from(portalFehler)
    .where(eq(portalFehler.boxId, boxId)).orderBy(desc(portalFehler.letzterAm)).limit(100)

  return {
    box:          boxKurz(zeile.box, z),
    betriebId:    zeile.box.betriebId,
    betriebName:  zeile.betriebName,
    tokenHinweis: zeile.box.tokenHinweis,
    meldung:      leseMeldung(zeile.box),
    fehler: fehler.map(f => ({
      hash: f.hash, name: f.name, meldung: f.meldung, route: f.route, anzahl: f.anzahl,
      ersterAm: f.ersterAm.toISOString(), letzterAm: f.letzterAm.toISOString(),
    })),
  }
}

// ---- Betriebe -----------------------------------------------------------------

export async function legeBetriebAn(db: Db, eingabe: BetriebAnlegen): Promise<{ id: string }> {
  try {
    const [neu] = await db.insert(portalBetriebe)
      .values({ name: eingabe.name, notiz: eingabe.notiz ?? null })
      .returning({ id: portalBetriebe.id })
    return neu!
  } catch (err) { return pruefeUnique(err, 'Es gibt schon einen Betrieb mit diesem Namen.') }
}

export async function aktualisiereBetrieb(db: Db, id: string, eingabe: BetriebAktualisieren, jetzt: Date = new Date()): Promise<void> {
  const aenderungen: Partial<typeof portalBetriebe.$inferInsert> = { updatedAt: jetzt }
  if (eingabe.name !== undefined)   aenderungen.name = eingabe.name
  if (eingabe.notiz !== undefined)  aenderungen.notiz = eingabe.notiz
  if (eingabe.aktiv !== undefined)  aenderungen.aktiv = eingabe.aktiv
  // Module ohne Doppelte, in fester Reihenfolge der Auswahlliste
  if (eingabe.module !== undefined) aenderungen.module = [...new Set(eingabe.module)]

  try {
    const geaendert = await db.update(portalBetriebe).set(aenderungen).where(eq(portalBetriebe.id, id)).returning({ id: portalBetriebe.id })
    if (geaendert.length === 0) throw new PortalFehler(404, 'Betrieb nicht gefunden.')
  } catch (err) { pruefeUnique(err, 'Es gibt schon einen Betrieb mit diesem Namen.') }
}

// ---- Boxen --------------------------------------------------------------------

export async function legeBoxAn(db: Db, betriebId: string, name: string, z: Zeitrahmen): Promise<BoxMitToken> {
  const [betrieb] = await db.select({ id: portalBetriebe.id }).from(portalBetriebe).where(eq(portalBetriebe.id, betriebId)).limit(1)
  if (!betrieb) throw new PortalFehler(404, 'Betrieb nicht gefunden.')

  const t = erzeugeBoxToken()
  const [zeile] = await db.insert(portalBoxen)
    .values({ betriebId, name, tokenHash: t.hash, tokenHinweis: t.hinweis })
    .returning()
  return { box: boxKurz(zeile!, z), token: t.token }
}

/** Neues Token: das alte gilt sofort nicht mehr (die Box meldet sich erst wieder, wenn das neue eingetragen ist). */
export async function erneuereBoxToken(db: Db, boxId: string, z: Zeitrahmen): Promise<BoxMitToken> {
  const t = erzeugeBoxToken()
  const [zeile] = await db.update(portalBoxen)
    .set({ tokenHash: t.hash, tokenHinweis: t.hinweis, tokenErneuertAm: z.jetzt, updatedAt: z.jetzt })
    .where(eq(portalBoxen.id, boxId)).returning()
  if (!zeile) throw new PortalFehler(404, 'Box nicht gefunden.')
  return { box: boxKurz(zeile, z), token: t.token }
}

export async function aktualisiereBox(db: Db, boxId: string, eingabe: BoxAktualisieren, jetzt: Date = new Date()): Promise<void> {
  const aenderungen: Partial<typeof portalBoxen.$inferInsert> = { updatedAt: jetzt }
  if (eingabe.name !== undefined)  aenderungen.name = eingabe.name
  if (eingabe.aktiv !== undefined) aenderungen.aktiv = eingabe.aktiv
  const geaendert = await db.update(portalBoxen).set(aenderungen).where(eq(portalBoxen.id, boxId)).returning({ id: portalBoxen.id })
  if (geaendert.length === 0) throw new PortalFehler(404, 'Box nicht gefunden.')
}
