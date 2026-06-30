/**
 * Monitoring-Service: ermittelt die Frische der vom Backend erstellten
 * Sicherungen (DB-Dump + DEP-Archiv) für Health-/Monitoring-Endpoints.
 */

import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { dbSicherungen, depSicherungen } from '../db/schema.js'

export type BackupZustand = 'ok' | 'veraltet' | 'fehlt'

export interface BackupStatus {
  letzteSicherung: string | null   // ISO-Zeitstempel oder null
  alterStunden:    number | null
  zustand:         BackupZustand
}

export interface MonitoringBackupStatus {
  dbBackup:  BackupStatus
  depBackup: BackupStatus
  /** true, wenn keine Sicherung "veraltet" ist (fehlende zählen nicht als kritisch). */
  gesund:    boolean
}

function bewerte(letzte: Date | null, maxStunden: number): BackupStatus {
  if (!letzte) return { letzteSicherung: null, alterStunden: null, zustand: 'fehlt' }
  const alterStunden = (Date.now() - letzte.getTime()) / 3_600_000
  return {
    letzteSicherung: letzte.toISOString(),
    alterStunden:    Math.round(alterStunden * 10) / 10,
    zustand:         alterStunden <= maxStunden ? 'ok' : 'veraltet',
  }
}

export async function holeBackupStatus(
  db:         Db,
  dbMaxStd:   number,
  depMaxStd:  number,
): Promise<MonitoringBackupStatus> {
  // Jüngste ERFOLGREICHE DB-Sicherung
  const [letzteDb] = await db
    .select({ erstelltAm: dbSicherungen.erstelltAm })
    .from(dbSicherungen)
    .where(eq(dbSicherungen.erfolgreich, true))
    .orderBy(desc(dbSicherungen.erstelltAm))
    .limit(1)

  // Jüngste DEP-Sicherung
  const [letzteDep] = await db
    .select({ erstelltAm: depSicherungen.erstelltAm })
    .from(depSicherungen)
    .orderBy(desc(depSicherungen.erstelltAm))
    .limit(1)

  const dbBackup  = bewerte(letzteDb?.erstelltAm  ?? null, dbMaxStd)
  const depBackup = bewerte(letzteDep?.erstelltAm ?? null, depMaxStd)

  // "veraltet" ist kritisch (Sicherungen liefen und stoppten); "fehlt" nicht
  // (z. B. frische Installation vor dem ersten nächtlichen Lauf).
  const gesund = dbBackup.zustand !== 'veraltet' && depBackup.zustand !== 'veraltet'

  return { dbBackup, depBackup, gesund }
}
