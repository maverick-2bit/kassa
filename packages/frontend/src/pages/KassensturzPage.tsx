/**
 * Kassensturz — Bargeld-Zählung mit Stückelung.
 * Soll = Bar-Umsatz laut Belegen für das gewählte Datum.
 * Ist  = Vom Benutzer gezähltes Bargeld (Stückelungstabelle).
 * Differenz = Ist – Soll.
 */

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { tagesabschlussApi, kassensturzApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'
import { downloadKassensturzPdf } from '../lib/pdf'
import { Button } from '../components/ui/Button'

// ---------------------------------------------------------------------------
// Euro-Stückelung
// ---------------------------------------------------------------------------

interface Stueck {
  label:    string
  wertCent: number
}

const STUECKELUNG: Stueck[] = [
  { label: '€ 500',   wertCent: 50000 },
  { label: '€ 200',   wertCent: 20000 },
  { label: '€ 100',   wertCent: 10000 },
  { label: '€ 50',    wertCent:  5000 },
  { label: '€ 20',    wertCent:  2000 },
  { label: '€ 10',    wertCent:  1000 },
  { label: '€ 5',     wertCent:   500 },
  { label: '€ 2',     wertCent:   200 },
  { label: '€ 1',     wertCent:   100 },
  { label: '50 Cent', wertCent:    50 },
  { label: '20 Cent', wertCent:    20 },
  { label: '10 Cent', wertCent:    10 },
  { label: '5 Cent',  wertCent:     5 },
  { label: '2 Cent',  wertCent:     2 },
  { label: '1 Cent',  wertCent:     1 },
]

function heuteLokal(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

function formatDatumAnzeige(datum: string): string {
  const [y, m, d] = datum.split('-')
  return `${d}.${m}.${y}`
}

// ---------------------------------------------------------------------------
// Hauptkomponente
// ---------------------------------------------------------------------------

export function KassensturzPage() {
  const identity  = getKasseIdentity()!
  const auth      = getAuth()!
  const [datum, setDatum]           = useState(heuteLokal())
  const [stueck, setStueck]         = useState<Record<number, number>>({})
  const [startgeld, setStartgeld]   = useState('')
  const [pdfLaedt, setPdfLaedt]     = useState(false)
  const [pdfFehler, setPdfFehler]   = useState<string | null>(null)

  const { data: ta, isLoading, isError, error } = useQuery({
    queryKey: ['tagesabschluss', identity.kasseId, datum],
    queryFn:  () => tagesabschlussApi.get(identity.kasseId, datum),
    enabled:  !!datum,
  })

  const setStueckCount = (wertCent: number, raw: string) => {
    const n = Math.max(0, parseInt(raw || '0', 10))
    setStueck(prev => ({ ...prev, [wertCent]: n }))
  }

  const istCent      = STUECKELUNG.reduce((s, { wertCent }) => s + (stueck[wertCent] ?? 0) * wertCent, 0)
  const startCent    = Math.round(parseFloat(startgeld.replace(',', '.') || '0') * 100)
  const sollCent     = (ta?.barCent ?? 0) + startCent
  const differenzCent = istCent - sollCent

  const reset = () => {
    setStueck({})
    setStartgeld('')
    setPdfFehler(null)
  }

  /** Gemeinsame Daten für PDF und ESC/POS-Druck */
  function baueEingabe() {
    return {
      kasseId:       identity.kasseId,
      datum,
      istCent,
      sollCent,
      differenzCent,
      startgeldCent: startCent,
      stueck: STUECKELUNG.map(s => ({
        label:     s.label,
        anzahl:    stueck[s.wertCent] ?? 0,
        summeCent: (stueck[s.wertCent] ?? 0) * s.wertCent,
      })),
    }
  }

  // ESC/POS-Druck via Backend (braucht konfigurierten Drucker an der Kasse)
  const druckenMutation = useMutation({
    mutationFn: () => kassensturzApi.drucken(baueEingabe()),
  })

  async function pdfHerunterladen() {
    setPdfLaedt(true)
    setPdfFehler(null)
    try {
      const kasseInfo   = auth.kassen.find(k => k.id === identity.kasseId)
      const bezeichnung = kasseInfo?.bezeichnung ?? kasseInfo?.kassenId ?? identity.kasseId
      await downloadKassensturzPdf(baueEingabe(), auth.mandant.firmenname, bezeichnung)
    } catch (err) {
      setPdfFehler(err instanceof Error ? err.message : 'PDF-Erstellung fehlgeschlagen')
    } finally {
      setPdfLaedt(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Kassensturz</h1>
        <p className="mt-1 text-sm text-ink-muted">Bargeld-Zählung und Soll/Ist-Vergleich</p>
      </div>

      {/* Datum */}
      <div className="rounded-lg bg-panel shadow-sm border border-line p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-sm font-medium text-ink mb-1">Datum</label>
          <input
            type="date"
            value={datum}
            max={heuteLokal()}
            onChange={e => { setDatum(e.target.value); reset() }}
            className="rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink mb-1">
            Startgeld / Wechselgeld
            <span className="ml-1 text-ink-subtle font-normal">(optional)</span>
          </label>
          <div className="flex items-center gap-1">
            <span className="text-ink-muted text-sm">€</span>
            <input
              type="text"
              inputMode="decimal"
              value={startgeld}
              onChange={e => { setStartgeld(e.target.value) }}
              placeholder="0,00"
              className="w-24 rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
            />
          </div>
        </div>
      </div>

      {/* Stückelung */}
      <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
        <div className="px-4 py-3 bg-panel-2 border-b border-line">
          <h2 className="text-sm font-semibold text-ink">Stückelung</h2>
        </div>
        <div className="divide-y divide-line">
          {STUECKELUNG.map(({ label, wertCent }) => {
            const count  = stueck[wertCent] ?? 0
            const gesamt = count * wertCent
            return (
              <div key={wertCent} className="flex items-center gap-3 px-4 py-2">
                <span className="w-20 text-sm font-medium text-ink">{label}</span>
                <span className="text-ink-subtle text-sm">×</span>
                <input
                  type="number"
                  min={0}
                  value={count === 0 ? '' : count}
                  onChange={e => setStueckCount(wertCent, e.target.value)}
                  placeholder="0"
                  className="w-20 rounded-md border border-line-strong px-2 py-1 text-sm text-right focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                />
                <span className="text-ink-subtle text-sm">=</span>
                <span className={`ml-auto text-sm font-mono font-medium ${gesamt > 0 ? 'text-ink' : 'text-ink-subtle'}`}>
                  {formatPreis(gesamt)}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Ergebnis */}
      <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
        <div className="px-4 py-3 bg-panel-2 border-b border-line">
          <h2 className="text-sm font-semibold text-ink">
            Ergebnis — {formatDatumAnzeige(datum)}
          </h2>
        </div>
        <div className="p-4 space-y-3">
          {isLoading && <p className="text-sm text-ink-subtle">Lade Soll-Betrag…</p>}
          {isError && (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : 'Fehler beim Laden'}
            </p>
          )}
          {ta && (
            <div className="space-y-2">
              <ErgebnisZeile label="Gezählt (IST)" wert={istCent} gross />
              {startCent > 0 && (
                <ErgebnisZeile label="davon Startgeld" wert={startCent} klein />
              )}
              <ErgebnisZeile
                label={`Bar-Umsatz laut Belegen (SOLL)${startCent > 0 ? ' inkl. Startgeld' : ''}`}
                wert={sollCent}
                grau
              />
              <div className={`flex items-center justify-between pt-3 border-t border-line text-base font-bold ${
                differenzCent === 0 ? 'text-green-700' :
                differenzCent > 0  ? 'text-blue-700' : 'text-red-700'
              }`}>
                <span>
                  {differenzCent === 0 ? '✓ Ausgeglichen' :
                   differenzCent > 0  ? '⬆ Überschuss'  : '⬇ Fehlbetrag'}
                </span>
                <span className="font-mono">
                  {differenzCent !== 0 && (differenzCent > 0 ? '+' : '')}
                  {formatPreis(Math.abs(differenzCent))}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Aktionen */}
      <div className="flex flex-wrap items-center gap-3">
        {/* PDF */}
        <Button
          variant="secondary"
          onClick={() => void pdfHerunterladen()}
          loading={pdfLaedt}
          disabled={!ta}
        >
          <svg className="h-4 w-4 mr-1.5 inline-block" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
          PDF herunterladen
        </Button>

        {/* ESC/POS-Druck (nur wenn Drucker konfiguriert) */}
        <Button
          onClick={() => druckenMutation.mutate()}
          loading={druckenMutation.isPending}
          disabled={!ta}
        >
          Bon drucken (ESC/POS)
        </Button>

        <Button variant="secondary" onClick={reset}>
          Zurücksetzen
        </Button>

        {druckenMutation.isSuccess && (
          <span className="text-sm text-green-700">✓ Bon gedruckt</span>
        )}
        {druckenMutation.isError && (
          <span className="text-sm text-red-600">
            {druckenMutation.error instanceof Error
              ? druckenMutation.error.message
              : 'Druckfehler'}
          </span>
        )}
        {pdfFehler && <span className="text-sm text-red-600">{pdfFehler}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfskomponenten
// ---------------------------------------------------------------------------

function ErgebnisZeile({ label, wert, gross, grau, klein }: {
  label:  string
  wert:   number
  gross?: boolean
  grau?:  boolean
  klein?: boolean
}) {
  return (
    <div className={`flex items-center justify-between ${klein ? 'opacity-60' : ''}`}>
      <span className={`text-sm ${grau ? 'text-ink-muted' : 'text-ink'}`}>{label}</span>
      <span className={`font-mono ${gross ? 'text-lg font-semibold text-ink' : 'text-sm text-ink-muted'}`}>
        {formatPreis(wert)}
      </span>
    </div>
  )
}
