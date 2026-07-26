import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { fuehreFaelligeAutoAbschluesseDurch } from './auto-abschluss.service.js'

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Minütlicher Check auf fällige automatische Tagesabschlüsse. Die Uhrzeit ist
 * pro Kasse konfigurierbar — deshalb kein fixer Tages-Timer wie beim DEP-Cron,
 * sondern ein leichter Minutentakt (eine indexierte Kassen-Query pro Minute).
 * Der Sofort-Check beim Start holt einen verpassten Abschluss nach.
 */
export function starteAutoAbschlussCron(db: Db, config: Config, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }

  async function pruefe(): Promise<void> {
    try {
      await fuehreFaelligeAutoAbschluesseDurch(db, config, new Date(), log)
    } catch (err) {
      log.error({ err }, 'Auto-Abschluss-Cron fehlgeschlagen')
    }
  }

  void pruefe()
  aktiverCron = setInterval(() => void pruefe(), 60_000)

  return () => {
    if (aktiverCron) {
      clearInterval(aktiverCron)
      aktiverCron = null
    }
  }
}
