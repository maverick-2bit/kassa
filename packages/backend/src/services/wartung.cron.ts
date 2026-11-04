import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { fuehreAutoRechnungenDurch, fuehreWartungslaufDurch } from './wartungsvertrag.service.js'

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Halbstündlicher Check: erzeugt zum Monatswechsel die Wartungslieferscheine und verschickt für Kunden mit
 * Rechnungsversand per Mail die fälligen Rechnungen. Beides ist wiederholbar (pro Vertrag und Monat höchstens
 * ein Lieferschein, jeder Lieferschein nur einmal verrechenbar) — der Sofort-Check beim Start holt eine
 * ausgefallene Nacht nach.
 */
export function starteWartungCron(db: Db, config: Config, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }

  async function pruefe(): Promise<void> {
    try {
      const jetzt = new Date()
      await fuehreWartungslaufDurch(db, { jetzt, log })
      await fuehreAutoRechnungenDurch(db, config, jetzt, log)
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
