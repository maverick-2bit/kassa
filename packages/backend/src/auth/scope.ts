/**
 * Hilfsfunktionen für Mandant-Scoping.
 * Stellt sicher, dass ein User nur auf Kassen/Belege seines eigenen Mandanten zugreifen kann.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { belege, kassen } from '../db/schema.js'

export async function pruefeKasseGehoertZuMandant(
  db:        Db,
  kasseId:   string,
  mandantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: kassen.id })
    .from(kassen)
    .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  return !!row
}

export async function pruefeBelegGehoertZuMandant(
  db:        Db,
  belegId:   string,
  mandantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: belege.id })
    .from(belege)
    .where(and(eq(belege.id, belegId), eq(belege.mandantId, mandantId)))
    .limit(1)
  return !!row
}
