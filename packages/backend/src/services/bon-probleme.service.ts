/**
 * Bon-Probleme: Meldungen zu Bons, die der SERVER selbst ausgelöst hat.
 *
 * Drei Wege boniert der Server, ohne dass an der Kasse jemand auf die Antwort wartet:
 *   - Direktverkauf-Beleg mit Küchenartikeln (`bonierBeiDirektverkauf`, fire-and-forget NACH dem Beleg),
 *   - Gast-Bestellung (der Gast hat per Karte bezahlt, danach wird boniert),
 *   - SB-Terminal (dasselbe Muster).
 * Das Bonierergebnis wurde dort bisher verworfen: ein toter Küchendrucker blieb völlig stumm, ebenso ein Bon am
 * Backup-Drucker — und bezahlt war längst.
 *
 * Statt eines flüchtigen SSE-Ereignisses (keine Kasse offen = Meldung weg) hält der Server eine kleine Liste
 * offener Meldungen je Kasse (Tabelle `bon_probleme`), wie die Druckprobleme der Belege: Die Kasse zeigt sie als
 * Banner beim Öffnen; ein SSE-Ereignis stößt nur das Neuladen an. Rot (Bon NICHT angekommen) mit „Nochmal senden“,
 * bernsteinfarben (Bon liegt am Backup-Drucker) mit „Verstanden“.
 *
 * Nur Anzeige: am Druckverhalten ändert sich nichts. „Nochmal senden“ geht mit der Bestell-ID des ersten Versuchs
 * durch — Ziele, die den Bon schon haben, bekommen ihn nicht noch einmal (siehe bonier-bestellung.service).
 */

import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import {
  BonierungInputSchema,
  bonProblemTitel,
  bonStand,
  type BonierUmleitung,
  type BonierZielFehler,
  type BonProblem,
  type BonProblemQuelle,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { bonProbleme } from '../db/schema.js'
import { emitKasseEvent } from '../sse/event-bus.js'
import { bonierBestellung, BonierError, type BonierBestellung } from './bonier.service.js'

export class BonProblemError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

/** Alte Meldungen werden beim Anlegen einer neuen aufgeräumt. */
const AUFBEWAHRUNG_MS = 14 * 24 * 60 * 60_000
/** Länger als einen Tag zurückliegende Meldungen erscheinen nicht mehr (wie bei den Druckproblemen). */
const SICHTBAR_STUNDEN = 24

type Row = typeof bonProbleme.$inferSelect
type Logger = { error: (obj: unknown, msg?: string) => void }

function zuDto(row: Row): BonProblem {
  const quelle = row.quelle as BonProblemQuelle
  return {
    id:          row.id,
    quelle,
    tisch:       row.tisch,
    titel:       bonProblemTitel(quelle, row.tisch),
    fehler:      row.fehler as BonierZielFehler[],
    umleitungen: row.umleitungen as BonierUmleitung[],
    erstelltAt:  row.createdAt.toISOString(),
  }
}

const melde = (mandantId: string, kasseId: string) => emitKasseEvent(mandantId, { typ: 'bon_probleme', kasseId })

export interface BonQuelle {
  quelle:    BonProblemQuelle
  mandantId: string
  /** SB-Option der Bonierung (Browser-KDS-Badge) — wird für „Nochmal senden“ mit abgelegt */
  sb?:       { bestellungId: string; bestellNummer: string }
}

/**
 * Boniert eine Bestellung, die der Server selbst ausgelöst hat, und merkt sich, wenn das Personal etwas wissen muss.
 * Wirft NIE: Die Bestellung und der Beleg existieren bereits, eine Bonier-Panne darf sie nicht zurückrollen (so
 * verhielten sich die Aufrufer schon vorher).
 *
 * Keine Meldung, wenn der Bon überall am vorgesehenen Gerät ankam — und auch nicht, wenn es nichts zu bonieren
 * gab (400: kein Artikel mit Station oder Drucker; das ist Einrichtung, kein Ausfall).
 */
export async function bonierUndMelde(
  db:      Db,
  eingabe: BonierBestellung,
  quelle:  BonQuelle,
  logger:  Logger = { error: (obj, msg) => console.error(msg ?? 'Bonierung fehlgeschlagen', obj) },
): Promise<void> {
  // Die ID macht „Nochmal senden“ idempotent: ein Ziel, das den Bon schon hat, bekommt ihn nicht noch einmal
  const bestellId = eingabe.bestellId ?? randomUUID()
  const mitId: BonierBestellung = { ...eingabe, bestellId }

  let fehler:      BonierZielFehler[] = []
  let umleitungen: BonierUmleitung[]  = []
  try {
    const ergebnis = await bonierBestellung(mitId, { db }, quelle.sb ? { sb: quelle.sb } : {})
    const stand = bonStand(ergebnis)
    if (!stand) return
    ;({ fehler, umleitungen } = stand)
  } catch (err) {
    if (err instanceof BonierError && err.httpStatus === 400) {
      logger.error({ err }, 'Bonierung ohne Ziel (nichts zu bonieren)')
      return
    }
    // Der Bon ging nirgends hin (Artikel nicht mehr verfügbar, Datenbankfehler …): das Personal muss es erfahren
    logger.error({ err }, 'Bonierung fehlgeschlagen')
    fehler = [{
      ziel:      'Bonierung',
      ip:        '',
      fehler:    err instanceof Error ? err.message : String(err),
      istBackup: false,
    }]
  }

  try {
    await db.delete(bonProbleme).where(lt(bonProbleme.createdAt, new Date(Date.now() - AUFBEWAHRUNG_MS)))
    await db.insert(bonProbleme).values({
      mandantId:   quelle.mandantId,
      kasseId:     mitId.kasseId,
      quelle:      quelle.quelle,
      tisch:       (mitId.tisch ?? '').trim() || 'Direkt',
      bestellId,
      eingabe:     mitId,
      sb:          quelle.sb ?? null,
      fehler,
      umleitungen,
    }).onConflictDoNothing()
    melde(quelle.mandantId, mitId.kasseId)
  } catch (err) {
    logger.error({ err }, 'Bon-Problem konnte nicht gemerkt werden')
  }
}

/** Offene Meldungen einer Kasse, jüngste zuerst. Mandant UND Kasse filtern — die Kasse allein reichte nicht. */
export async function holeOffeneBonProbleme(db: Db, mandantId: string, kasseId: string): Promise<BonProblem[]> {
  const rows = await db
    .select()
    .from(bonProbleme)
    .where(and(
      eq(bonProbleme.mandantId, mandantId),
      eq(bonProbleme.kasseId, kasseId),
      isNull(bonProbleme.erledigtAt),
      gt(bonProbleme.createdAt, sql`now() - make_interval(hours => ${SICHTBAR_STUNDEN})`),
    ))
    .orderBy(desc(bonProbleme.createdAt))
    .limit(20)
  return rows.map(zuDto)
}

async function lade(db: Db, id: string, mandantId: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(bonProbleme)
    .where(and(eq(bonProbleme.id, id), eq(bonProbleme.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new BonProblemError(404, 'Meldung nicht gefunden')
  return row
}

/** „Verstanden“: die Meldung verschwindet. Wiederholbar (zweiter Aufruf ändert nichts). */
export async function bestaetigeBonProblem(db: Db, id: string, mandantId: string): Promise<void> {
  const row = await lade(db, id, mandantId)
  if (row.erledigtAt) return
  await db.update(bonProbleme).set({ erledigtAt: new Date(), updatedAt: new Date() }).where(eq(bonProbleme.id, id))
  melde(mandantId, row.kasseId)
}

/**
 * „Nochmal senden“: dieselbe Bonierung mit derselben Bestell-ID — nur Ziele, die den Bon nicht haben, werden bedient.
 * Danach gilt der neue Stand: alles am vorgesehenen Gerät → die Meldung ist erledigt (`null`); nur noch eine Umleitung
 * → aus Rot wird der bernsteinfarbene Hinweis; sonst bleibt sie mit den verbliebenen Zielen offen.
 */
export async function sendeBonProblemNochmal(db: Db, id: string, mandantId: string): Promise<BonProblem | null> {
  const row = await lade(db, id, mandantId)
  if (row.erledigtAt) return null

  const eingabe = BonierungInputSchema.safeParse(row.eingabe)
  if (!eingabe.success) throw new BonProblemError(422, 'Die gespeicherte Bestellung ist nicht lesbar')
  const { ohneLagerabzug: _o, storno: _s, ...bestellung } = eingabe.data

  const ergebnis = await bonierBestellung(bestellung, { db }, row.sb ? { sb: row.sb as NonNullable<BonQuelle['sb']> } : {})
  const stand = bonStand(ergebnis)

  const [neu] = await db
    .update(bonProbleme)
    .set({
      fehler:      stand?.fehler ?? [],
      umleitungen: stand?.umleitungen ?? [],
      erledigtAt:  stand ? null : new Date(),
      updatedAt:   new Date(),
    })
    .where(eq(bonProbleme.id, id))
    .returning()
  melde(mandantId, row.kasseId)
  return stand && neu ? zuDto(neu) : null
}
