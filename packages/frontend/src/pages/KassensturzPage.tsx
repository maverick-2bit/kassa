/**
 * Kassensturz — Bargeld-Zählung mit Stückelung.
 * Soll = Bar-Umsatz laut Belegen für das gewählte Datum.
 * Ist  = Vom Benutzer gezähltes Bargeld (Stückelungstabelle).
 * Differenz = Ist – Soll.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { tagesabschlussApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
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
  const [datum, setDatum]       = useState(heuteLokal())
  const [stueck, setStueck]     = useState<Record<number, number>>({})
  const [startgeld, setStartgeld] = useState('')   // optionales Wechselgeld am Beginn
  const [gedruckt, setGedruckt] = useState(false)

  const { data: ta, isLoading, isError, error } = useQuery({
    queryKey: ['tagesabschluss', identity.kasseId, datum],
    queryFn:  () => tagesabschlussApi.get(identity.kasseId, datum),
    enabled:  !!datum,
  })

  const setStueckCount = (wertCent: number, raw: string) => {
    const n = Math.max(0, parseInt(raw || '0', 10))
    setStueck(prev => ({ ...prev, [wertCent]: n }))
    setGedruckt(false)
  }

  const istCent      = STUECKELUNG.reduce((s, { wertCent }) => s + (stueck[wertCent] ?? 0) * wertCent, 0)
  const startCent    = Math.round(parseFloat(startgeld.replace(',', '.') || '0') * 100)
  const sollCent     = (ta?.barCent ?? 0) + startCent
  const differenzCent = istCent - sollCent

  const reset = () => {
    setStueck({})
    setStartgeld('')
    setGedruckt(false)
  }

  const drucken = () => {
    const zeilen = STUECKELUNG
      .filter(s => (stueck[s.wertCent] ?? 0) > 0)
      .map(s => `${s.label.padEnd(10)} × ${String(stueck[s.wertCent]).padStart(4)}  =  ${formatPreis(s.wertCent * (stueck[s.wertCent] ?? 0))}`)
      .join('\n')

    const text = [
      '================================',
      '          KASSENSTURZ',
      `Datum:   ${formatDatumAnzeige(datum)}`,
      `Kasse:   ${identity.kasseId}`,
      '================================',
      '',
      'STÜCKELUNG:',
      zeilen || '  (keine Eingabe)',
      '',
      '--------------------------------',
      `IST:       ${formatPreis(istCent)}`,
      startCent > 0 ? `Startgeld: ${formatPreis(startCent)}` : null,
      `SOLL:      ${formatPreis(sollCent)}`,
      `DIFFERENZ: ${differenzCent >= 0 ? '+' : ''}${formatPreis(differenzCent)}`,
      '',
      differenzCent === 0
        ? '✓ Kassensturz ausgeglichen'
        : differenzCent > 0
          ? `⚠ Überschuss: ${formatPreis(differenzCent)}`
          : `⚠ Fehlbetrag: ${formatPreis(Math.abs(differenzCent))}`,
      '================================',
    ].filter(l => l !== null).join('\n')

    const win = window.open('', '_blank', 'width=400,height=600')
    if (!win) return
    win.document.write(`<html><head><title>Kassensturz ${formatDatumAnzeige(datum)}</title>
      <style>body{font-family:monospace;white-space:pre;padding:20px;font-size:13px}
      @media print{@page{size:80mm auto;margin:5mm}}</style></head>
      <body>${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
      <script>window.onload=()=>window.print()</script></body></html>`)
    win.document.close()
    setGedruckt(true)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Kassensturz</h1>
        <p className="mt-1 text-sm text-gray-500">Bargeld-Zählung und Soll/Ist-Vergleich</p>
      </div>

      {/* Datum */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Datum</label>
          <input
            type="date"
            value={datum}
            max={heuteLokal()}
            onChange={e => { setDatum(e.target.value); reset() }}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Startgeld / Wechselgeld
            <span className="ml-1 text-gray-400 font-normal">(optional)</span>
          </label>
          <div className="flex items-center gap-1">
            <span className="text-gray-500 text-sm">€</span>
            <input
              type="text"
              inputMode="decimal"
              value={startgeld}
              onChange={e => { setStartgeld(e.target.value); setGedruckt(false) }}
              placeholder="0,00"
              className="w-24 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
            />
          </div>
        </div>
      </div>

      {/* Stückelung */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Stückelung</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {STUECKELUNG.map(({ label, wertCent }) => {
            const count  = stueck[wertCent] ?? 0
            const gesamt = count * wertCent
            return (
              <div key={wertCent} className="flex items-center gap-3 px-4 py-2">
                <span className="w-20 text-sm font-medium text-gray-700">{label}</span>
                <span className="text-gray-400 text-sm">×</span>
                <input
                  type="number"
                  min={0}
                  value={count === 0 ? '' : count}
                  onChange={e => setStueckCount(wertCent, e.target.value)}
                  placeholder="0"
                  className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm text-right focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                />
                <span className="text-gray-400 text-sm">=</span>
                <span className={`ml-auto text-sm font-mono font-medium ${gesamt > 0 ? 'text-gray-900' : 'text-gray-300'}`}>
                  {formatPreis(gesamt)}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Ergebnis */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">
            Ergebnis — {formatDatumAnzeige(datum)}
          </h2>
        </div>
        <div className="p-4 space-y-3">
          {isLoading && <p className="text-sm text-gray-400">Lade Soll-Betrag…</p>}
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
              <div className={`flex items-center justify-between pt-3 border-t border-gray-200 text-base font-bold ${
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
      <div className="flex flex-wrap gap-2">
        <Button onClick={drucken} disabled={!ta}>
          Kassensturz drucken / PDF
        </Button>
        <Button variant="secondary" onClick={reset}>
          Zurücksetzen
        </Button>
        {gedruckt && (
          <span className="self-center text-sm text-green-700">✓ Gedruckt</span>
        )}
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
      <span className={`text-sm ${grau ? 'text-gray-500' : 'text-gray-700'}`}>{label}</span>
      <span className={`font-mono ${gross ? 'text-lg font-semibold text-gray-900' : 'text-sm text-gray-600'}`}>
        {formatPreis(wert)}
      </span>
    </div>
  )
}
