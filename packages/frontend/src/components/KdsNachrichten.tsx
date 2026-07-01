/**
 * KdsNachrichten — zeigt eingehende KDS-Nachrichten als persistente Benachrichtigung.
 * Kellner können direkt auf eine Nachricht antworten.
 */

import { useCallback, useRef, useState } from 'react'
import type { KasseEvent, KdsNachrichtEvent } from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { useKasseEvents } from '../lib/sse'
import { getKasseIdentity } from '../lib/kasse'
import { kdsApi } from '../lib/api'

type Station = keyof typeof STATION_LABELS

function spielTon() {
  try {
    const ctx  = new AudioContext()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.4, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
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

// ---------------------------------------------------------------------------
// Einzelne Nachricht mit Antwort-Option
// ---------------------------------------------------------------------------

function NachrichtKarte({
  nachricht,
  onBestaetigen,
}: {
  nachricht:    KdsNachrichtEvent
  onBestaetigen: () => void
}) {
  const [antwortOffen, setAntwortOffen] = useState(false)
  const [antwortText, setAntwortText]   = useState('')
  const [senden, setSenden]             = useState(false)
  const [gesendet, setGesendet]         = useState(false)
  const inputRef                        = useRef<HTMLTextAreaElement>(null)

  function oeffneAntwort() {
    setAntwortOffen(true)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  async function sendeAntwort() {
    const text = antwortText.trim()
    if (!text || senden) return
    setSenden(true)
    try {
      await kdsApi.antwort(text, nachricht.station)
      setGesendet(true)
      setAntwortText('')
      setAntwortOffen(false)
    } catch {
      // Fehler still ignorieren — Hauptfunktion bleibt erhalten
    } finally {
      setSenden(false)
    }
  }

  const uhrzeit = new Date(nachricht.zeit).toLocaleTimeString('de-AT', {
    hour: '2-digit', minute: '2-digit',
  })

  return (
    <div className="pointer-events-auto bg-amber-50 border-2 border-amber-400 rounded-2xl shadow-2xl overflow-hidden">

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-400">
        <span className="text-xl">💬</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-black text-amber-900 truncate">
            Nachricht von {stationLabel(nachricht.station)}
          </p>
          <p className="text-xs text-amber-800">{uhrzeit}</p>
        </div>
        <button
          onClick={onBestaetigen}
          className="text-amber-800 hover:text-amber-900 font-bold text-lg w-7 h-7 flex items-center justify-center rounded-full hover:bg-amber-300 transition shrink-0"
          title="Schließen"
        >✕</button>
      </div>

      {/* Nachrichtentext */}
      <div className="px-4 pt-3 pb-2">
        <p className="text-ink font-medium leading-snug whitespace-pre-wrap break-words">
          {nachricht.text}
        </p>
        {gesendet && (
          <p className="text-xs text-green-600 mt-1 font-medium">✓ Antwort gesendet</p>
        )}
      </div>

      {/* Antwort-Eingabe */}
      {antwortOffen ? (
        <div className="px-4 pb-3 space-y-2">
          <textarea
            ref={inputRef}
            value={antwortText}
            onChange={e => setAntwortText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendeAntwort() }
              if (e.key === 'Escape') setAntwortOffen(false)
            }}
            rows={2}
            maxLength={300}
            placeholder="Antwort eingeben… (Enter senden, Esc abbrechen)"
            className="w-full rounded-xl border border-amber-300 bg-panel px-3 py-2 text-sm focus:outline-none focus:border-amber-500 resize-none placeholder-gray-400"
          />
          <div className="flex gap-2">
            <button
              onClick={() => setAntwortOffen(false)}
              className="flex-1 py-2 rounded-xl border border-line-strong text-ink-muted text-sm font-medium hover:bg-panel-2 transition"
            >
              Abbrechen
            </button>
            <button
              onClick={() => void sendeAntwort()}
              disabled={!antwortText.trim() || senden}
              className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold transition disabled:opacity-40"
            >
              {senden ? '⏳…' : '↩ Antworten'}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-3 flex gap-2">
          <button
            onClick={oeffneAntwort}
            className="flex-1 py-2 rounded-xl border border-amber-300 text-amber-700 text-sm font-medium hover:bg-amber-100 transition"
          >
            ↩ Antworten
          </button>
          <button
            onClick={onBestaetigen}
            className="flex-1 py-2 rounded-xl bg-amber-400 hover:bg-amber-500 text-amber-900 text-sm font-bold transition"
          >
            ✓ Verstanden
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Haupt-Komponente
// ---------------------------------------------------------------------------

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

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none">
      {nachrichten.map(n => (
        <NachrichtKarte
          key={n.zeit}
          nachricht={n}
          onBestaetigen={() => bestaetigen(n.zeit)}
        />
      ))}
      {nachrichten.length > 1 && (
        <button
          onClick={() => setNachrichten([])}
          className="pointer-events-auto self-center px-5 py-2 rounded-xl bg-gray-800 text-white text-sm font-bold shadow-lg hover:bg-gray-700 transition"
        >
          Alle schließen ({nachrichten.length})
        </button>
      )}
    </div>
  )
}
