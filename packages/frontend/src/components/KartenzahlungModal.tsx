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
  /**
   * Das Terminal hat bezahlt — der Aufrufer bucht. `nachAbbruch`: Der Kassier
   * hatte „Abbrechen" gedrückt, der Gast aber schon bezahlt; der Aufrufer sagt
   * dazu, warum trotzdem ein Beleg entsteht (ABBRUCH_ZU_SPAET).
   */
  onErfolg:   (job: ZvtJob, trinkgeldCent: number, nachAbbruch: boolean) => void
  onAbbruch:  () => void
}

/** Hinweis für den Kassier, wenn „Abbrechen" erst nach der Zahlung am Terminal ankam */
export const ABBRUCH_ZU_SPAET =
  'Abbruch kam zu spät — der Gast hatte am Terminal schon bezahlt, der Beleg wird trotzdem erstellt.'

const TRINKGELD_PRESETS = [50, 100, 200, 500, 1000]

/**
 * Ausgang einer Zahlung, sobald er feststeht: 'erfolg'/'abbruch' = der Aufrufer
 * ist informiert; 'fehler' = die Meldung steht im Dialog (Terminal hat abgelehnt,
 * Start gescheitert), „Schließen" meldet dann den Abbruch.
 */
type Ausgang = 'erfolg' | 'abbruch' | 'fehler'

export function KartenzahlungModal({ open, kasseId, betragCent, onErfolg, onAbbruch }: Props) {
  const [schritt,       setSchritt]       = useState<'trinkgeld' | 'zahlung'>('trinkgeld')
  const [trinkgeld,     setTrinkgeld]     = useState(0)
  const [customInput,   setCustomInput]   = useState('')
  const [customAktiv,   setCustomAktiv]   = useState(false)
  const [job,           setJob]           = useState<ZvtJob | null>(null)
  const [fehler,        setFehler]        = useState<string | null>(null)
  const [bricheAb,      setBricheAb]      = useState(false)   // „Abbrechen" gedrückt, Antwort steht aus
  const pollRef    = useRef<number | null>(null)
  const jobIdRef   = useRef<string | null>(null)
  const ausgangRef = useRef<Ausgang | null>(null)
  const abbruchRef = useRef(false)                 // der Kassier hat abgebrochen
  const abfrageRef = useRef<string | null>(null)   // Job, dessen Abfrage gerade unterwegs ist

  // Beim Schließen zurücksetzen. Beim Öffnen wäre es zu spät: Der Dialog stünde
  // noch auf „zahlung", und der Start-Effekt schickte im selben Durchgang sofort
  // eine Zahlung ans Terminal — vor der Trinkgeld-Wahl, mit dem alten Trinkgeld,
  // und niemand fragte ihren Stand ab.
  useEffect(() => {
    if (open) return
    setSchritt('trinkgeld')
    setTrinkgeld(0)
    setCustomInput('')
    setCustomAktiv(false)
    setJob(null)
    setFehler(null)
    setBricheAb(false)
  }, [open])

  // ZVT starten wenn Schritt = 'zahlung'
  useEffect(() => {
    if (!open || schritt !== 'zahlung') return
    // Neue Zahlung, neuer Job: Antworten zu einer früheren Zahlung tragen deren
    // jobId und laufen ins Leere
    jobIdRef.current   = null
    ausgangRef.current = null
    abbruchRef.current = false
    setFehler(null)
    setJob(null)
    setBricheAb(false)

    let aktiv = true
    zvtApi.starteZahlung({ kasseId, betragCent: betragCent + trinkgeld })
      .then(({ jobId }) => {
        if (!aktiv) {
          // Dialog ist schon weg — das Terminal nicht unbeobachtet kassieren lassen
          zvtApi.abbrechen(jobId).catch(() => {})
          return
        }
        jobIdRef.current = jobId
        // „Abbrechen" kam, bevor die jobId da war: jetzt nachholen
        if (abbruchRef.current) void brecheJobAb(jobId)
        else starteJobPolling(jobId)
      })
      .catch((err) => {
        if (!aktiv) return
        if (abbruchRef.current) {
          // Kein Job angelegt — es gibt nichts abzubrechen
          ausgangRef.current = 'abbruch'
          onAbbruch()
          return
        }
        ausgangRef.current = 'fehler'
        setFehler(err instanceof Error ? err.message : String(err))
      })

    return () => {
      aktiv = false
      stopJobPolling()
      // Der Dialog verschwindet, während das Terminal noch kassieren könnte (Seite
      // verlassen): Job abbrechen, sonst zahlt der Gast und niemand bucht
      const jobId = jobIdRef.current
      if (jobId && ausgangRef.current === null && !abbruchRef.current) {
        zvtApi.abbrechen(jobId).catch(() => {})
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schritt])

  /**
   * Stand des Terminal-Jobs übernehmen — aus der laufenden Abfrage ebenso wie aus
   * der Antwort auf „Abbrechen", und genau einmal je Zahlung. Der Job im Backend
   * ist die Wahrheit: Steht er auf „erfolg", ist die Karte belastet und der Beleg
   * MUSS entstehen, auch wenn der Kassier gerade abbrechen wollte (ein fertiger
   * Job bleibt beim Abbrechen unverändert). true = der Ausgang steht fest.
   */
  function uebernimmJob(j: ZvtJob): boolean {
    // Antwort zu einer früheren Zahlung oder nach feststehendem Ausgang: verwerfen
    if (j.id !== jobIdRef.current || ausgangRef.current !== null) return true
    setJob(j)
    if (j.status === 'erfolg') {
      ausgangRef.current = 'erfolg'
      stopJobPolling()
      onErfolg(j, trinkgeld, abbruchRef.current)
      return true
    }
    if (j.status === 'abgebrochen' || j.status === 'fehler') {
      stopJobPolling()
      if (abbruchRef.current) {
        ausgangRef.current = 'abbruch'
        onAbbruch()
      } else {
        ausgangRef.current = 'fehler'
        setFehler(j.fehler ?? (j.status === 'abgebrochen' ? 'Abgebrochen' : 'Fehler'))
      }
      return true
    }
    return false
  }

  function starteJobPolling(jobId: string) {
    const tick = async () => {
      // Nie zwei Abfragen gleichzeitig: Antwortet das Backend langsamer als der
      // 500-ms-Takt (WLAN, ausgelastete Kasse), stapelten sie sich sonst — und
      // zwei „erfolg" ergaben früher zwei Belege für eine Zahlung.
      if (abfrageRef.current === jobId || ausgangRef.current !== null || abbruchRef.current) return
      abfrageRef.current = jobId
      try {
        uebernimmJob(await zvtApi.getJob(jobId))
      } catch (err) {
        // Stand unbekannt — kein Abbruch: „Schließen" bricht den Job ab und sieht nach
        if (jobId !== jobIdRef.current || ausgangRef.current !== null || abbruchRef.current) return
        stopJobPolling()
        setFehler(err instanceof Error ? err.message : String(err))
      } finally {
        if (abfrageRef.current === jobId) abfrageRef.current = null
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

  /** „Abbrechen" (auch ✕ und Esc), solange die Zahlung läuft oder startet */
  function handleAbbrechen() {
    if (ausgangRef.current !== null || abbruchRef.current) return
    abbruchRef.current = true
    setBricheAb(true)
    stopJobPolling()
    // Ohne jobId läuft der Start noch — er holt den Abbruch nach
    const jobId = jobIdRef.current
    if (jobId) void brecheJobAb(jobId)
  }

  /**
   * Job abbrechen und die Antwort auswerten: Hat der Gast schon bezahlt, lässt das
   * Backend den Job auf „erfolg" — dann wird gebucht, nicht verworfen. Eine Abfrage,
   * die noch unterwegs ist, kann dasselbe melden; es zählt, was zuerst ankommt.
   */
  async function brecheJobAb(jobId: string) {
    let j: ZvtJob | null = null
    try { j = await zvtApi.abbrechen(jobId) } catch { /* unten nachfragen */ }
    if (!j) {
      try { j = await zvtApi.getJob(jobId) } catch { /* Stand unbekannt */ }
    }
    if (j && uebernimmJob(j)) return
    if (jobId !== jobIdRef.current || ausgangRef.current !== null) return
    if (j) {
      // Das Terminal arbeitet noch, der Abbruch kam nicht an: weiter beobachten —
      // erneut abbrechen geht jederzeit
      abbruchRef.current = false
      setBricheAb(false)
      starteJobPolling(jobId)
      return
    }
    // Weder Abbruch noch Stand zu bekommen (Backend weg oder neu gestartet): als
    // Abbruch melden wie bisher — buchen ginge ohne Backend ohnehin nicht
    ausgangRef.current = 'abbruch'
    onAbbruch()
  }

  /** „Schließen" unter einer Fehlermeldung (auch ✕, Esc, Tipp daneben) */
  function handleSchliessen() {
    // Terminal hat abgelehnt oder der Start scheiterte: nichts mehr abzubrechen
    if (ausgangRef.current === 'fehler') {
      ausgangRef.current = 'abbruch'
      onAbbruch()
      return
    }
    // Sonst ist der Stand offen (Abfrage gescheitert): erst abbrechen und nachsehen
    handleAbbrechen()
  }

  function handleTrinkgeldWeiter() {
    if (customAktiv) {
      const euro = parseFloat(customInput.replace(',', '.'))
      setTrinkgeld(isNaN(euro) || euro < 0 ? 0 : Math.round(euro * 100))
    }
    setSchritt('zahlung')
  }

  // ---- UI ----

  const ist_fehler = fehler !== null
  const ist_aktiv  = !ist_fehler && (job?.status === 'verbinde' || job?.status === 'autorisiere')
  const ist_erfolg = job?.status === 'erfolg'
  const startet    = schritt === 'zahlung' && job === null && !ist_fehler

  // Solange das Terminal arbeitet (oder die Zahlung startet), bricht nur
  // „Abbrechen" (oder ✕/Esc) ab — nicht ein Tipp daneben, etwa auf eine
  // abgedunkelte Hinweis-Karte.
  return (
    <Modal
      open={open}
      onClose={schritt === 'trinkgeld' ? onAbbruch : handleSchliessen}
      closeOnBackdrop={schritt === 'trinkgeld' || ist_fehler}
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
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-panel text-ink border-line-strong hover:border-brand-400'
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

          {startet && (
            <div className="rounded-md border border-line bg-panel-2 p-4 flex items-center gap-3">
              <Spinner />
              <p className="text-sm font-medium text-ink-muted">
                {bricheAb ? 'Breche ab …' : 'Starte Zahlung…'}
              </p>
            </div>
          )}

          {ist_aktiv && (
            <div className="rounded-md border border-brand-200 bg-brand-50 p-4 flex items-center gap-3">
              <Spinner />
              <div className="flex-1">
                <p className="text-sm font-medium text-brand-800">
                  {job?.status === 'verbinde' ? 'Verbinde mit Terminal…' : 'Zahlung am Terminal'}
                </p>
                <p className="text-xs text-brand-600 mt-0.5">
                  {bricheAb ? 'Breche ab — frage beim Terminal nach …' : (job?.meldung ?? 'Bitte warten…')}
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

          <div className="flex gap-2 pt-1">
            {(startet || ist_aktiv) && (
              <Button
                variant="secondary"
                onClick={handleAbbrechen}
                loading={bricheAb}
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
