import { useState, useMemo } from 'react'
import type { KdsBon } from '../types'

const FARB_PALETTE = [
  '#ef4444', // Rot
  '#f97316', // Orange
  '#eab308', // Gelb
  '#22c55e', // Grün
  '#3b82f6', // Blau
  '#8b5cf6', // Lila
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#f4f4f5', // Weiß
  '#71717a', // Grau
]

interface TileKonfig {
  farbe:   string
  fixiert: boolean
}

interface GrossKonf {
  reihenfolge: string[]
  konfig:      Record<string, TileKonfig>
}

function ladeKonfig(station: string): GrossKonf {
  try {
    const raw = localStorage.getItem(`kds-gross-${station}`)
    if (raw) return JSON.parse(raw) as GrossKonf
  } catch {}
  return { reihenfolge: [], konfig: {} }
}

function speichereKonfig(station: string, conf: GrossKonf) {
  localStorage.setItem(`kds-gross-${station}`, JSON.stringify(conf))
}

interface GrossAnzeigeProps {
  bons:      KdsBon[]
  station:   string
  farbe:     string   // Stations-Farbe als Fallback
  onZurueck: () => void
}

export function GrossAnzeige({ bons, station, farbe, onZurueck }: GrossAnzeigeProps) {
  const [konfig, setKonfig]               = useState<GrossKonf>(() => ladeKonfig(station))
  const [bearbeitenModus, setBearbeitenModus] = useState(false)
  const [farbwaehlerFuer, setFarbwaehlerFuer] = useState<string | null>(null)

  // Offene Mengen pro Artikel-Key
  const mengenMap = useMemo(() => {
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
    return map
  }, [bons])

  // Sichtbare Tiles in der gespeicherten Reihenfolge
  const activeTiles = useMemo(() => {
    const bekannt = new Set(konfig.reihenfolge)
    const result: string[] = []

    for (const key of konfig.reihenfolge) {
      const menge    = mengenMap.get(key) ?? 0
      const fixiert  = konfig.konfig[key]?.fixiert ?? false
      if (menge > 0 || fixiert) result.push(key)
    }

    for (const [key, menge] of mengenMap) {
      if (!bekannt.has(key) && menge > 0) result.push(key)
    }

    return result
  }, [mengenMap, konfig])

  function updateKonfig(next: GrossKonf) {
    setKonfig(next)
    speichereKonfig(station, next)
  }

  function verschiebeLinks(key: string) {
    const tiles = [...activeTiles]
    const idx = tiles.indexOf(key)
    if (idx <= 0) return
    ;[tiles[idx - 1], tiles[idx]] = [tiles[idx], tiles[idx - 1]]
    updateKonfig({ ...konfig, reihenfolge: tiles })
  }

  function verschiebeRechts(key: string) {
    const tiles = [...activeTiles]
    const idx = tiles.indexOf(key)
    if (idx < 0 || idx >= tiles.length - 1) return
    ;[tiles[idx], tiles[idx + 1]] = [tiles[idx + 1], tiles[idx]]
    updateKonfig({ ...konfig, reihenfolge: tiles })
  }

  function toggleFixiert(key: string) {
    const current = konfig.konfig[key] ?? { farbe, fixiert: false }
    const naechsteReihenfolge = konfig.reihenfolge.includes(key)
      ? konfig.reihenfolge
      : [...konfig.reihenfolge, key]
    updateKonfig({
      reihenfolge: naechsteReihenfolge,
      konfig: {
        ...konfig.konfig,
        [key]: { ...current, fixiert: !current.fixiert },
      },
    })
  }

  function setzeFarbe(key: string, neueFarbe: string) {
    const current = konfig.konfig[key] ?? { farbe, fixiert: false }
    updateKonfig({
      ...konfig,
      konfig: {
        ...konfig.konfig,
        [key]: { ...current, farbe: neueFarbe },
      },
    })
    setFarbwaehlerFuer(null)
  }

  const tileFarbe = (key: string) => konfig.konfig[key]?.farbe ?? farbe
  const istFixiert = (key: string) => konfig.konfig[key]?.fixiert ?? false

  return (
    <div className="min-h-screen bg-surface text-ink flex flex-col">

      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-3 shrink-0"
        style={{ borderBottom: `3px solid ${farbe}` }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={onZurueck}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel-2 hover:bg-line text-ink-muted hover:text-ink text-sm font-bold transition"
          >
            ← Zurück
          </button>
          <span className="font-black text-xl" style={{ color: farbe }}>
            Großanzeige
          </span>
        </div>
        <button
          onClick={() => setBearbeitenModus(v => !v)}
          className={[
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition',
            bearbeitenModus
              ? 'bg-amber-500 text-black'
              : 'bg-line text-ink hover:bg-line-strong',
          ].join(' ')}
        >
          {bearbeitenModus ? '✓ Fertig' : '✏ Bearbeiten'}
        </button>
      </div>

      {/* Tile-Grid */}
      <div className="flex-1 p-4 overflow-auto">
        {activeTiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-ink-subtle">
            <div className="text-6xl">✓</div>
            <div className="text-xl font-bold">Keine offenen Bestellungen</div>
          </div>
        ) : (
          <div
            className="grid gap-4 h-full"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              alignContent: 'start',
            }}
          >
            {activeTiles.map((key, idx) => {
              const menge   = mengenMap.get(key) ?? 0
              const fc      = tileFarbe(key)
              const fixiert = istFixiert(key)
              const letzter = idx === activeTiles.length - 1

              return (
                <div
                  key={key}
                  className="relative rounded-2xl overflow-hidden flex flex-col items-center justify-center select-none"
                  style={{
                    minHeight: '180px',
                    background: `${fc}15`,
                    border: `2px solid ${fc}40`,
                  }}
                >
                  {/* Inhalt */}
                  <div
                    className="text-9xl font-black tabular-nums leading-none"
                    style={{ color: menge === 0 ? '#3f3f46' : fc }}
                  >
                    {menge}
                  </div>
                  <div className="text-center text-4xl font-bold text-ink mt-3 px-3 leading-tight max-w-full break-words">
                    {key}
                  </div>
                  {fixiert && !bearbeitenModus && (
                    <div className="absolute top-2 right-2 text-xs text-ink-subtle">📌</div>
                  )}

                  {/* Bearbeiten-Overlay */}
                  {bearbeitenModus && (
                    <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-between p-3 gap-2">

                      {/* Reihenfolge-Buttons */}
                      <div className="flex items-center gap-2 w-full justify-between">
                        <button
                          onClick={() => verschiebeLinks(key)}
                          disabled={idx === 0}
                          className="w-12 h-12 rounded-xl bg-line hover:bg-line-strong disabled:opacity-30 disabled:cursor-not-allowed text-ink text-xl font-bold flex items-center justify-center transition"
                        >
                          ←
                        </button>
                        <button
                          onClick={() => toggleFixiert(key)}
                          title={fixiert ? 'Fixierung aufheben' : 'Position fixieren'}
                          className={[
                            'flex-1 h-12 rounded-xl font-bold text-sm transition flex items-center justify-center gap-1',
                            fixiert
                              ? 'bg-amber-500 text-black'
                              : 'bg-line hover:bg-line-strong text-ink-muted',
                          ].join(' ')}
                        >
                          {fixiert ? '📌 Fixiert' : '📍 Fixieren'}
                        </button>
                        <button
                          onClick={() => verschiebeRechts(key)}
                          disabled={letzter}
                          className="w-12 h-12 rounded-xl bg-line hover:bg-line-strong disabled:opacity-30 disabled:cursor-not-allowed text-ink text-xl font-bold flex items-center justify-center transition"
                        >
                          →
                        </button>
                      </div>

                      {/* Aktuell gewählte Farbe + Farbe-Button */}
                      <button
                        onClick={() => setFarbwaehlerFuer(key)}
                        className="w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition hover:opacity-90"
                        style={{ backgroundColor: fc, color: '#000' }}
                      >
                        <span>🎨</span>
                        <span>Farbe ändern</span>
                      </button>

                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Farbwähler-Modal */}
      {farbwaehlerFuer !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
          onClick={() => setFarbwaehlerFuer(null)}
        >
          <div
            className="bg-panel rounded-2xl p-6 shadow-2xl border border-line"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-ink-muted text-sm font-semibold mb-4 text-center">
              Farbe für <span className="text-ink font-bold">{farbwaehlerFuer}</span>
            </p>
            <div className="grid grid-cols-5 gap-3">
              {FARB_PALETTE.map(c => {
                const aktiv = tileFarbe(farbwaehlerFuer) === c
                return (
                  <button
                    key={c}
                    onClick={() => setzeFarbe(farbwaehlerFuer, c)}
                    className="w-14 h-14 rounded-xl flex items-center justify-center transition hover:scale-110"
                    style={{
                      backgroundColor: c,
                      outline: aktiv ? `3px solid #fff` : 'none',
                      outlineOffset: '2px',
                    }}
                  >
                    {aktiv && <span className="text-black font-black text-lg">✓</span>}
                  </button>
                )
              })}
            </div>
            <button
              onClick={() => setFarbwaehlerFuer(null)}
              className="mt-5 w-full py-3 rounded-xl bg-line hover:bg-line-strong text-ink font-bold text-sm transition"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
