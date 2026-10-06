/**
 * Wirksames Bonier-Routing der Warengruppen (KDS-Station + Standard-Bonierdrucker).
 *
 * Eine Untergruppe ohne eigene Angabe erbt Station und Bonierdrucker von ihrer
 * Elterngruppe — wer an der Hauptgruppe (z. B. "Kellner Getränke") die Station
 * setzt, meint damit auch alle Untergruppen. Gelesen wird dafür der ganze
 * Warengruppen-Baum des Mandanten (wenige Zeilen), nicht nur die Gruppe des Artikels.
 */

import { eq } from 'drizzle-orm'
import { wirksamesKategorieRouting, type KategorieRouting } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kategorien } from '../db/schema.js'

/** Db oder eine Transaktion davon (beide können select). */
type LeseDb = Pick<Db, 'select'>

export async function ladeWirksamesRouting(db: LeseDb, mandantId: string): Promise<Map<string, KategorieRouting>> {
  const rows = await db
    .select({
      id:              kategorien.id,
      parentId:        kategorien.parentId,
      station:         kategorien.station,
      bonierdruckerId: kategorien.bonierdruckerId,
    })
    .from(kategorien)
    .where(eq(kategorien.mandantId, mandantId))
  return wirksamesKategorieRouting(rows)
}
