import type { Db } from '../db/client.js'
import { fuehreKeepAliveDurch } from './drucker-keepalive.service.js'

type Logger = {
  error: (obj: unknown, msg: string) => void
}

let aktiverCron: ReturnType<typeof setInterval> | null = null

/**
 * Tickt alle 15 s; die tatsächliche Ping-Frequenz je Mandant steuert dessen
 * druckerKeepAliveSekunden (0 = aus) im Service.
 */
export function starteDruckerKeepAliveCron(db: Db, log: Logger): () => void {
  if (aktiverCron) {
    clearInterval(aktiverCron)
    aktiverCron = null
  }

  async function tick(): Promise<void> {
    try {
      await fuehreKeepAliveDurch(db)
    } catch (err) {
      log.error({ err }, 'Drucker-Keep-Alive-Cron fehlgeschlagen')
    }
  }

  void tick()
  aktiverCron = setInterval(() => void tick(), 15_000)

  return () => {
    if (aktiverCron) {
      clearInterval(aktiverCron)
      aktiverCron = null
    }
  }
}
