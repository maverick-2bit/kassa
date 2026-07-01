import { useEffect, useRef, useState } from 'react'
import type { ZvtJob } from '@kassa/shared'
import { zvtApi } from '../lib/api'
import { formatPreis } from '../lib/format'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

interface Props {
  open:       boolean
  kasseId:    string
  betragCent: number
  onErfolg:   (job: ZvtJob, trinkgeldCent: number) => void
  onAbbruch:  () => void
}

const TRINKGELD_PRESETS = [50, 100, 200, 500, 1000]

export function KartenzahlungModal({ open, kasseId, betragCent, onErfolg, onAbbruch }: Props) {
  const [schritt,       setSchritt]       = useState<'trinkgeld' | 'zahlung'>('trinkgeld')
  const [trinkgeld,     setTrinkgeld]     = useState(0)
  const [customInput,   setCustomInput]   = useState('')
  const [customAktiv,   setCustomAktiv]   = useState(false)
  const [job,           setJob]           = useState<ZvtJob | null>(null)
  const [fehler,        setFehler]        = useState<string | null>(null)
  const [busy,          setBusy]          = useState(false)
  const pollRef   = useRef<number | null>(null)
  const jobIdRef  = useRef<string | null>(null)
  const fertigRef = useRef(false)

  // Beim Öffnen: Zustand zurücksetzen
  useEffect(() => {
    if (!open) return
    setSchritt('trinkgeld')
    setTrinkgeld(0)
    setCustomInput('')
    setCustomAktiv(false)
    setJob(null)
    setFehler(null)
    setBusy(false)
    fertigRef.current = false
  }, [open])

  // ZVT starten wenn Schritt = 'zahlung'
  useEffect(() => {
    if (!open || schritt !== 'zahlung') return
    fertigRef.current = false
    setFehler(null)
    setJob(null)

    let aktiv = true
    setBusy(true)
    zvtApi.starteZahlung({ kasseId, betragCent: betragCent + trinkgeld })
      .then(({ jobId }) => {
        if (!aktiv) return
        jobIdRef.current = jobId
        starteJobPolling(jobId)
      })
      .catch((err) => {
        if (!aktiv) return
        setFehler(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })

    return () => {
      aktiv = false
      stopJobPolling()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schritt])

  function starteJobPolling(jobId: string) {
    const tick = async () => {
      try {
        const j = await zvtApi.getJob(jobId)
        setJob(j)
        if (j.status === 'erfolg') {
          fertigRef.current = true
          stopJobPolling()
          setBusy(false)
          onErfolg(j, trinkgeld)
          return
        }
        if (j.status === 'abgebrochen' || j.status === 'fehler') {
          fertigRef.current = true
          stopJobPolling()
          setBusy(false)
          setFehler(j.fehler ?? (j.status === 'abgebrochen' ? 'Abgebrochen' : 'Fehler'))
          return
        }
      } catch (err) {
        setFehler(err instanceof Error ? err.message : String(err))
        stopJobPolling()
        setBusy(false)
      }
    }
    tick()
    pollRef.current = window.setInterval(tick, 500)
  }

  function stopJobPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  async function handleAbbrechen() {
    const jobId = jobIdRef.current
    if (jobId && !fertigRef.current) {
      try { await zvtApi.abbrechen(jobId) } catch { /* egal */ }
    }
    stopJobPolling()
    setBusy(false)
    onAbbruch()
  }

  function handleSchliessen() {
    stopJobPolling()
    setBusy(false)
    onAbbruch()
  }

  function handleTrinkgeldWeiter() {
    if (customAktiv) {
      const euro = parseFloat(customInput.replace(',', '.'))
      setTrinkgeld(isNaN(euro) || euro < 0 ? 0 : Math.round(euro * 100))
    }
    setSchritt('zahlung')
  }

  // ---- UI ----

  const ist_aktiv  = job && (job.status === 'verbinde' || job.status === 'autorisiere')
  const ist_fehler = fehler !== null || (job && (job.status === 'fehler' || job.status === 'abgebrochen'))
  const ist_erfolg = job?.status === 'erfolg'

  return (
    <Modal
      open={open}
      onClose={schritt === 'trinkgeld' ? onAbbruch : ist_fehler ? handleSchliessen : handleAbbrechen}
      title="Kartenzahlung"
    >
      {/* ---- Schritt 1: Trinkgeld ---- */}
      {schritt === 'trinkgeld' && (
        <div className="space-y-5">
          <div className="rounded-lg border border-line bg-panel-2 p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-ink-muted">Rechnungsbetrag</p>
            <p className="mt-1 text-3xl font-bold text-ink">{formatPreis(betragCent)}</p>
          </div>

          <div>
            <p className="text-sm font-medium text-ink mb-2">Trinkgeld</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => { setTrinkgeld(0); setCustomAktiv(false); setCustomInput('') }}
                className={`px-3 py-2 rounded-lg text-sm font-semibold border transition ${
                  trinkgeld === 0 && !customAktiv
                    ? 'bg-gray-800 text-white border-gray-800'
                    : 'bg-panel text-ink border-line-strong hover:border-gray-500'
                }`}
              >
                Kein
              </button>
              {TRINKGELD_PRESETS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setTrinkgeld(c); setCustomAktiv(false); setCustomInput('') }}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold border transition ${
                    trinkgeld === c && !customAktiv
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'bg-panel text-ink border-line-strong hover:border-brand-400'
                  }`}
                >
                  +{formatPreis(c)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setCustomAktiv(true); setTrinkgeld(0) }}
                className={`px-3 py-2 rounded-lg text-sm font-semibold border transition ${
                  customAktiv
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-panel text-ink border-line-strong hover:border-brand-400'
                }`}
              >
                Betrag…
              </button>
            </div>
            {customAktiv && (
              <div className="mt-3 flex items-center gap-2">
                <input
                  autoFocus
                  type="text"
                  inputMode="decimal"
                  placeholder="0,00"
                  value={customInput}
                  onChange={e => setCustomInput(e.target.value)}
                  className="w-32 border border-line-strong rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <span className="text-sm text-ink-muted">€</span>
              </div>
            )}
          </div>

          {(trinkgeld > 0 || (customAktiv && customInput)) && (
            <div className="rounded-lg bg-brand-50 border border-brand-200 p-3 text-sm">
              <div className="flex justify-between text-ink-muted">
                <span>Rechnung</span><span>{formatPreis(betragCent)}</span>
              </div>
              <div className="flex justify-between text-brand-700 font-medium">
                <span>Trinkgeld</span>
                <span>
                  {customAktiv
                    ? formatPreis(Math.round((parseFloat(customInput.replace(',', '.')) || 0) * 100))
                    : formatPreis(trinkgeld)}
                </span>
              </div>
              <div className="flex justify-between font-bold text-ink border-t border-brand-200 mt-1 pt-1">
                <span>Gesamt</span>
                <span>
                  {customAktiv
                    ? formatPreis(betragCent + Math.round((parseFloat(customInput.replace(',', '.')) || 0) * 100))
                    : formatPreis(betragCent + trinkgeld)}
                </span>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={onAbbruch} className="flex-1">
              Abbrechen
            </Button>
            <Button onClick={handleTrinkgeldWeiter} className="flex-1">
              Weiter →
            </Button>
          </div>
        </div>
      )}

      {/* ---- Schritt 2: ZVT-Transaktion ---- */}
      {schritt === 'zahlung' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-panel-2 p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-ink-muted">Zu zahlen</p>
            <p className="mt-1 text-3xl font-bold text-ink">{formatPreis(betragCent + trinkgeld)}</p>
            {trinkgeld > 0 && (
              <p className="text-xs text-ink-muted mt-0.5">
                inkl. {formatPreis(trinkgeld)} Trinkgeld
              </p>
            )}
          </div>

          {ist_aktiv && (
            <div className="rounded-md border border-brand-200 bg-brand-50 p-4 flex items-center gap-3">
              <Spinner />
              <div className="flex-1">
                <p className="text-sm font-medium text-brand-800">
                  {job?.status === 'verbinde' ? 'Verbinde mit Terminal…' : 'Zahlung am Terminal'}
                </p>
                <p className="text-xs text-brand-600 mt-0.5">{job?.meldung ?? 'Bitte warten…'}</p>
              </div>
            </div>
          )}

          {ist_erfolg && (
            <div className="rounded-md border border-green-200 bg-green-50 p-4">
              <p className="text-sm font-medium text-green-800">✓ Zahlung erfolgreich</p>
              {job?.ergebnis && (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-green-700">
                  {job.ergebnis.kartenmarke && <><dt className="font-medium">Karte</dt><dd>{job.ergebnis.kartenmarke}</dd></>}
                  {job.ergebnis.traceNummer && <><dt className="font-medium">Trace</dt><dd className="font-mono">{job.ergebnis.traceNummer}</dd></>}
                  {job.ergebnis.belegnummer && <><dt className="font-medium">Beleg-Nr.</dt><dd className="font-mono">{job.ergebnis.belegnummer}</dd></>}
                </dl>
              )}
            </div>
          )}

          {ist_fehler && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {fehler ?? job?.fehler ?? 'Unbekannter Fehler'}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            {ist_aktiv && (
              <Button
                variant="secondary"
                onClick={handleAbbrechen}
                loading={busy && fertigRef.current}
                className="flex-1"
              >
                Abbrechen
              </Button>
            )}
            {ist_fehler && (
              <Button onClick={handleSchliessen} className="flex-1">Schließen</Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function Spinner() {
  return (
    <svg className="h-5 w-5 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
