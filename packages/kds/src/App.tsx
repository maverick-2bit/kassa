import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { KdsBon, KdsStation, KdsSseEvent } from './types'
import { STATION_LABELS, STATION_FARBEN } from './types'
import { fetchBons, ladeKassen, nachrichtSenden, type KdsKasse } from './api'
import { useKdsSse } from './hooks/useKdsSse'
import { BonKarte } from './components/BonKarte'
import { GrossAnzeige } from './components/GrossAnzeige'
import { BonArchiv } from './components/BonArchiv'

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
  text:      string
  zeit:      string
  ok:        boolean
  empfaenger: string   // "Alle Kassen" oder Kassen-Namen
  fehler?:   string
}

function ChatPanel({
  station, token, farbe, onClose,
}: {
  station: string
  token:   string
  farbe:   string
  onClose: () => void
}) {
  const [text, setText]               = useState('')
  const [senden, setSenden]           = useState(false)
  const [verlauf, setVerlauf]         = useState<GesendeteNachricht[]>([])
  const [kassen, setKassen]           = useState<KdsKasse[]>([])
  const [gewaehlteIds, setGewaehlteIds] = useState<string[]>([])   // leer = alle
  const inputRef                      = useRef<HTMLTextAreaElement>(null)

  // Kassen beim Öffnen laden
  useEffect(() => {
    ladeKassen(token)
      .then(setKassen)
      .catch(() => { /* bei Fehler einfach leer lassen — Broadcast klappt trotzdem */ })
    inputRef.current?.focus()
  }, [token])

  const alleGewaehlt = gewaehlteIds.length === 0

  function toggleKasse(id: string) {
    setGewaehlteIds(prev =>
      prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id]
    )
  }

  function empfaengerLabel(): string {
    if (alleGewaehlt) return 'Alle Kassen'
    return gewaehlteIds
      .map(id => kassen.find(k => k.id === id))
      .filter(Boolean)
      .map(k => k!.bezeichnung ?? k!.kassenId)
      .join(', ')
  }

  async function absenden() {
    const msg = text.trim()
    if (!msg || senden) return
    setSenden(true)
    const label = empfaengerLabel()
    try {
      await nachrichtSenden(msg, station, token, gewaehlteIds)
      setVerlauf(v => [...v, {
        text:       msg,
        zeit:       new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }),
        ok:         true,
        empfaenger: label,
      }])
      setText('')
    } catch (e) {
      setVerlauf(v => [...v, {
        text:       msg,
        zeit:       new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }),
        ok:         false,
        empfaenger: label,
        fehler:     e instanceof Error ? e.message : 'Fehler',
      }])
    } finally {
      setSenden(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-2xl w-full max-w-md flex flex-col shadow-2xl border border-zinc-700" style={{ maxHeight: '85vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
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
          >✕</button>
        </div>

        {/* Empfänger-Selektor */}
        {kassen.length > 1 && (
          <div className="px-5 py-3 border-b border-zinc-800 shrink-0">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Empfänger</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setGewaehlteIds([])}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                  alleGewaehlt
                    ? 'text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-white'
                }`}
                style={alleGewaehlt ? { backgroundColor: farbe } : {}}
              >
                📢 Alle Kassen
              </button>
              {kassen.map(k => {
                const aktiv = gewaehlteIds.includes(k.id)
                return (
                  <button
                    key={k.id}
                    onClick={() => toggleKasse(k.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                      aktiv
                        ? 'text-white'
                        : 'bg-zinc-800 text-zinc-400 hover:text-white'
                    }`}
                    style={aktiv ? { backgroundColor: farbe } : {}}
                  >
                    {k.bezeichnung ?? k.kassenId}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Verlauf */}
        {verlauf.length > 0 && (
          <div className="flex-1 overflow-auto px-5 py-3 space-y-2 min-h-0">
            {verlauf.map((m, i) => (
              <div key={i} className={`rounded-xl px-4 py-2.5 text-sm ${m.ok ? 'bg-zinc-800' : 'bg-red-900/40 border border-red-700'}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-zinc-100 leading-snug">{m.text}</p>
                  <span className="text-zinc-500 text-xs shrink-0 mt-0.5">{m.zeit}</span>
                </div>
                {m.ok ? (
                  <p className="text-xs text-green-400 mt-1">✓ Gesendet an: {m.empfaenger}</p>
                ) : (
                  <p className="text-xs text-red-400 mt-1">✗ {m.fehler}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Eingabe */}
        <div className="px-5 py-4 space-y-3 shrink-0">
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
            <span className="text-xs text-zinc-500 truncate">
              → {empfaengerLabel()}
            </span>
            <button
              onClick={absenden}
              disabled={!text.trim() || senden}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm text-white transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
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

interface KellerAntwort {
  text:             string
  kasseBezeichnung: string
  zeit:             string
}

export default function App() {
  const [config, setConfig] = useState(getConfig)
  const [bons, setBons]     = useState<KdsBon[]>([])
  const [verbunden, setVerbunden] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [chatOffen, setChatOffen]   = useState(false)
  const [antworten, setAntworten]   = useState<KellerAntwort[]>([])
  const [ansicht, setAnsicht]       = useState<'kds' | 'gross' | 'archiv'>('kds')
  const audioCtxRef = useRef<AudioContext | null>(null)

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
          // Ton abspielen – geteilter AudioContext (Browser-Cap: max ~6 Instanzen)
          try {
            if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
              audioCtxRef.current = new AudioContext()
            }
            const ctx = audioCtxRef.current
            if (ctx.state === 'suspended') { void ctx.resume() }
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
            positionen: b.positionen.map(p => {
              if (p.id !== event.positionId) return p
              return {
                ...p,
                erledigt: event.erledigt,
                ...(event.erledigtMenge !== undefined ? { erledigtMenge: event.erledigtMenge } : {}),
              }
            }),
          }
        ))
        break

      case 'kellner_antwort':
        try {
          if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
            audioCtxRef.current = new AudioContext()
          }
          const ctx = audioCtxRef.current
          if (ctx.state === 'suspended') { void ctx.resume() }
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain); gain.connect(ctx.destination)
          osc.frequency.value = 523
          gain.gain.setValueAtTime(0.3, ctx.currentTime)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
          osc.start(); osc.stop(ctx.currentTime + 0.5)
        } catch { /* AudioContext nicht verfügbar */ }
        setAntworten(prev => [...prev, {
          text:             event.text,
          kasseBezeichnung: event.kasseBezeichnung,
          zeit:             event.zeit,
        }])
        break
    }
  }, [])

  useKdsSse({ station, token, onEvent: handleEvent })

  const handleErledigt = useCallback((bonId: string) => {
    setBons(prev => prev.filter(b => b.id !== bonId))
  }, [])

  // Aggregierte offene Artikel über alle Bons dieser Station
  const aggregiertArtikel = useMemo(() => {
    const map = new Map<string, number>()
    for (const bon of bons) {
      for (const pos of bon.positionen) {
        if (pos.erledigt) continue
        const offen = pos.menge - (pos.erledigtMenge ?? 0)
        if (offen <= 0) continue
        const key = pos.bezeichnung + (pos.details ? ` · ${pos.details}` : '')
        map.set(key, (map.get(key) ?? 0) + offen)
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [bons])

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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAnsicht('gross')}
            title="Großanzeige öffnen"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-sm font-medium transition"
          >
            <span>⬛</span>
            <span className="hidden sm:inline">Großanzeige</span>
          </button>
          <button
            onClick={() => setAnsicht('archiv')}
            title="Bon-Archiv öffnen"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-sm font-medium transition"
          >
            <span>📋</span>
            <span className="hidden sm:inline">Archiv</span>
          </button>
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

      {ansicht === 'gross' && (
        <div className="fixed inset-0 z-40">
          <GrossAnzeige
            bons={bons}
            station={station}
            farbe={farbe}
            onZurueck={() => setAnsicht('kds')}
          />
        </div>
      )}

      {ansicht === 'archiv' && (
        <div className="fixed inset-0 z-40">
          <BonArchiv
            station={station}
            token={token}
            farbe={farbe}
            onZurueck={() => setAnsicht('kds')}
          />
        </div>
      )}

      {chatOffen && (
        <ChatPanel
          station={station}
          token={token}
          farbe={farbe}
          onClose={() => setChatOffen(false)}
        />
      )}

      {/* Antworten von Kellnern */}
      {antworten.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none">
          {antworten.map((a, i) => (
            <div key={i} className="pointer-events-auto bg-zinc-800 border-2 border-zinc-600 rounded-2xl shadow-2xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: farbe + '33', borderBottom: `2px solid ${farbe}` }}>
                <span className="text-xl">↩</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-black text-white truncate">Antwort von {a.kasseBezeichnung}</p>
                  <p className="text-xs text-zinc-400">
                    {new Date(a.zeit).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <button
                  onClick={() => setAntworten(prev => prev.filter((_, j) => j !== i))}
                  className="text-zinc-400 hover:text-white font-bold text-lg w-7 h-7 flex items-center justify-center rounded-full hover:bg-zinc-700 transition shrink-0"
                >✕</button>
              </div>
              <div className="px-4 py-3">
                <p className="text-white font-medium leading-snug whitespace-pre-wrap break-words">{a.text}</p>
              </div>
              <div className="px-4 pb-3">
                <button
                  onClick={() => setAntworten(prev => prev.filter((_, j) => j !== i))}
                  className="w-full py-2 rounded-xl text-sm font-bold text-white transition hover:opacity-80"
                  style={{ backgroundColor: farbe }}
                >✓ OK</button>
              </div>
            </div>
          ))}
          {antworten.length > 1 && (
            <button
              onClick={() => setAntworten([])}
              className="pointer-events-auto self-center px-5 py-2 rounded-xl bg-zinc-700 text-white text-sm font-bold shadow-lg hover:bg-zinc-600 transition"
            >
              Alle schließen ({antworten.length})
            </button>
          )}
        </div>
      )}

      {/* Fehler-Banner */}
      {fehler && (
        <div className="bg-red-900/50 text-red-300 text-sm px-5 py-2 text-center">
          Verbindungsfehler: {fehler} – wird automatisch erneut versucht…
        </div>
      )}

      {/* Haupt-Bereich: Aggregations-Spalte links + Bons-Grid rechts */}
      <div className="flex-1 flex overflow-hidden">

        {/* Linke Aggregations-Spalte */}
        <div
          className="w-52 shrink-0 flex flex-col border-r border-zinc-800 overflow-y-auto"
          style={{ background: '#111113' }}
        >
          <div className="px-3 pt-3 pb-2">
            <p className="text-xs font-black uppercase tracking-widest text-zinc-500">
              Offen gesamt
            </p>
          </div>
          {aggregiertArtikel.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-zinc-700 text-sm">–</span>
            </div>
          ) : (
            <div className="flex-1 px-2 pb-3 space-y-1">
              {aggregiertArtikel.map(([bezeichnung, menge]) => (
                <div
                  key={bezeichnung}
                  className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors"
                >
                  <span
                    className="text-base font-black tabular-nums shrink-0 min-w-[2rem] text-right"
                    style={{ color: farbe }}
                  >
                    {menge}×
                  </span>
                  <span className="text-sm text-zinc-200 font-medium leading-tight break-words">
                    {bezeichnung}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

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

    </div>
  )
}
