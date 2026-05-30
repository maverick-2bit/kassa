import type { Db } from '../db/client.js'
import { findeKassenOhneSicherung, erstelleDepSicherung } from './dep-sicherung.service.js'

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

/** Millisekunden bis zum nächsten 2:00 Uhr Wiener Zeit */
function msZumNaechsten2Uhr(): number {
  const jetzt  = new Date()
  const wienStr = jetzt.toLocaleString('en-US', { timeZone: 'Europe/Vienna' })
  const wien   = new Date(wienStr)
  const ziel   = new Date(wien)
  ziel.setHours(2, 0, 0, 0)
  if (ziel <= wien) ziel.setDate(ziel.getDate() + 1)
  return Math.max(ziel.getTime() - wien.getTime(), 0)
}

export function starteDepSicherungsCron(
  db:        Db,
  backupDir: string,
  log:       Logger,
): void {
  async function pruefeUndSichere(): Promise<void> {
    try {
      const kassen = await findeKassenOhneSicherung(db)
      for (const { kasseId, mandantId } of kassen) {
        try {
          const s = await erstelleDepSicherung(db, kasseId, mandantId, backupDir, true)
          log.info(`DEP-Sicherung erstellt: ${s.dateiname} (${s.anzahlBelege} Belege)`)
        } catch (err) {
          log.error({ err, kasseId }, 'DEP-Automatik-Sicherung für Kasse fehlgeschlagen')
        }
      }
    } catch (err) {
      log.error({ err }, 'DEP-Sicherungs-Cron fehlgeschlagen')
    }
  }

  // Sofortiger Check beim Start
  void pruefeUndSichere()

  // Täglich um 2:00 Uhr Wien
  function planeNaechsten(): void {
    const delay = msZumNaechsten2Uhr()
    setTimeout(() => {
      void pruefeUndSichere()
      setInterval(() => void pruefeUndSichere(), 24 * 60 * 60 * 1000)
    }, delay)
  }
  planeNaechsten()
}
