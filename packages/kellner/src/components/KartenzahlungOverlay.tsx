/**
 * Kartenzahlung am mobilen Gerät — Vollbild-Overlay (Spiegel des
 * KartenzahlungModal der Haupt-App, Touch-Optik der Kellner-App).
 *
 * Schritt 1 „Trinkgeld": Presets / eigener Betrag / Kein.
 * Schritt 2 „Zahlung":   ZVT-Job starten (Betrag + Trinkgeld), 500ms-Polling,
 *                        Abbrechen ruft die Job-Abbruch-API und wertet ihre
 *                        Antwort aus (hatte der Gast schon bezahlt: buchen).
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
  /**
   * Das Terminal hat bezahlt — der Aufrufer bucht. `nachAbbruch`: Der Kellner
   * hatte „Abbrechen" getippt, der Gast aber schon bezahlt (ABBRUCH_ZU_SPAET).
   */
  onErfolg:   (trinkgeldCent: number, nachAbbruch: boolean) => void
  onAbbruch:  () => void
}

/** Hinweis für den Kellner, wenn „Abbrechen" erst nach der Zahlung am Terminal ankam */
export const ABBRUCH_ZU_SPAET =
  'Abbruch kam zu spät — der Gast hatte am Terminal schon bezahlt, der Tisch wird trotzdem abgerechnet.'

const TRINKGELD_PRESETS = [50, 100, 200, 500, 1000]

/**
 * Ausgang der Zahlung, sobald er feststeht: 'erfolg'/'abbruch' = der Aufrufer ist
 * informiert; 'fehler' = die Meldung steht im Overlay, „Schließen" meldet den Abbruch.
 */
type Ausgang = 'erfolg' | 'abbruch' | 'fehler'

export function KartenzahlungOverlay({ kasseId, betragCent, onErfolg, onAbbruch }: Props) {
  const [schritt,     setSchritt]     = useState<'trinkgeld' | 'zahlung'>('trinkgeld')
  const [trinkgeld,   setTrinkgeld]   = useState(0)
  const [customInput, setCustomInput] = useState('')
  const [customAktiv, setCustomAktiv] = useState(false)
  const [job,         setJob]         = useState<ZvtJob | null>(null)
  const [fehler,      setFehler]      = useState<string | null>(null)
  const [bricheAb,    setBricheAb]    = useState(false)   // „Abbrechen" getippt, Antwort steht aus
  const pollRef    = useRef<number | null>(null)
  const jobIdRef   = useRef<string | null>(null)
  const ausgangRef = useRef<Ausgang | null>(null)
  const abbruchRef = useRef(false)                 // der Kellner hat abgebrochen
  const abfrageRef = useRef<string | null>(null)   // Job, dessen Abfrage gerade unterwegs ist

  // ZVT starten sobald Schritt = 'zahlung'
  useEffect(() => {
    if (schritt !== 'zahlung') return
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
          // Overlay ist schon weg — das Terminal nicht unbeobachtet kassieren lassen
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
      // Overlay verschwindet, während das Terminal noch kassieren könnte (Zurück-
      // Geste, Seite verlassen): Job abbrechen, sonst zahlt der Gast und niemand bucht
      const jobId = jobIdRef.current
      if (jobId && ausgangRef.current === null && !abbruchRef.current) {
        zvtApi.abbrechen(jobId).catch(() => {})
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt])

  /**
   * Stand des Terminal-Jobs übernehmen — aus der Abfrage ebenso wie aus der
   * Antwort auf „Abbrechen", genau einmal je Zahlung. Steht der Job auf „erfolg",
   * ist die Karte belastet und der Tisch MUSS abgerechnet werden, auch wenn der
   * Kellner gerade abbrechen wollte. true = der Ausgang steht fest.
   */
  function uebernimmJob(j: ZvtJob): boolean {
    // Antwort zu einer früheren Zahlung oder nach feststehendem Ausgang: verwerfen
    if (j.id !== jobIdRef.current || ausgangRef.current !== null) return true
    setJob(j)
    if (j.status === 'erfolg') {
      ausgangRef.current = 'erfolg'
      stopJobPolling()
      onErfolg(trinkgeld, abbruchRef.current)
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
      // 500-ms-Takt (WLAN), stapelten sie sich sonst — und zwei „erfolg" ergaben
      // früher einen zweiten Bezahl-Aufruf nach erfolgreicher Zahlung.
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
    if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
  }

  /** „Abbrechen", solange die Zahlung läuft oder startet */
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
   * Backend den Job auf „erfolg" — dann wird abgerechnet, nicht verworfen. Eine
   * Abfrage, die noch unterwegs ist, kann dasselbe melden; es zählt die erste.
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
    // Weder Abbruch noch Stand zu bekommen (Backend weg): als Abbruch melden wie
    // bisher — abrechnen ginge ohne Backend ohnehin nicht
    ausgangRef.current = 'abbruch'
    onAbbruch()
  }

  /** „Schließen" unter einer Fehlermeldung */
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

  const anzeigeTrinkgeld = customAktiv
    ? Math.round((parseFloat(customInput.replace(',', '.')) || 0) * 100)
    : trinkgeld
  const istAktiv  = job && (job.status === 'verbinde' || job.status === 'autorisiere')
  const istFehler = fehler !== null
  const istErfolg = job?.status === 'erfolg'

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
                <p className="text-xs text-brand-600 mt-0.5">
                  {bricheAb ? 'Breche ab — frage beim Terminal nach …' : (job?.meldung ?? 'Bitte warten…')}
                </p>
              </div>
            </div>
          )}

          {!job && !istFehler && (
            <div className="rounded-2xl border border-line bg-panel p-5 flex items-center gap-3">
              <div className="w-6 h-6 border-4 border-brand-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-sm font-bold text-ink-muted">{bricheAb ? 'Breche ab …' : 'Starte Zahlung…'}</p>
            </div>
          )}

          {/* Terminal hat bezahlt — der Tisch wird gerade abgerechnet */}
          {istErfolg && (
            <div className="rounded-2xl border border-green-300 bg-green-50 p-5 space-y-1">
              <p className="text-sm font-bold text-green-800">✓ Zahlung erfolgreich — wird gebucht …</p>
              {bricheAb && <p className="text-sm text-green-800">{ABBRUCH_ZU_SPAET}</p>}
            </div>
          )}

          {istFehler && (
            <div className="rounded-2xl border border-red-300 bg-red-50 p-5 text-sm font-bold text-red-700">
              {fehler}
            </div>
          )}

          {istFehler ? (
            <button
              onClick={handleSchliessen}
              className="w-full py-4 rounded-2xl border border-line-strong bg-panel text-ink font-black text-lg active:scale-95 transition"
            >
              Schließen
            </button>
          ) : !istErfolg && (
            <button
              onClick={handleAbbrechen}
              disabled={bricheAb}
              className="w-full py-4 rounded-2xl border border-line-strong bg-panel text-ink font-black text-lg active:scale-95 transition disabled:opacity-50"
            >
              Abbrechen
            </button>
          )}
        </div>
      )}
    </div>
  )
}
