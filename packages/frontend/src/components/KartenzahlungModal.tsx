import { useEffect, useRef, useState } from 'react'
import type { ZvtJob } from '@kassa/shared'
import { zvtApi } from '../lib/api'
import { formatPreis } from '../lib/format'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

interface Props {
  open:        boolean
  kasseId:     string
  betragCent:  number
  /** Aufgerufen wenn Zahlung erfolgreich war — Aufrufer erstellt dann den Beleg. */
  onErfolg:    (job: ZvtJob) => void
  /** Aufgerufen bei Abbruch oder Fehler. Beleg darf NICHT erstellt werden. */
  onAbbruch:   () => void
}

export function KartenzahlungModal({ open, kasseId, betragCent, onErfolg, onAbbruch }: Props) {
  const [job, setJob]         = useState<ZvtJob | null>(null)
  const [fehler, setFehler]   = useState<string | null>(null)
  const [busy, setBusy]       = useState(false)
  const pollRef               = useRef<number | null>(null)
  const jobIdRef              = useRef<string | null>(null)
  const fertigRef             = useRef(false)

  // Beim Öffnen: Job starten
  useEffect(() => {
    if (!open) return
    fertigRef.current = false
    setFehler(null)
    setJob(null)

    let aktiv = true
    setBusy(true)
    zvtApi.starteZahlung({ kasseId, betragCent })
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
  }, [open, kasseId, betragCent])

  function starteJobPolling(jobId: string) {
    const tick = async () => {
      try {
        const j = await zvtApi.getJob(jobId)
        setJob(j)
        if (j.status === 'erfolg') {
          fertigRef.current = true
          stopJobPolling()
          setBusy(false)
          onErfolg(j)
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
    // Wenn schon ein Job läuft → Server-seitig abbrechen
    const jobId = jobIdRef.current
    if (jobId && !fertigRef.current) {
      try { await zvtApi.abbrechen(jobId) } catch { /* egal — wir schließen trotzdem */ }
    }
    stopJobPolling()
    setBusy(false)
    onAbbruch()
  }

  async function handleSchliessen() {
    stopJobPolling()
    setBusy(false)
    onAbbruch()
  }

  // ----- UI -----

  const ist_aktiv = job && (job.status === 'verbinde' || job.status === 'autorisiere')
  const ist_fehler = fehler !== null || (job && (job.status === 'fehler' || job.status === 'abgebrochen'))
  const ist_erfolg = job?.status === 'erfolg'

  return (
    <Modal
      open={open}
      onClose={ist_fehler ? handleSchliessen : handleAbbrechen}
      title="Kartenzahlung"
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-gray-500">Zu zahlen</p>
          <p className="mt-1 text-3xl font-bold text-gray-900">{formatPreis(betragCent)}</p>
        </div>

        {/* Status-Anzeige */}
        {ist_aktiv && (
          <div className="rounded-md border border-brand-200 bg-brand-50 p-4 flex items-center gap-3">
            <Spinner />
            <div className="flex-1">
              <p className="text-sm font-medium text-brand-800">
                {job?.status === 'verbinde' ? 'Verbinde mit Terminal…' : 'Zahlung am Terminal'}
              </p>
              <p className="text-xs text-brand-600 mt-0.5">
                {job?.meldung ?? 'Bitte warten…'}
              </p>
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

        {/* Aktionsbereich */}
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
            <Button onClick={handleSchliessen} className="flex-1">
              Schließen
            </Button>
          )}
        </div>
      </div>
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
