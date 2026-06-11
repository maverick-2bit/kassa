import { useEffect, useState, useCallback } from 'react'
import { selfcheckoutApi, type SelfCheckoutTab } from '../lib/api'

function formatPreis(cent: number): string {
  return (cent / 100).toLocaleString('de-AT', { style: 'currency', currency: 'EUR' })
}

type Status = 'laden' | 'fehler' | 'leer' | 'angezeigt' | 'angefordert'

export function SelfCheckoutPage() {
  const params  = new URLSearchParams(window.location.search)
  const kasseId = params.get('kasseId') ?? ''
  const tisch   = params.get('tisch')   ?? ''

  const [status,  setStatus]  = useState<Status>('laden')
  const [tab,     setTab]     = useState<SelfCheckoutTab | null>(null)
  const [fehler,  setFehler]  = useState('')
  const [loading, setLoading] = useState(false)

  const laden = useCallback(async () => {
    if (!kasseId || !tisch) {
      setFehler('Ungültiger Checkout-Link (kasseId oder tisch fehlt).')
      setStatus('fehler')
      return
    }
    setStatus('laden')
    try {
      const data = await selfcheckoutApi.ladeTab(kasseId, tisch)
      setTab(data)
      setStatus(data.offen ? 'angezeigt' : 'leer')
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Fehler beim Laden')
      setStatus('fehler')
    }
  }, [kasseId, tisch])

  useEffect(() => { laden() }, [laden])

  const zahlungAnfordern = async () => {
    setLoading(true)
    try {
      await selfcheckoutApi.zahlungAnfordern(kasseId, tisch)
      setStatus('angefordert')
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Fehler beim Anfordern')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-brand-600 text-white px-6 py-4">
        <div className="flex items-center gap-3">
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
          </svg>
          <div>
            <p className="font-semibold">Self-Checkout</p>
            {tisch && <p className="text-brand-200 text-xs">Tisch: {tisch}</p>}
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-6">
        {status === 'laden' && (
          <div className="text-center">
            <svg className="h-8 w-8 animate-spin text-brand-500 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v4m0 12v4m8-8h-4M6 12H2" />
            </svg>
            <p className="mt-3 text-gray-500">Rechnung wird geladen…</p>
          </div>
        )}

        {status === 'fehler' && (
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto">
              <svg className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="mt-4 text-gray-700 font-medium">Fehler</p>
            <p className="text-gray-500 text-sm mt-1">{fehler}</p>
            <button onClick={laden} className="mt-4 px-4 py-2 rounded-md bg-brand-600 text-white text-sm">
              Erneut versuchen
            </button>
          </div>
        )}

        {status === 'leer' && (
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto">
              <svg className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
              </svg>
            </div>
            <p className="mt-4 text-gray-700 font-medium">Kein offener Tisch</p>
            <p className="text-gray-500 text-sm mt-1">Für Tisch {tisch} liegt derzeit keine offene Rechnung vor.</p>
          </div>
        )}

        {status === 'angezeigt' && tab && (
          <div className="w-full max-w-sm space-y-4">
            {/* Positions-Liste */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                <p className="text-sm font-semibold text-gray-700">Ihre Bestellung — Tisch {tisch}</p>
              </div>
              <div className="divide-y divide-gray-100">
                {tab.positionen.map((pos, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{pos.menge}× {pos.bezeichnung}</p>
                      <p className="text-xs text-gray-500">{formatPreis(pos.preisCent)} / Stück</p>
                    </div>
                    <p className="text-sm font-semibold text-gray-900 font-mono">{formatPreis(pos.gesamtCent)}</p>
                  </div>
                ))}
              </div>
              <div className="px-4 py-4 border-t-2 border-gray-200 bg-gray-50 flex items-center justify-between">
                <span className="text-base font-bold text-gray-900">Gesamt</span>
                <span className="text-xl font-black text-brand-600 font-mono">{formatPreis(tab.summeCent)}</span>
              </div>
            </div>

            {fehler && <p className="text-sm text-red-600 text-center">{fehler}</p>}

            <button
              onClick={zahlungAnfordern}
              disabled={loading}
              className="w-full py-4 rounded-xl bg-brand-600 text-white text-base font-bold hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? (
                <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v4m0 12v4m8-8h-4M6 12H2" />
                </svg>
              ) : (
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
              )}
              Zahlung anfordern
            </button>
            <p className="text-xs text-gray-400 text-center">
              Ein Servicemitarbeiter kommt dann zu Ihnen.
            </p>
          </div>
        )}

        {status === 'angefordert' && (
          <div className="text-center max-w-sm space-y-4">
            <div className="w-20 h-20 rounded-full bg-emerald-100 border-4 border-emerald-400 flex items-center justify-center mx-auto">
              <svg className="h-10 w-10 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-xl font-bold text-gray-900">Zahlung angefordert!</p>
            <p className="text-gray-500 text-sm">
              Ein Servicemitarbeiter kommt gleich zu Ihnen an Tisch <strong>{tisch}</strong>.
            </p>
            {tab && (
              <p className="text-2xl font-black font-mono text-brand-600">{formatPreis(tab.summeCent)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
