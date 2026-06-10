import { useState, useCallback, useEffect, useRef } from 'react'
import type { KdsBon, KdsStation, KdsSseEvent } from './types'
import { STATION_LABELS, STATION_FARBEN } from './types'
import { fetchBons, nachrichtSenden } from './api'
import { useKdsSse } from './hooks/useKdsSse'
import { BonKarte } from './components/BonKarte'

// Konfiguration aus URL-Parametern
function getConfig() {
  const params = new URLSearchParams(window.location.search)
  return {
    station: (params.get('station') ?? 'kueche') as KdsStation,
    token:   params.get('token') ?? '',
  }
}

function SetupScreen({ onSave }: { onSave: (station: KdsStation, token: string) => void }) {
  const [station, setStation] = useState<KdsStation>('kueche')
  const [token, setToken]     = useState('')

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="bg-zinc-900 rounded-2xl p-8 w-full max-w-md space-y-6">
        <h1 className="text-2xl font-black text-white">KDS Einrichtung</h1>

        <div className="space-y-2">
          <label className="text-zinc-400 text-sm font-medium">Station</label>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(STATION_LABELS) as KdsStation[]).map(s => (
              <button
                key={s}
                onClick={() => setStation(s)}
                style={{ borderColor: station === s ? STATION_FARBEN[s] : 'transparent' }}
                className="py-3 rounded-xl bg-zinc-800 text-white font-bold border-2 transition-all"
              >
                {STATION_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-zinc-400 text-sm font-medium">JWT-Token</label>
          <textarea
            value={token}
            onChange={e => setToken(e.target.value)}
            rows={3}
            placeholder="Bearer Token aus der Kassa-Einstellung einfügen..."
            className="w-full bg-zinc-800 text-white rounded-xl p-3 text-sm font-mono border border-zinc-700 focus:outline-none focus:border-zinc-500 resize-none"
          />
        </div>

        <button
          onClick={() => {
            if (!token.trim()) return alert('Token fehlt')
            // URL aktualisieren + starten
            const url = new URL(window.location.href)
            url.searchParams.set('station', station)
            url.searchParams.set('token', token.trim())
            window.history.replaceState({}, '', url.toString())
            onSave(station, token.trim())
          }}
          className="w-full py-4 rounded-xl font-black text-white text-lg"
          style={{ backgroundColor: STATION_FARBEN[station] }}
        >
          {STATION_LABELS[station]} starten
        </button>
      </div>
    </div>
  )
}

function UhrDisplay() {
  const [uhrzeit, setUhrzeit] = useState(() =>
    new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  )
  useEffect(() => {
    const id = setInterval(() => {
      setUhrzeit(new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }, 1000)
    return () => clearInterval(id)
  }, [])
  return <span className="font-mono tabular-nums text-zinc-400 text-sm">{uhrzeit}</span>
}

interface GesendeteNachricht {
  text:  string
  zeit:  string
  ok:    boolean
  fehler?: string
}

function ChatPanel({
  station, token, farbe, onClose,
}: {
  station: string
  token:   string
  farbe:   string
  onClose: () => void
}) {
  const [text, setText]           = useState('')
  const [senden, setSenden]       = useState(false)
  const [verlauf, setVerlauf]     = useState<GesendeteNachricht[]>([])
  const inputRef                  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function absenden() {
    const msg = text.trim()
    if (!msg || senden) return
    setSenden(true)
    try {
      await nachrichtSenden(msg, station, token)
      setVerlauf(v => [...v, { text: msg, zeit: new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }), ok: true }])
      setText('')
    } catch (e) {
      setVerlauf(v => [...v, { text: msg, zeit: new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }), ok: false, fehler: e instanceof Error ? e.message : 'Fehler' }])
    } finally {
      setSenden(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-2xl w-full max-w-md flex flex-col shadow-2xl border border-zinc-700" style={{ maxHeight: '80vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <span className="text-2xl">💬</span>
            <div>
              <p className="font-black text-white">Nachricht an Kellner</p>
              <p className="text-xs text-zinc-400">von {STATION_LABELS[station as KdsStation] ?? station}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition text-xl font-bold w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        {/* Verlauf */}
        {verlauf.length > 0 && (
          <div className="flex-1 overflow-auto px-5 py-3 space-y-2">
            {verlauf.map((m, i) => (
              <div key={i} className={`rounded-xl px-4 py-2.5 text-sm ${m.ok ? 'bg-zinc-800' : 'bg-red-900/40 border border-red-700'}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-zinc-100 leading-snug">{m.text}</p>
                  <span className="text-zinc-500 text-xs shrink-0 mt-0.5">{m.zeit}</span>
                </div>
                {m.ok ? (
                  <p className="text-xs text-green-400 mt-1">✓ Gesendet</p>
                ) : (
                  <p className="text-xs text-red-400 mt-1">✗ {m.fehler}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Eingabe */}
        <div className="px-5 py-4 space-y-3">
          <textarea
            ref={inputRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); absenden() } }}
            rows={3}
            maxLength={500}
            placeholder="Nachricht eingeben… (Enter zum Senden)"
            className="w-full bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm border border-zinc-700 focus:outline-none focus:border-zinc-500 resize-none placeholder-zinc-600"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-zinc-600">{text.length}/500</span>
            <button
              onClick={absenden}
              disabled={!text.trim() || senden}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: farbe }}
            >
              {senden ? '⏳ Senden…' : '📤 Senden'}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}

export default function App() {
  const [config, setConfig] = useState(getConfig)
  const [bons, setBons]     = useState<KdsBon[]>([])
  const [verbunden, setVerbunden] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [chatOffen, setChatOffen] = useState(false)

  const { station, token } = config
  const istKonfiguriert     = Boolean(token)

  // Initial-Laden
  useEffect(() => {
    if (!istKonfiguriert) return
    fetchBons(station, token)
      .then(data => { setBons(data); setVerbunden(true); setFehler(null) })
      .catch(e => setFehler(e.message))
  }, [station, token, istKonfiguriert])

  // SSE-Handler
  const handleEvent = useCallback((event: KdsSseEvent) => {
    switch (event.typ) {
      case 'snapshot':
        setBons(event.bons)
        setVerbunden(true)
        setFehler(null)
        break

      case 'neuer_bon':
        setBons(prev => {
          if (prev.some(b => b.id === event.bon.id)) return prev
          // Ton abspielen
          try {
            const ctx = new AudioContext()
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.connect(gain); gain.connect(ctx.destination)
            osc.frequency.value = 880
            gain.gain.setValueAtTime(0.3, ctx.currentTime)
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
            osc.start(); osc.stop(ctx.currentTime + 0.4)
          } catch { /* AudioContext nicht verfügbar */ }
          return [event.bon, ...prev]
        })
        break

      case 'bon_erledigt':
        setBons(prev => prev.filter(b => b.id !== event.bonId))
        break

      case 'position_toggle':
        setBons(prev => prev.map(b =>
          b.id !== event.bonId ? b : {
            ...b,
            positionen: b.positionen.map(p =>
              p.id === event.positionId ? { ...p, erledigt: event.erledigt } : p
            ),
          }
        ))
        break
    }
  }, [])

  useKdsSse({ station, token, onEvent: handleEvent })

  const handleErledigt = useCallback((bonId: string) => {
    setBons(prev => prev.filter(b => b.id !== bonId))
  }, [])

  if (!istKonfiguriert) {
    return (
      <SetupScreen
        onSave={(s, t) => setConfig({ station: s, token: t })}
      />
    )
  }

  const farbe = STATION_FARBEN[station] ?? '#6b7280'

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">

      {/* Top-Bar */}
      <div
        className="flex items-center justify-between px-5 py-3 shrink-0"
        style={{ borderBottom: `3px solid ${farbe}` }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: verbunden ? '#22c55e' : '#ef4444' }}
          />
          <span className="font-black text-xl" style={{ color: farbe }}>
            {STATION_LABELS[station]}
          </span>
          <span className="bg-zinc-800 text-zinc-300 rounded-full px-3 py-0.5 text-sm font-bold">
            {bons.length} offen
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setChatOffen(true)}
            title="Nachricht an Kellner senden"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-sm font-medium transition"
          >
            <span>💬</span>
            <span className="hidden sm:inline">Nachricht</span>
          </button>
          <UhrDisplay />
        </div>
      </div>

      {chatOffen && (
        <ChatPanel
          station={station}
          token={token}
          farbe={farbe}
          onClose={() => setChatOffen(false)}
        />
      )}

      {/* Fehler-Banner */}
      {fehler && (
        <div className="bg-red-900/50 text-red-300 text-sm px-5 py-2 text-center">
          Verbindungsfehler: {fehler} – wird automatisch erneut versucht…
        </div>
      )}

      {/* Bons-Grid */}
      <div className="flex-1 overflow-auto p-4">
        {bons.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
            <div className="text-6xl">✓</div>
            <div className="text-xl font-bold">Keine offenen Bestellungen</div>
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 auto-rows-max">
            {bons.map(bon => (
              <BonKarte
                key={bon.id}
                bon={bon}
                token={token}
                onErledigt={handleErledigt}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
