/**
 * KdsNachrichten — zeigt eingehende KDS-Nachrichten als persistente Benachrichtigung.
 *
 * Nachrichten werden NICHT automatisch ausgeblendet — der Kellner muss sie
 * aktiv bestätigen. Bei jeder neuen Nachricht wird ein Ton gespielt.
 */

import { useCallback, useState } from 'react'
import type { KasseEvent, KdsNachrichtEvent } from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { useKasseEvents } from '../lib/sse'
import { getKasseIdentity } from '../lib/kasse'

type Station = keyof typeof STATION_LABELS

function spielTon() {
  try {
    const ctx  = new AudioContext()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.4, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)

    // Zwei kurze Töne
    ;[0, 0.15].forEach(offset => {
      const osc = ctx.createOscillator()
      osc.connect(gain)
      osc.frequency.value = 660
      osc.start(ctx.currentTime + offset)
      osc.stop(ctx.currentTime + offset + 0.12)
    })
  } catch { /* AudioContext nicht verfügbar */ }
}

function stationLabel(station: string): string {
  return STATION_LABELS[station as Station] ?? station
}

export function KdsNachrichten() {
  const [nachrichten, setNachrichten] = useState<KdsNachrichtEvent[]>([])

  const handleEvent = useCallback((event: KasseEvent) => {
    if (event.typ !== 'kds_nachricht') return

    // Gezielte Nachricht? Prüfen ob diese Kasse gemeint ist.
    if (event.kasseIds.length > 0) {
      const identity = getKasseIdentity()
      if (!identity || !event.kasseIds.includes(identity.kasseId)) return
    }

    spielTon()
    setNachrichten(prev => [...prev, event])
  }, [])

  useKasseEvents(handleEvent)

  if (nachrichten.length === 0) return null

  function bestaetigen(zeit: string) {
    setNachrichten(prev => prev.filter(n => n.zeit !== zeit))
  }

  function alleBestaetigen() {
    setNachrichten([])
  }

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none">
      {nachrichten.map((n) => (
        <div
          key={n.zeit}
          className="pointer-events-auto bg-amber-50 border-2 border-amber-400 rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-top-4 duration-300"
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-400">
            <span className="text-xl">💬</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-black text-amber-900 truncate">
                Nachricht von {stationLabel(n.station)}
              </p>
              <p className="text-xs text-amber-800">
                {new Date(n.zeit).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            <button
              onClick={() => bestaetigen(n.zeit)}
              className="text-amber-800 hover:text-amber-900 font-bold text-lg w-7 h-7 flex items-center justify-center rounded-full hover:bg-amber-300 transition shrink-0"
              title="Bestätigen"
            >
              ✕
            </button>
          </div>

          {/* Nachrichtentext */}
          <div className="px-4 py-3">
            <p className="text-gray-900 font-medium leading-snug whitespace-pre-wrap break-words">
              {n.text}
            </p>
          </div>

          {/* Bestätigen-Button */}
          <div className="px-4 pb-3">
            <button
              onClick={() => bestaetigen(n.zeit)}
              className="w-full py-2 rounded-xl bg-amber-400 hover:bg-amber-500 text-amber-900 font-bold text-sm transition"
            >
              ✓ Verstanden
            </button>
          </div>
        </div>
      ))}

      {/* "Alle bestätigen" wenn mehrere Nachrichten */}
      {nachrichten.length > 1 && (
        <button
          onClick={alleBestaetigen}
          className="pointer-events-auto self-center px-5 py-2 rounded-xl bg-gray-800 text-white text-sm font-bold shadow-lg hover:bg-gray-700 transition"
        >
          Alle bestätigen ({nachrichten.length})
        </button>
      )}
    </div>
  )
}
