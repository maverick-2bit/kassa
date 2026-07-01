import { useState } from 'react'
import { getAuth } from '../lib/auth'
import { downloadBmdExport } from '../lib/api'

const heute = new Date().toISOString().slice(0, 10)
const jahresBeginn = new Date().getFullYear() + '-01-01'

export function ExportPage() {
  const auth   = getAuth()
  const kassen = auth?.kassen ?? []

  const [kasseId,  setKasseId]  = useState(kassen[0]?.id ?? '')
  const [vonDatum, setVonDatum] = useState(jahresBeginn)
  const [bisDatum, setBisDatum] = useState(heute)
  const [loading,  setLoading]  = useState(false)
  const [meldung,  setMeldung]  = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const handleDownload = async () => {
    setLoading(true)
    setMeldung(null)
    try {
      const result = await downloadBmdExport({ kasseId, vonDatum, bisDatum })
      setMeldung({ typ: 'ok', text: `${result.anzahl} Belege exportiert.` })
    } catch (err) {
      setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : 'Export fehlgeschlagen' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-ink">Buchhaltungs-Export</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Exportiert Belege im BMD NTCS CSV-Format für Ihre Buchhaltungssoftware.
        </p>
      </div>

      {/* BMD-Export */}
      <div className="bg-panel border border-line rounded-xl p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 shrink-0">
            <svg className="h-5 w-5 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-ink">BMD NTCS Export</h2>
            <p className="text-sm text-ink-muted mt-0.5">
              Buchungszeilen im BMD-CSV-Format mit Steuercodes, Konten und Beträgen.
              Geeignet für BMD NTCS, DATEV (mit Anpassungen) und vergleichbare Systeme.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-ink">Kasse</label>
            <select
              value={kasseId}
              onChange={e => setKasseId(e.target.value)}
              className="w-full rounded-md border border-line-strong text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {kassen.map(k => (
                <option key={k.id} value={k.id}>{k.kassenId}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-ink">Von</label>
            <input
              type="date"
              value={vonDatum}
              onChange={e => setVonDatum(e.target.value)}
              className="w-full rounded-md border border-line-strong text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-ink">Bis</label>
            <input
              type="date"
              value={bisDatum}
              onChange={e => setBisDatum(e.target.value)}
              className="w-full rounded-md border border-line-strong text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>

        {meldung && (
          <div className={`rounded-md px-4 py-3 text-sm ${
            meldung.typ === 'ok'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {meldung.text}
          </div>
        )}

        <button
          onClick={handleDownload}
          disabled={loading || !kasseId}
          className="w-full sm:w-auto inline-flex items-center gap-2 rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v4m0 12v4m8-8h-4M6 12H2" />
            </svg>
          ) : (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          )}
          CSV herunterladen
        </button>
      </div>

      {/* Hinweis auf BMD-Konten */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <p className="font-semibold mb-1">Standardmäßige Kontozuordnung</p>
        <ul className="space-y-0.5 text-xs">
          <li>Bar → 2000 (Kasse)</li>
          <li>Karte → 2600 (Bank)</li>
          <li>20% MwSt-Erlöse → 4000</li>
          <li>10% MwSt-Erlöse → 4010</li>
          <li>13% MwSt-Erlöse → 4013</li>
          <li>0% Erlöse → 4020</li>
        </ul>
        <p className="mt-2">Bitte überprüfen Sie die Kontonummern mit Ihrer Buchhaltung.</p>
        <p className="mt-1">
          <strong>Hinweis:</strong> Bei Belegen mit gemischter Zahlung (z.B. Bar + Karte) wird
          der gesamte Betrag dem Konto der ersten Zahlungsart zugeordnet. Solche Belege müssen
          in der Buchhaltung manuell aufgeteilt werden.
        </p>
      </div>
    </div>
  )
}
