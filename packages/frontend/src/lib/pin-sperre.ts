/**
 * Countdown für die PIN-Bremse des Backends.
 *
 * Nach zu vielen falschen PINs antwortet das Backend mit 429 + `wartenSekunden`
 * und prüft bis dahin gar keine PIN mehr. Das PIN-Feld soll das zeigen und
 * gesperrt bleiben, statt bei jeder Eingabe dieselbe Meldung zu produzieren.
 */

import { useEffect, useState } from 'react'
import { PIN_GESPERRT_CODE } from '@kassa/shared'
import { ApiError } from './api'

export interface PinSperre {
  gesperrt:     boolean
  restSekunden: number
  /** Sperre aus einer API-Antwort übernehmen; true, wenn es eine war */
  uebernimm:    (err: unknown) => boolean
}

export function usePinSperre(): PinSperre {
  const [bis, setBis]   = useState<number | null>(null)
  const [rest, setRest] = useState(0)

  useEffect(() => {
    if (bis === null) return
    const tick = () => {
      const r = Math.ceil((bis - Date.now()) / 1000)
      if (r <= 0) { setBis(null); setRest(0) } else setRest(r)
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [bis])

  return {
    gesperrt:     bis !== null,
    restSekunden: rest,
    uebernimm: (err) => {
      if (!(err instanceof ApiError) || err.code !== PIN_GESPERRT_CODE) return false
      setBis(Date.now() + (err.wartenSekunden ?? 30) * 1000)
      return true
    },
  }
}

/** „0:27" bzw. „4:30" — für die Anzeige am PIN-Feld. */
export function restzeitText(sekunden: number): string {
  const m = Math.floor(sekunden / 60)
  const s = sekunden % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
