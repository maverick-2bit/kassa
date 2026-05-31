import { useState, useCallback } from 'react'
import type { KdsBon, KdsPosition } from '../types'
import { bonErledigt, bonTeilbon } from '../api'

interface BonKarteProps {
  bon:     KdsBon
  token:   string
  onErledigt: (bonId: string) => void
}

/** Alter-Badge: grün < 5min, gelb < 10min, rot >= 10min */
function AlterBadge({ erstelltAt }: { erstelltAt: string }) {
  const minuten = Math.floor((Date.now() - new Date(erstelltAt).getTime()) / 60_000)
  const [cls, label] =
    minuten < 5  ? ['bg-emerald-700 text-emerald-100', `${minuten}m`] :
    minuten < 10 ? ['bg-amber-600 text-amber-100',   `${minuten}m`] :
                   ['bg-red-600 text-red-100 animate-pulse', `${minuten}m !`]
  return (
    <span className={`px-2 py-0.5 rounded-full text-sm font-bold tabular-nums ${cls}`}>
      {label}
    </span>
  )
}

export function BonKarte({ bon, token, onErledigt }: BonKarteProps) {
  const [positionen, setPositionen] = useState<KdsPosition[]>(bon.positionen)
  const [teilbonModus, setTeilbonModus]  = useState(false)
  const [ausgewaehlt, setAusgewaehlt]    = useState<Set<string>>(new Set())
  const [loading, setLoading]            = useState(false)

  const togglePosition = useCallback((id: string) => {
    if (teilbonModus) {
      setAusgewaehlt(prev => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      })
    } else {
      setPositionen(prev =>
        prev.map(p => p.id === id ? { ...p, erledigt: !p.erledigt } : p)
      )
    }
  }, [teilbonModus])

  const handleErledigt = useCallback(async () => {
    setLoading(true)
    try {
      await bonErledigt(bon.id, token)
      onErledigt(bon.id)
    } catch (e) {
      alert('Fehler beim Speichern: ' + (e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }, [bon.id, token, onErledigt])

  const handleTeilbon = useCallback(async () => {
    if (ausgewaehlt.size === 0) return
    setLoading(true)
    try {
      await bonTeilbon(bon.id, [...ausgewaehlt], token)
      // Ausgewählte Positionen als erledigt markieren
      setPositionen(prev =>
        prev.map(p => ausgewaehlt.has(p.id) ? { ...p, erledigt: true } : p)
      )
      setAusgewaehlt(new Set())
      setTeilbonModus(false)
    } catch (e) {
      alert('Fehler: ' + (e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }, [bon.id, ausgewaehlt, token])

  const alleErledigt = positionen.every(p => p.erledigt)

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-2xl overflow-hidden flex flex-col">

      {/* Header */}
      <div className="bg-zinc-800 px-4 py-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-2xl font-black text-white leading-none">
            {bon.bereich ? `${bon.bereich} / T${bon.tisch}` : `Tisch ${bon.tisch}`}
          </div>
          <div className="text-sm text-zinc-400 mt-1">{bon.kellner}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <AlterBadge erstelltAt={bon.erstelltAt} />
          <span className="text-xs text-zinc-500 font-mono">{bon.bonNummer}</span>
        </div>
      </div>

      {/* Positionen */}
      <div className="flex-1 divide-y divide-zinc-800">
        {positionen.map(pos => {
          const istAusgewaehlt = ausgewaehlt.has(pos.id)
          return (
            <button
              key={pos.id}
              onClick={() => togglePosition(pos.id)}
              className={[
                'w-full text-left px-4 py-3 flex items-center gap-3 transition-colors',
                pos.erledigt
                  ? 'opacity-40 line-through text-zinc-500'
                  : 'text-white active:bg-zinc-700',
                teilbonModus && istAusgewaehlt
                  ? 'bg-blue-900/60'
                  : '',
              ].join(' ')}
            >
              <span className="text-xl font-black w-8 shrink-0 text-amber-400">
                {pos.menge}×
              </span>
              <span className="flex-1 text-lg font-semibold leading-tight">
                {pos.bezeichnung}
                {pos.details && (
                  <span className="block text-sm font-normal text-zinc-400">{pos.details}</span>
                )}
              </span>
              {teilbonModus && !pos.erledigt && (
                <span className={`w-6 h-6 rounded border-2 flex items-center justify-center shrink-0 ${
                  istAusgewaehlt ? 'bg-blue-500 border-blue-500' : 'border-zinc-500'
                }`}>
                  {istAusgewaehlt && <span className="text-white text-xs">✓</span>}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Aktions-Buttons */}
      <div className="p-3 flex gap-2 bg-zinc-850 border-t border-zinc-700">
        {!teilbonModus ? (
          <>
            <button
              onClick={() => setTeilbonModus(true)}
              className="flex-1 py-3 rounded-xl bg-zinc-700 text-zinc-200 font-bold text-sm active:bg-zinc-600 transition-colors"
            >
              Teilbon
            </button>
            <button
              onClick={handleErledigt}
              disabled={loading}
              className={[
                'flex-1 py-3 rounded-xl font-bold text-sm transition-colors',
                alleErledigt
                  ? 'bg-emerald-600 text-white active:bg-emerald-500'
                  : 'bg-emerald-800 text-emerald-200 active:bg-emerald-700',
                loading ? 'opacity-50 cursor-not-allowed' : '',
              ].join(' ')}
            >
              {loading ? '…' : '✓ Erledigt'}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => { setTeilbonModus(false); setAusgewaehlt(new Set()) }}
              className="flex-1 py-3 rounded-xl bg-zinc-700 text-zinc-200 font-bold text-sm active:bg-zinc-600"
            >
              Abbrechen
            </button>
            <button
              onClick={handleTeilbon}
              disabled={loading || ausgewaehlt.size === 0}
              className="flex-1 py-3 rounded-xl bg-blue-600 text-white font-bold text-sm active:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? '…' : `Teilbon (${ausgewaehlt.size})`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
