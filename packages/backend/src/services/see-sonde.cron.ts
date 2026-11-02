import type { Db } from '../db/client.js'
import type { BelegServiceDeps } from './beleg.service.js'
import { pruefeSeeWiederherstellung } from './see-sonde.service.js'

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Minütlicher Check, ob eine ausgefallene Signatureinheit wieder antwortet (siehe
 * see-sonde.service.ts). Bei gesunder Kassa kostet ein Durchlauf eine indexierte
 * Kassen-Abfrage ohne Treffer — erst im Ausfall wird die Einheit angesprochen.
 */
export function starteSeeSondeCron(db: Db, deps: BelegServiceDeps, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }

  let laeuft = false
  async function pruefe(): Promise<void> {
    if (laeuft) return    // ein langsamer Durchlauf (Timeout der Einheit) darf sich nicht überholen
    laeuft = true
    try {
      await pruefeSeeWiederherstellung(db, deps, new Date(), log)
    } catch (err) {
      log.error({ err }, 'SEE-Sonde fehlgeschlagen')
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
