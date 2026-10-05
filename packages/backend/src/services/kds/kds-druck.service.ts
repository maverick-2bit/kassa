/**
 * Papierdruck der KDS-Bons (Erledigt-Bon, Teilbon, Nachdrucken): welcher Bonierdrucker druckt?
 *
 * Mit Zuordnung (kds_station_drucker) druckt NUR der gewählte Drucker für diese Station —
 * ohne Zuordnung wie früher alle aktiven Nicht-Backup-Bonierdrucker. Ist der zugeordnete
 * Drucker deaktiviert, wird nirgends gedruckt (kein Ausweichen auf andere Geräte; die
 * Oberfläche weist darauf hin).
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bonierFallbackDrucker, bonierdrucker, kdsStationDrucker } from '../../db/schema.js'

export type KdsDruckerRow = typeof bonierdrucker.$inferSelect

/**
 * Fester Fallback-Drucker des Mandanten (nur wenn aktiv) — außer den Druckern in `ausser`,
 * die gerade selbst gescheitert sind bzw. schon versucht wurden.
 */
export async function ladeFallbackDrucker(db: Db, mandantId: string, ausser: string[] = []): Promise<KdsDruckerRow | null> {
  const [zeile] = await db
    .select({ drucker: bonierdrucker })
    .from(bonierFallbackDrucker)
    .innerJoin(bonierdrucker, eq(bonierdrucker.id, bonierFallbackDrucker.bonierdruckerId))
    .where(and(eq(bonierFallbackDrucker.mandantId, mandantId), eq(bonierdrucker.aktiv, true)))
    .limit(1)
  if (!zeile || ausser.includes(zeile.drucker.id)) return null
  return zeile.drucker
}

export async function ladeKdsDrucker(db: Db, mandantId: string, station?: string | null): Promise<KdsDruckerRow[]> {
  if (station) {
    const [zuordnung] = await db
      .select()
      .from(kdsStationDrucker)
      .where(and(eq(kdsStationDrucker.mandantId, mandantId), eq(kdsStationDrucker.station, station)))
      .limit(1)
    if (zuordnung) {
      const [drucker] = await db
        .select()
        .from(bonierdrucker)
        .where(and(
          eq(bonierdrucker.id, zuordnung.bonierdruckerId),
          eq(bonierdrucker.mandantId, mandantId),
          eq(bonierdrucker.aktiv, true),
        ))
        .limit(1)
      return drucker ? [drucker] : []
    }
  }
  return db
    .select()
    .from(bonierdrucker)
    .where(and(
      eq(bonierdrucker.mandantId, mandantId),
      eq(bonierdrucker.aktiv, true),
      eq(bonierdrucker.istBackup, false),
    ))
}
