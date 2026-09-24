import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import type { BelegServiceDeps } from './beleg.service.js'
import { raeumeReservierungenAuf } from './ticketshop.service.js'

type Logger = {
  info:  (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Minütlicher Aufräum-Job des Ticketshops: überfällige Zahlungen klären
 * (bei Stripe nachfragen → bezahlt abschließen, verfallen freigeben). Der
 * Webhook „checkout.session.expired" erledigt das normalerweise sofort; der
 * Job fängt verlorene Webhooks und Neustarts ab.
 */
export function starteTicketshopCron(db: Db, belegDeps: BelegServiceDeps, config: Config, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }

  let laeuft = false
  async function pruefe(): Promise<void> {
    if (laeuft) return   // langsames Stripe → Runden nicht stapeln
    laeuft = true
    try {
      const ergebnis = await raeumeReservierungenAuf({ db, belegDeps, config })
      if (ergebnis.freigegeben > 0 || ergebnis.abgeschlossen > 0) {
        log.info(ergebnis, 'Ticketshop: überfällige Zahlungen geklärt')
      }
    } catch (err) {
      log.error({ err }, 'Ticketshop-Aufräum-Job fehlgeschlagen')
    } finally {
      laeuft = false
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
