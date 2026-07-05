import { useState, useCallback, useEffect } from 'react'
import type { KdsBon, KdsPosition } from '../types'
import { bonErledigt, bonTeilbon } from '../api'

interface BonKarteProps {
  bon:     KdsBon
  token:   string
  onErledigt: (bonId: string) => void
}

/** Alter-Badge: grün < 5min, gelb < 10min, rot >= 10min — tickt jede Minute */
function AlterBadge({ erstelltAt }: { erstelltAt: string }) {
  const berechne = () => Math.floor((Date.now() - new Date(erstelltAt).getTime()) / 60_000)
  const [minuten, setMinuten] = useState(berechne)

  useEffect(() => {
    const id = setInterval(() => setMinuten(berechne()), 60_000)
    return () => clearInterval(id)
  }, [erstelltAt])

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

function offeneMenge(pos: KdsPosition): number {
  return pos.menge - (pos.erledigtMenge ?? 0)
}

export function BonKarte({ bon, token, onErledigt }: BonKarteProps) {
  const [positionen, setPositionen] = useState<KdsPosition[]>(bon.positionen)
  const [teilbonModus, setTeilbonModus] = useState(false)
  // Map: positionId → wie viele senden
  const [ausgewaehlt, setAusgewaehlt] = useState<Map<string, number>>(new Map())
  const [loading, setLoading]         = useState(false)

  function setMenge(posId: string, wert: number) {
    setAusgewaehlt(prev => {
      const next = new Map(prev)
      if (wert <= 0) next.delete(posId)
      else           next.set(posId, wert)
      return next
    })
  }

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
    const posMengen = [...ausgewaehlt.entries()]
      .filter(([, m]) => m > 0)
      .map(([id, menge]) => ({ id, menge }))
    if (posMengen.length === 0) return

    setLoading(true)
    try {
      await bonTeilbon(bon.id, posMengen, token)
      // Lokaler Update: erledigtMenge akkumulieren
      setPositionen(prev =>
        prev.map(p => {
          const zuSenden = ausgewaehlt.get(p.id) ?? 0
          if (zuSenden === 0) return p
          const neueErledigtMenge = (p.erledigtMenge ?? 0) + zuSenden
          return {
            ...p,
            erledigtMenge: neueErledigtMenge,
            erledigt:      neueErledigtMenge >= p.menge,
          }
        })
      )
      setAusgewaehlt(new Map())
      setTeilbonModus(false)
    } catch (e) {
      alert('Fehler: ' + (e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }, [bon.id, ausgewaehlt, token])

  const alleErledigt     = positionen.every(p => p.erledigt)
  const totalAusgewaehlt = [...ausgewaehlt.values()].reduce((s, n) => s + n, 0)

  return (
    <div className="bg-panel border border-line rounded-2xl overflow-hidden flex flex-col">

      {/* Header */}
      <div className="bg-panel-2 px-4 py-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-2xl font-black text-ink leading-none">
            {bon.bereich ? `${bon.bereich} / T${bon.tisch}` : `Tisch ${bon.tisch}`}
          </div>
          <div className="text-sm text-ink-muted mt-1">{bon.kellner}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <AlterBadge erstelltAt={bon.erstelltAt} />
          <span className="text-xs text-ink-subtle font-mono">{bon.bonNummer}</span>
        </div>
      </div>

      {/* Positionen */}
      <div className="flex-1 divide-y divide-line">
        {positionen.map(pos => {
          const offen    = offeneMenge(pos)
          const gewaehlt = ausgewaehlt.get(pos.id) ?? 0

          if (!teilbonModus) {
            // Normalmodus: Zeile zeigt offene/gesamt Menge
            return (
              <div
                key={pos.id}
                className={[
                  'w-full text-left px-4 py-3 flex items-center gap-3',
                  pos.erledigt ? 'opacity-40 text-ink-subtle' : 'text-ink',
                ].join(' ')}
              >
                <span className={`text-xl font-black w-12 shrink-0 tabular-nums ${pos.erledigt ? 'text-ink-subtle' : 'text-amber-400'}`}>
                  {pos.erledigt ? (
                    `${pos.menge}×`
                  ) : pos.erledigtMenge ? (
                    <span>
                      <span className="text-ink-subtle line-through text-base">{pos.menge}</span>
                      <span className="text-amber-400">/{offen}×</span>
                    </span>
                  ) : (
                    `${pos.menge}×`
                  )}
                </span>
                <span className={`flex-1 text-lg font-semibold leading-tight ${pos.erledigt ? 'line-through' : ''}`}>
                  {pos.bezeichnung}
                  {pos.details && (
                    <span className="block text-sm font-normal text-ink-muted">{pos.details}</span>
                  )}
                </span>
                {pos.erledigtMenge !== undefined && !pos.erledigt && (
                  <span className="text-xs text-emerald-500 font-bold shrink-0">
                    {pos.erledigtMenge} gesendet
                  </span>
                )}
              </div>
            )
          }

          // Teilbon-Modus
          return (
            <div
              key={pos.id}
              className={[
                'px-4 py-3 flex items-center gap-3',
                pos.erledigt ? 'opacity-40 text-ink-subtle' : 'text-ink',
              ].join(' ')}
            >
              <span className="text-xl font-black w-12 shrink-0 tabular-nums text-amber-400">
                {offen}×
              </span>
              <span className="flex-1 text-lg font-semibold leading-tight">
                {pos.bezeichnung}
                {pos.details && (
                  <span className="block text-sm font-normal text-ink-muted">{pos.details}</span>
                )}
              </span>

              {!pos.erledigt && offen > 0 && (
                offen === 1 ? (
                  // Checkbox bei Einzelstück
                  <button
                    onClick={() => setMenge(pos.id, gewaehlt > 0 ? 0 : 1)}
                    className={`w-7 h-7 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                      gewaehlt > 0 ? 'bg-blue-500 border-blue-500' : 'border-line-strong hover:border-line-strong'
                    }`}
                  >
                    {gewaehlt > 0 && <span className="text-ink text-xs">✓</span>}
                  </button>
                ) : (
                  // Stepper bei mehreren
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setMenge(pos.id, Math.max(0, gewaehlt - 1))}
                      className="w-8 h-8 rounded-lg bg-line hover:bg-line-strong text-ink font-bold text-lg flex items-center justify-center transition-colors"
                    >−</button>
                    <span className={`w-10 text-center font-black tabular-nums text-lg ${gewaehlt > 0 ? 'text-blue-400' : 'text-ink-subtle'}`}>
                      {gewaehlt}
                    </span>
                    <button
                      onClick={() => setMenge(pos.id, Math.min(offen, gewaehlt + 1))}
                      className="w-8 h-8 rounded-lg bg-line hover:bg-line-strong text-ink font-bold text-lg flex items-center justify-center transition-colors"
                    >+</button>
                  </div>
                )
              )}
            </div>
          )
        })}
      </div>

      {/* Aktions-Buttons */}
      <div className="p-3 flex gap-2 bg-panel border-t border-line">
        {!teilbonModus ? (
          <>
            <button
              onClick={() => setTeilbonModus(true)}
              className="flex-1 py-3 rounded-xl bg-line text-ink font-bold text-sm active:bg-line-strong transition-colors"
            >
              Teilbon
            </button>
            <button
              onClick={handleErledigt}
              disabled={loading}
              className={[
                'flex-1 py-3 rounded-xl font-bold text-sm transition-colors',
                alleErledigt
                  ? 'bg-emerald-600 text-ink active:bg-emerald-500'
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
              onClick={() => { setTeilbonModus(false); setAusgewaehlt(new Map()) }}
              className="flex-1 py-3 rounded-xl bg-line text-ink font-bold text-sm active:bg-line-strong"
            >
              Abbrechen
            </button>
            <button
              onClick={handleTeilbon}
              disabled={loading || totalAusgewaehlt === 0}
              className="flex-1 py-3 rounded-xl bg-blue-600 text-ink font-bold text-sm active:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? '…' : `Senden (${totalAusgewaehlt})`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
