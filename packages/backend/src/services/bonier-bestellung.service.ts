/**
 * Bonierung je Bestell-ID (Idempotenz).
 *
 * "Nochmal senden" schickt dieselbe Bestellung mit derselben Bestell-ID noch einmal.
 * Hier wird pro ID festgehalten, was schon zugestellt ist, damit der zweite Aufruf
 *   - keinen zweiten KDS-Bon anlegt,
 *   - den Lagerstand nicht ein zweites Mal abbucht,
 *   - nur an die Ziele sendet, die vorher gescheitert sind.
 *
 * Der erste Aufruf "beansprucht" die ID (INSERT ... ON CONFLICT DO NOTHING) — das
 * schließt auch einen zeitgleichen Doppelklick aus: der zweite Aufruf sieht "läuft".
 */

import { and, eq, isNull, lt } from 'drizzle-orm'
import { BonierungErgebnisSchema, type BonierungErgebnis } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { bonierBestellungen } from '../db/schema.js'

/** Eine Bonierung, die so lange "läuft", gilt als abgestürzt und darf übernommen werden. */
const LAEUFT_MAX_MS = 2 * 60_000
/** Alte Einträge werden beim Beanspruchen aufgeräumt. */
const AUFBEWAHRUNG_MS = 14 * 24 * 60 * 60_000

export type Anspruch =
  | { art: 'neu';          bonNummer: string }
  | { art: 'wiederholung'; bonNummer: string; vorher: BonierungErgebnis }
  | { art: 'laeuft' }
  | { art: 'fremd' }

export async function beanspruche(
  db: Db,
  p: { bestellId: string; mandantId: string; kasseId: string; bonNummer: string },
): Promise<Anspruch> {
  await db.delete(bonierBestellungen).where(lt(bonierBestellungen.createdAt, new Date(Date.now() - AUFBEWAHRUNG_MS)))

  for (let versuch = 0; versuch < 3; versuch++) {
    const eingefuegt = await db
      .insert(bonierBestellungen)
      .values({ bestellId: p.bestellId, mandantId: p.mandantId, kasseId: p.kasseId, bonNummer: p.bonNummer })
      .onConflictDoNothing()
      .returning({ id: bonierBestellungen.bestellId })
    if (eingefuegt.length > 0) return { art: 'neu', bonNummer: p.bonNummer }

    const [row] = await db.select().from(bonierBestellungen).where(eq(bonierBestellungen.bestellId, p.bestellId)).limit(1)
    if (!row) continue                       // zwischendurch gelöscht → noch einmal versuchen
    if (row.mandantId !== p.mandantId || row.kasseId !== p.kasseId) return { art: 'fremd' }

    if (row.ergebnis === null || row.ergebnis === undefined) {
      if (Date.now() - row.updatedAt.getTime() <= LAEUFT_MAX_MS) return { art: 'laeuft' }
      // Abgestürzt: übernehmen — nur einer von mehreren gleichzeitigen Aufrufern gewinnt
      const uebernommen = await db
        .update(bonierBestellungen)
        .set({ updatedAt: new Date() })
        .where(and(
          eq(bonierBestellungen.bestellId, p.bestellId),
          isNull(bonierBestellungen.ergebnis),
          eq(bonierBestellungen.updatedAt, row.updatedAt),
        ))
        .returning({ id: bonierBestellungen.bestellId })
      return uebernommen.length > 0 ? { art: 'neu', bonNummer: row.bonNummer } : { art: 'laeuft' }
    }

    const vorher = BonierungErgebnisSchema.safeParse(row.ergebnis)
    // Unlesbarer Stand (sollte nie vorkommen): wie eine neue Bestellung behandeln
    if (!vorher.success) return { art: 'neu', bonNummer: row.bonNummer }
    return { art: 'wiederholung', bonNummer: row.bonNummer, vorher: vorher.data }
  }
  return { art: 'laeuft' }
}

/** Ergebnis je Ziel festhalten (nach dem ersten Versuch und nach jedem erneuten Senden). */
export async function speichereErgebnis(db: Db, bestellId: string, ergebnis: BonierungErgebnis): Promise<void> {
  await db
    .update(bonierBestellungen)
    .set({ ergebnis, updatedAt: new Date() })
    .where(eq(bonierBestellungen.bestellId, bestellId))
}

/** Erste Bonierung gescheitert (z. B. "nichts zu bonieren"): Anspruch freigeben, damit ein neuer Versuch frisch startet. */
export async function gibFrei(db: Db, bestellId: string): Promise<void> {
  await db
    .delete(bonierBestellungen)
    .where(and(eq(bonierBestellungen.bestellId, bestellId), isNull(bonierBestellungen.ergebnis)))
}
