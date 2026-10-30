import type { Db } from '../db/client.js'
import { fuehreWartungslaufDurch } from './wartungsvertrag.service.js'

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Halbstündlicher Check: erzeugt zum Monatswechsel die Wartungslieferscheine. Der Lauf ist
 * wiederholbar (pro Vertrag und Monat höchstens ein Lieferschein) — der Sofort-Check beim
 * Start holt eine ausgefallene Nacht nach.
 */
export function starteWartungCron(db: Db, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }

  async function pruefe(): Promise<void> {
    try {
      await fuehreWartungslaufDurch(db, { jetzt: new Date(), log })
    } catch (err) {
      log.error({ err }, 'Wartungs-Cron fehlgeschlagen')
    }
  }

  void pruefe()
  aktiverCron = setInterval(() => void pruefe(), 30 * 60_000)

  return () => {
    if (aktiverCron) {
      clearInterval(aktiverCron)
      aktiverCron = null
    }
  }
}
