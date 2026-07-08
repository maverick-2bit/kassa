/**
 * Kartenzahlung am mobilen Gerät — Vollbild-Overlay (Spiegel des
 * KartenzahlungModal der Haupt-App, Touch-Optik der Kellner-App).
 *
 * Schritt 1 „Trinkgeld": Presets / eigener Betrag / Kein.
 * Schritt 2 „Zahlung":   ZVT-Job starten (Betrag + Trinkgeld), 500ms-Polling,
 *                        Abbrechen ruft die Job-Abbruch-API.
 * onErfolg(trinkgeldCent) → der Aufrufer bucht den Tab (karteCent = Betrag,
 * trinkgeldCent separat — das Backend schlägt es der Kartensumme zu).
 */

import { useEffect, useRef, useState } from 'react'
import type { ZvtJob } from '@kassa/shared'
import { zvtApi } from '../lib/api'
import { formatPreis } from '../lib/format'

interface Props {
  kasseId:    string
  betragCent: number
  onErfolg:   (trinkgeldCent: number) => void
  onAbbruch:  () => void
}

const TRINKGELD_PRESETS = [50, 100, 200, 500, 1000]

export function KartenzahlungOverlay({ kasseId, betragCent, onErfolg, onAbbruch }: Props) {
  const [schritt,     setSchritt]     = useState<'trinkgeld' | 'zahlung'>('trinkgeld')
  const [trinkgeld,   setTrinkgeld]   = useState(0)
  const [customInput, setCustomInput] = useState('')
  const [customAktiv, setCustomAktiv] = useState(false)
  const [job,         setJob]         = useState<ZvtJob | null>(null)
  const [fehler,      setFehler]      = useState<string | null>(null)
  const pollRef   = useRef<number | null>(null)
  const jobIdRef  = useRef<string | null>(null)
  const fertigRef = useRef(false)

  // ZVT starten sobald Schritt = 'zahlung'
  useEffect(() => {
    if (schritt !== 'zahlung') return
    fertigRef.current = false
    setFehler(null)
    setJob(null)

    let aktiv = true
    zvtApi.starteZahlung({ kasseId, betragCent: betragCent + trinkgeld })
      .then(({ jobId }) => {
        if (!aktiv) return
        jobIdRef.current = jobId
        starteJobPolling(jobId)
      })
      .catch((err) => { if (aktiv) setFehler(err instanceof Error ? err.message : String(err)) })

    return () => { aktiv = false; stopJobPolling() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt])

  function starteJobPolling(jobId: string) {
    const tick = async () => {
      try {
        const j = await zvtApi.getJob(jobId)
        setJob(j)
        if (j.status === 'erfolg') {
          fertigRef.current = true
          stopJobPolling()
          onErfolg(trinkgeld)
          return
        }
        if (j.status === 'abgebrochen' || j.status === 'fehler') {
          fertigRef.current = true
          stopJobPolling()
          setFehler(j.fehler ?? (j.status === 'abgebrochen' ? 'Abgebrochen' : 'Fehler'))
        }
      } catch (err) {
        setFehler(err instanceof Error ? err.message : String(err))
        stopJobPolling()
      }
    }
    tick()
    pollRef.current = window.setInterval(tick, 500)
  }

  function stopJobPolling() {
    if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
  }

  async function handleAbbrechen() {
    const jobId = jobIdRef.current
    if (jobId && !fertigRef.current) {
      try { await zvtApi.abbrechen(jobId) } catch { /* egal */ }
    }
    stopJobPolling()
    onAbbruch()
  }

  function handleTrinkgeldWeiter() {
    if (customAktiv) {
      const euro = parseFloat(customInput.replace(',', '.'))
      setTrinkgeld(isNaN(euro) || euro < 0 ? 0 : Math.round(euro * 100))
    }
    setSchritt('zahlung')
  }

  const anzeigeTrinkgeld = customAktiv
    ? Math.round((parseFloat(customInput.replace(',', '.')) || 0) * 100)
    : trinkgeld
  const istAktiv  = job && (job.status === 'verbinde' || job.status === 'autorisiere')
  const istFehler = fehler !== null

  return (
    <div className="fixed inset-0 z-50 bg-surface flex flex-col p-5 max-w-lg mx-auto overflow-y-auto">
      <p className="text-center text-2xl font-black text-ink mt-2 mb-4">💳 Kartenzahlung</p>

      <div className="rounded-2xl border border-line bg-panel p-4 text-center mb-4">
        <p className="text-xs uppercase tracking-wide text-ink-subtle">
          {schritt === 'trinkgeld' ? 'Rechnungsbetrag' : 'Zu zahlen'}
        </p>
        <p className="mt-1 text-3xl font-black font-mono text-ink">
          {formatPreis(schritt === 'trinkgeld' ? betragCent : betragCent + trinkgeld)}
        </p>
        {schritt === 'zahlung' && trinkgeld > 0 && (
          <p className="text-xs text-ink-subtle mt-0.5">inkl. {formatPreis(trinkgeld)} Trinkgeld</p>
        )}
      </div>

      {/* ---- Schritt 1: Trinkgeld ---- */}
      {schritt === 'trinkgeld' && (
        <div className="space-y-4">
          <p className="text-sm font-bold text-ink-muted">Trinkgeld</p>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => { setTrinkgeld(0); setCustomAktiv(false); setCustomInput('') }}
              className={`py-3 rounded-xl text-sm font-bold border transition active:scale-95 ${
                trinkgeld === 0 && !customAktiv ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel text-ink border-line-strong'
              }`}
            >
              Kein
            </button>
            {TRINKGELD_PRESETS.map(c => (
              <button
                key={c}
                onClick={() => { setTrinkgeld(c); setCustomAktiv(false); setCustomInput('') }}
                className={`py-3 rounded-xl text-sm font-bold border transition active:scale-95 ${
                  trinkgeld === c && !customAktiv ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel text-ink border-line-strong'
                }`}
              >
                +{formatPreis(c)}
              </button>
            ))}
            <button
              onClick={() => { setCustomAktiv(true); setTrinkgeld(0) }}
              className={`py-3 rounded-xl text-sm font-bold border transition active:scale-95 ${
                customAktiv ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel text-ink border-line-strong'
              }`}
            >
              Betrag…
            </button>
          </div>

          {customAktiv && (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                type="text"
                inputMode="decimal"
                placeholder="0,00"
                value={customInput}
                onChange={e => setCustomInput(e.target.value)}
                className="flex-1 border border-line-strong rounded-xl px-4 py-3 text-lg text-right font-mono bg-panel text-ink focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <span className="text-lg text-ink-muted">€</span>
            </div>
          )}

          {anzeigeTrinkgeld > 0 && (
            <div className="rounded-xl bg-panel border border-line p-3 text-sm space-y-1">
              <div className="flex justify-between text-ink-muted"><span>Rechnung</span><span className="font-mono">{formatPreis(betragCent)}</span></div>
              <div className="flex justify-between text-brand-600 font-bold"><span>Trinkgeld</span><span className="font-mono">{formatPreis(anzeigeTrinkgeld)}</span></div>
              <div className="flex justify-between font-black text-ink border-t border-line pt-1"><span>Gesamt</span><span className="font-mono">{formatPreis(betragCent + anzeigeTrinkgeld)}</span></div>
            </div>
          )}

          <div className="space-y-3 pt-2">
            <button
              onClick={handleTrinkgeldWeiter}
              className="w-full py-4 rounded-2xl bg-brand-600 text-white font-black text-lg active:scale-95 transition"
            >
              Weiter → Terminal
            </button>
            <button
              onClick={onAbbruch}
              className="w-full py-4 rounded-2xl border border-line-strong bg-panel text-ink font-black text-lg active:scale-95 transition"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* ---- Schritt 2: ZVT-Transaktion ---- */}
      {schritt === 'zahlung' && (
        <div className="space-y-4">
          {istAktiv && !istFehler && (
            <div className="rounded-2xl border border-brand-300 bg-brand-50 p-5 flex items-center gap-3">
              <div className="w-6 h-6 border-4 border-brand-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <div>
                <p className="text-sm font-bold text-brand-800">
                  {job?.status === 'verbinde' ? 'Verbinde mit Terminal…' : 'Zahlung am Terminal'}
                </p>
                <p className="text-xs text-brand-600 mt-0.5">{job?.meldung ?? 'Bitte warten…'}</p>
              </div>
            </div>
          )}

          {!job && !istFehler && (
            <div className="rounded-2xl border border-line bg-panel p-5 flex items-center gap-3">
              <div className="w-6 h-6 border-4 border-brand-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-sm font-bold text-ink-muted">Starte Zahlung…</p>
            </div>
          )}

          {istFehler && (
            <div className="rounded-2xl border border-red-300 bg-red-50 p-5 text-sm font-bold text-red-700">
              {fehler}
            </div>
          )}

          {istFehler ? (
            <button
              onClick={handleAbbrechen}
              className="w-full py-4 rounded-2xl border border-line-strong bg-panel text-ink font-black text-lg active:scale-95 transition"
            >
              Schließen
            </button>
          ) : (
            <button
              onClick={handleAbbrechen}
              className="w-full py-4 rounded-2xl border border-line-strong bg-panel text-ink font-black text-lg active:scale-95 transition"
            >
              Abbrechen
            </button>
          )}
        </div>
      )}
    </div>
  )
}
