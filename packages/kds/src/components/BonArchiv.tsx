import { useState, useEffect, useCallback } from 'react'
import type { KdsStation } from '../types'
import { STATION_LABELS, STATION_FARBEN } from '../types'
import { ladeArchiv, bonNachdrucken, type ArchivBon } from '../api'

const LIMIT = 50

interface DruckStatus {
  bonId:   string
  loading: boolean
  result?: { gedruckt: number; fehler: number }
}

interface BonArchivProps {
  station:   KdsStation
  token:     string
  farbe:     string
  onZurueck: () => void
}

function stationLabel(s: string): string {
  return STATION_LABELS[s as KdsStation] ?? s
}

function formatZeit(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('de-AT', {
    day:    '2-digit',
    month:  '2-digit',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  })
}

function StatusBadge({ status }: { status: string }) {
  return status === 'erledigt' ? (
    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-900 text-emerald-300">
      Erledigt
    </span>
  ) : (
    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-900 text-amber-300">
      Offen
    </span>
  )
}

export function BonArchiv({ station, token, farbe, onZurueck }: BonArchivProps) {
  const [bons, setBons]           = useState<ArchivBon[]>([])
  const [loading, setLoading]     = useState(true)
  const [fehler, setFehler]       = useState<string | null>(null)
  const [hatMehr, setHatMehr]     = useState(false)
  const [offset, setOffset]       = useState(0)
  const [stationFilter, setStationFilter] = useState<string>(station)
  const [druckStatus, setDruckStatus]     = useState<Map<string, DruckStatus>>(new Map())

  const laden = useCallback(async (neu: boolean, off: number, stFilter: string) => {
    setLoading(true)
    setFehler(null)
    try {
      const data = await ladeArchiv(token, stFilter || undefined, LIMIT, off)
      setBons(prev => neu ? data : [...prev, ...data])
      setHatMehr(data.length === LIMIT)
      setOffset(off + data.length)
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Fehler beim Laden')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    setBons([])
    setOffset(0)
    laden(true, 0, stationFilter)
  }, [stationFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNachdrucken = async (bonId: string) => {
    setDruckStatus(prev => new Map(prev).set(bonId, { bonId, loading: true }))
    try {
      const result = await bonNachdrucken(bonId, token)
      setDruckStatus(prev => new Map(prev).set(bonId, { bonId, loading: false, result }))
      // Status nach 4s ausblenden
      setTimeout(() => {
        setDruckStatus(prev => {
          const next = new Map(prev)
          next.delete(bonId)
          return next
        })
      }, 4000)
    } catch (e) {
      setDruckStatus(prev => new Map(prev).set(bonId, {
        bonId, loading: false, result: { gedruckt: 0, fehler: 1 },
      }))
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">

      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-3 shrink-0"
        style={{ borderBottom: `3px solid ${farbe}` }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={onZurueck}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-sm font-bold transition"
          >
            ← Zurück
          </button>
          <span className="font-black text-xl" style={{ color: farbe }}>
            Bon-Archiv
          </span>
        </div>

        {/* Stations-Filter */}
        <div className="flex gap-1.5">
          {(['', ...Object.keys(STATION_LABELS)] as string[]).map(s => {
            const aktiv = stationFilter === s
            const fc    = s ? STATION_FARBEN[s as KdsStation] : '#6b7280'
            return (
              <button
                key={s || 'alle'}
                onClick={() => setStationFilter(s)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition"
                style={{
                  backgroundColor: aktiv ? fc : '#27272a',
                  color:           aktiv ? '#fff' : '#a1a1aa',
                  outline:         aktiv ? `2px solid ${fc}` : 'none',
                  outlineOffset:   '1px',
                }}
              >
                {s ? stationLabel(s) : 'Alle'}
              </button>
            )
          })}
        </div>
      </div>

      {/* Liste */}
      <div className="flex-1 overflow-auto p-4 space-y-3">

        {fehler && (
          <div className="bg-red-900/40 border border-red-700 text-red-300 px-4 py-3 rounded-xl text-sm">
            {fehler}
          </div>
        )}

        {!loading && bons.length === 0 && !fehler && (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-zinc-600">
            <div className="text-5xl">📋</div>
            <div className="text-lg font-bold">Keine Bons im Archiv</div>
          </div>
        )}

        {bons.map(bon => {
          const ds = druckStatus.get(bon.id)
          const fc = STATION_FARBEN[bon.station as KdsStation] ?? '#6b7280'

          return (
            <div
              key={bon.id}
              className="bg-zinc-900 border border-zinc-700 rounded-2xl overflow-hidden"
            >
              {/* Bon-Header */}
              <div className="bg-zinc-800 px-4 py-3 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-lg font-black text-white">
                      {bon.bereich ? `${bon.bereich} / Tisch ${bon.tisch}` : `Tisch ${bon.tisch}`}
                    </span>
                    <StatusBadge status={bon.status} />
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-bold"
                      style={{ backgroundColor: fc + '33', color: fc }}
                    >
                      {stationLabel(bon.station)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-sm text-zinc-400">
                    <span>{bon.kellner}</span>
                    <span className="font-mono text-zinc-600">{bon.bonNummer}</span>
                    <span>{formatZeit(bon.erstelltAt)}</span>
                  </div>
                </div>

                {/* Nachdrucken-Button */}
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <button
                    onClick={() => handleNachdrucken(bon.id)}
                    disabled={ds?.loading}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm font-bold transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ds?.loading ? '⏳' : '🖨'} Nachdrucken
                  </button>
                  {ds?.result && (
                    <span className={`text-xs font-bold ${ds.result.gedruckt > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {ds.result.gedruckt > 0
                        ? `✓ ${ds.result.gedruckt} Drucker`
                        : '✗ Kein Drucker erreichbar'}
                    </span>
                  )}
                </div>
              </div>

              {/* Positionen */}
              <div className="divide-y divide-zinc-800">
                {bon.positionen.map((pos, i) => {
                  const offen = pos.menge - (pos.erledigtMenge ?? 0)
                  return (
                    <div
                      key={pos.id ?? i}
                      className={`px-4 py-2.5 flex items-start gap-3 ${pos.erledigt ? 'opacity-40' : ''}`}
                    >
                      <span className="text-amber-400 font-black w-10 shrink-0 tabular-nums">
                        {pos.erledigtMenge !== undefined && !pos.erledigt
                          ? `${offen}/${pos.menge}×`
                          : `${pos.menge}×`}
                      </span>
                      <span className={`flex-1 text-sm font-medium ${pos.erledigt ? 'line-through text-zinc-500' : 'text-zinc-200'}`}>
                        {pos.bezeichnung}
                        {pos.details && (
                          <span className="block text-xs text-zinc-500 font-normal">{pos.details}</span>
                        )}
                      </span>
                      {pos.erledigt && (
                        <span className="text-xs text-emerald-600 font-bold shrink-0">✓</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Mehr laden */}
        {hatMehr && !loading && (
          <button
            onClick={() => laden(false, offset, stationFilter)}
            className="w-full py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-bold transition"
          >
            Weitere laden…
          </button>
        )}

        {loading && (
          <div className="text-center text-zinc-600 py-8 text-sm">
            Wird geladen…
          </div>
        )}
      </div>
    </div>
  )
}
