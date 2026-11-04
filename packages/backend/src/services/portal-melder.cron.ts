import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { portalAktiv, sendeMeldung } from './portal-melder.service.js'

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Meldet den Zustand der Box im eingestellten Takt (Standard 60 s) an das Serviceportal. Ohne PORTAL_URL/PORTAL_TOKEN
 * startet nichts. Die erste Meldung geht sofort raus, damit das Portal die Box nach einem Neustart gleich wieder sieht.
 */
export function starteMelderCron(db: Db, config: Config, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }
  if (!portalAktiv(config)) return () => undefined

  let laeuft = false
  async function melde(): Promise<void> {
    if (laeuft) return          // kein Überlappen bei langsamem Portal
    laeuft = true
    try { await sendeMeldung(db, config, log) }
    finally { laeuft = false }
  }

  log.info(`Serviceportal-Meldung aktiv (alle ${config.PORTAL_INTERVALL_SEKUNDEN} s)`)
  void melde()
  aktiverCron = setInterval(() => void melde(), config.PORTAL_INTERVALL_SEKUNDEN * 1000)

  return () => {
    if (aktiverCron) {
      clearInterval(aktiverCron)
      aktiverCron = null
    }
  }
}
