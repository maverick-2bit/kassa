/**
 * Monitoring-Service: ermittelt die Frische der vom Backend erstellten
 * Sicherungen (DB-Dump + DEP-Archiv) für Health-/Monitoring-Endpoints.
 */

import { statfs } from 'node:fs/promises'
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

// ---------------------------------------------------------------------------
// Plattenplatz
// ---------------------------------------------------------------------------

export type SpeicherZustand = 'ok' | 'knapp' | 'kritisch' | 'unbekannt'

export interface SpeicherStatus {
  /** Geprüfter Pfad — das Sicherungsverzeichnis steht auf derselben Platte wie die Daten. */
  pfad:           string
  gesamtGb:       number | null
  freiGb:         number | null
  freiProzent:    number | null
  zustand:        SpeicherZustand
}

/**
 * Freier Plattenplatz.
 *
 * Die volle Platte ist der einzige Ausfall im Pilotbetrieb, den man bisher
 * nicht kommen sah: Postgres bleibt stehen UND die Sicherung kann nicht mehr
 * schreiben — beides gleichzeitig, beides ohne Vorwarnung. Datenbank,
 * DB-Dumps und DEP-Archive liegen auf derselben Platte, deshalb genügt EIN
 * Messpunkt; geprüft wird das Sicherungsverzeichnis, weil das Backend darauf
 * garantiert Zugriff hat.
 *
 * Zwei Schwellen, verknüpft mit ODER: der Prozentsatz greift auf kleinen
 * Platten, die Absolutgrenze auf großen (10 % von 2 TB wären 200 GB — bis
 * dahin ist eine Warnung längst überfällig).
 *
 * Ein Fehler beim Messen darf den Monitoring-Endpoint nicht umwerfen, deshalb
 * „unbekannt" statt Ausnahme.
 *
 * `messe` ist injizierbar (Muster wie bei den übrigen Service-Deps): so lassen
 * sich die Schwellen prüfen, ohne eine Platte vollzuschreiben.
 */
export type StatfsFn = (pfad: string) => Promise<{ bsize: number; blocks: number; bavail: number }>

export async function holeSpeicherStatus(
  pfad:  string,
  messe: StatfsFn = statfs,
): Promise<SpeicherStatus> {
  // Das Sicherungsverzeichnis entsteht erst beim ersten nächtlichen Lauf. Bis
  // dahin würde die Messung scheitern und der Platz unbeobachtet bleiben —
  // deshalb ersatzweise das Arbeitsverzeichnis, das auf derselben Platte liegt.
  // Gemeldet wird der Pfad, der tatsächlich gemessen wurde.
  for (const kandidat of [pfad, process.cwd()]) {
    const s = await messeEinen(kandidat, messe)
    if (s.zustand !== 'unbekannt') return s
  }
  return { pfad, gesamtGb: null, freiGb: null, freiProzent: null, zustand: 'unbekannt' }
}

async function messeEinen(pfad: string, messe: StatfsFn): Promise<SpeicherStatus> {
  try {
    const fs = await messe(pfad)
    // bavail = für nicht-privilegierte Prozesse verfügbar (bfree enthält die
    // root-Reserve, die dem Backend nichts nützt).
    const gesamtBytes = fs.blocks * fs.bsize
    const freiBytes   = fs.bavail * fs.bsize
    const gb          = (b: number) => Math.round(b / 1024 ** 3 * 10) / 10
    const freiProzent = gesamtBytes > 0
      ? Math.round(freiBytes / gesamtBytes * 1000) / 10
      : 0
    const freiGb = gb(freiBytes)

    const zustand: SpeicherZustand =
      freiProzent < 5  || freiGb < 2 ? 'kritisch'
      : freiProzent < 10 || freiGb < 5 ? 'knapp'
      : 'ok'

    return { pfad, gesamtGb: gb(gesamtBytes), freiGb, freiProzent, zustand }
  } catch {
    return { pfad, gesamtGb: null, freiGb: null, freiProzent: null, zustand: 'unbekannt' }
  }
}
