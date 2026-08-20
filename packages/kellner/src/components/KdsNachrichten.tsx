/**
 * KDS-Nachrichten am Kellner-Handy („Schnitzel ist aus!", „Essen fertig
 * für Tisch 5"). Empfängt dieselben SSE-Events wie das Haupt-POS; gezielte
 * Nachrichten werden auf die Kasse dieses Geräts gefiltert.
 */

import { useCallback, useRef, useState } from 'react'
import type { KasseEvent, KdsNachrichtEvent } from '@kassa/shared'
import { useKasseEvents } from '../lib/sse'
import { getKasseIdentity } from '../lib/kasse'
import { kdsAntwortApi } from '../lib/api'

const STATION_NAMEN: Record<string, string> = {
  schank: 'Schank', kueche: 'Küche', kalte_kueche: 'Kalte Küche', dessert: 'Dessert',
}

function NachrichtKarte({ nachricht, onSchliessen }: { nachricht: KdsNachrichtEvent; onSchliessen: () => void }) {
  const [antwortOffen, setAntwortOffen] = useState(false)
  const [antwort, setAntwort]           = useState('')
  const [sendet, setSendet]             = useState(false)
  const [fehler, setFehler]             = useState<string | null>(null)

  const senden = async () => {
    const text = antwort.trim()
    if (!text || sendet) return
    setSendet(true)
    setFehler(null)
    try {
      await kdsAntwortApi.senden(text, nachricht.station)
      onSchliessen()
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Senden fehlgeschlagen')
    } finally {
      setSendet(false)
    }
  }

  return (
    <div className="pointer-events-auto rounded-2xl border-2 border-amber-400 bg-amber-50 shadow-2xl overflow-hidden">
      <div className="px-4 py-2.5 bg-amber-100 flex items-center gap-2">
        <span className="text-xl">💬</span>
        <p className="flex-1 text-sm font-black text-amber-900">
          {STATION_NAMEN[nachricht.station] ?? nachricht.station} meldet
        </p>
        <span className="text-xs text-amber-700">
          {new Date(nachricht.zeit).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <p className="px-4 py-3 text-amber-950 font-semibold leading-snug whitespace-pre-wrap break-words">
        {nachricht.text}
      </p>
      {antwortOffen ? (
        <div className="px-4 pb-3 space-y-2">
          <textarea
            value={antwort}
            onChange={e => setAntwort(e.target.value)}
            rows={2}
            maxLength={500}
            autoFocus
            placeholder="Antwort an die Station…"
            className="w-full rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm text-amber-950 focus:outline-none focus:border-amber-500 resize-none"
          />
          {fehler && <p className="text-xs text-red-600 font-medium">{fehler}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => setAntwortOffen(false)}
              className="flex-1 py-2 rounded-xl border border-amber-300 text-amber-700 text-sm font-bold"
            >
              Zurück
            </button>
            <button
              onClick={senden}
              disabled={!antwort.trim() || sendet}
              className="flex-1 py-2 rounded-xl bg-amber-500 text-white text-sm font-black disabled:opacity-40"
            >
              {sendet ? '…' : '↩ Senden'}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-3 flex gap-2">
          <button
            onClick={() => setAntwortOffen(true)}
            className="flex-1 py-2.5 rounded-xl border border-amber-300 text-amber-700 text-sm font-bold active:scale-95 transition"
          >
            ↩ Antworten
          </button>
          <button
            onClick={onSchliessen}
            className="flex-1 py-2.5 rounded-xl bg-amber-400 text-amber-900 text-sm font-black active:scale-95 transition"
          >
            ✓ Verstanden
          </button>
        </div>
      )}
    </div>
  )
}

export function KdsNachrichten() {
  const [nachrichten, setNachrichten] = useState<KdsNachrichtEvent[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)

  const handleEvent = useCallback((event: KasseEvent) => {
    if (event.typ !== 'kds_nachricht') return

    // Gezielte Nachricht? Nur annehmen, wenn die Kasse dieses Geräts gemeint ist.
    if (event.kasseIds.length > 0) {
      const identity = getKasseIdentity()
      if (!identity || !event.kasseIds.includes(identity.kasseId)) return
    }

    // Hinweiston (best effort — ohne Nutzer-Interaktion ggf. stumm)
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContext()
      }
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') { void ctx.resume() }
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.frequency.value = 660
      gain.gain.setValueAtTime(0.3, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
      osc.start(); osc.stop(ctx.currentTime + 0.5)
    } catch { /* AudioContext nicht verfügbar */ }

    setNachrichten(prev => [...prev, event])
  }, [])

  useKasseEvents(handleEvent)

  if (nachrichten.length === 0) return null

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[70] flex flex-col gap-2 w-full max-w-sm px-3 pointer-events-none">
      {nachrichten.map(n => (
        <NachrichtKarte
          key={n.zeit}
          nachricht={n}
          onSchliessen={() => setNachrichten(prev => prev.filter(x => x.zeit !== n.zeit))}
        />
      ))}
      {nachrichten.length > 1 && (
        <button
          onClick={() => setNachrichten([])}
          className="pointer-events-auto self-center px-5 py-2 rounded-xl bg-ink text-surface text-sm font-bold shadow-lg"
        >
          Alle schließen ({nachrichten.length})
        </button>
      )}
    </div>
  )
}
