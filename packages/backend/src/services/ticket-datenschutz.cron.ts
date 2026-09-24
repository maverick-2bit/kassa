import type { Db } from '../db/client.js'
import { loescheFaelligePersonendaten } from './ticket-datenschutz.service.js'

type Logger = {
  info:  (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Stündlich: Personendaten von Events löschen, deren Aufbewahrungsfrist
 * abgelaufen ist (Tage nach Eventende, je Event einstellbar). Der Sofort-Lauf
 * beim Start holt eine Frist nach, die in eine Ausschaltzeit fiel.
 */
export function starteTicketDatenschutzCron(db: Db, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }

  async function pruefe(): Promise<void> {
    try {
      const r = await loescheFaelligePersonendaten(db)
      if (r.events > 0) log.info(r, 'Ticketing: Personendaten nach Aufbewahrungsfrist gelöscht')
    } catch (err) {
      log.error({ err }, 'Ticketing-Datenschutz-Job fehlgeschlagen')
    }
  }

  void pruefe()
  aktiverCron = setInterval(() => void pruefe(), 60 * 60_000)

  return () => {
    if (aktiverCron) {
      clearInterval(aktiverCron)
      aktiverCron = null
    }
  }
}
