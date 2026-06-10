import type { Db } from '../db/client.js'
import { erstelleDbSicherung, bereinigeSicherungen } from './db-backup.service.js'

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

/** Millisekunden bis zum nächsten 3:00 Uhr Wiener Zeit */
function msZumNaechsten3Uhr(): number {
  const jetzt   = new Date()
  const wienStr = jetzt.toLocaleString('en-US', { timeZone: 'Europe/Vienna' })
  const wien    = new Date(wienStr)
  const ziel    = new Date(wien)
  ziel.setHours(3, 0, 0, 0)
  if (ziel <= wien) ziel.setDate(ziel.getDate() + 1)
  return Math.max(ziel.getTime() - wien.getTime(), 0)
}

export function starteDbBackupCron(
  db:          Db,
  databaseUrl: string,
  backupDir:   string,
  retention:   number,
  log:         Logger,
): void {
  async function sichern(): Promise<void> {
    try {
      const s = await erstelleDbSicherung(db, databaseUrl, backupDir, true)
      log.info(`DB-Backup erstellt: ${s.dateiname} (${Math.round(s.dateigroesse / 1024)} KB)`)
      await bereinigeSicherungen(db, retention)
    } catch (err) {
      log.error({ err }, 'Automatischer DB-Backup fehlgeschlagen')
    }
  }

  function planeNaechsten(): void {
    const delay = msZumNaechsten3Uhr()
    setTimeout(() => {
      void sichern()
      setInterval(() => void sichern(), 24 * 60 * 60 * 1000)
    }, delay)
  }

  planeNaechsten()
}
