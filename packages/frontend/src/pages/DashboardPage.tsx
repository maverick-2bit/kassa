/**
 * DashboardPage — Tagesübersicht über alle Kassen des Mandanten.
 *
 * Zeigt pro Kasse: heutiger Umsatz, Anzahl Belege, Zahlungsaufteilung.
 * Nutzt die bestehende Berichte-API mit jeweils einer separaten Anfrage
 * pro Kasse (parallel via TanStack Query).
 */

import { useQuery } from '@tanstack/react-query'
import type { BerichtGesamt } from '@kassa/shared'
import { berichtApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'

// ---------------------------------------------------------------------------
// Datum-Helfer
// ---------------------------------------------------------------------------

function heute(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

function formatDatumAnzeige(datum: string): string {
  const [y, m, d] = datum.split('-')
  return `${d}.${m}.${y}`
}

function pct(teil: number, gesamt: number): string {
  if (gesamt === 0) return ''
  return `${Math.round(Math.abs(teil / gesamt) * 100)} %`
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function DashboardPage() {
  const auth   = getAuth()!
  const datum  = heute()
  const kassen = auth.kassen

  const gesamtQuery = useQuery({
    queryKey: ['dashboard-gesamt', datum],
    queryFn:  () => berichtApi.umsatz({
      von: datum, bis: datum, gruppierung: 'tag', nurZielrechnungen: false,
    }),
    refetchInterval: 60_000,
  })

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Tagesübersicht — {formatDatumAnzeige(datum)}
        </p>
      </div>

      {/* Mandant-Gesamt-Kacheln */}
      {gesamtQuery.data && (
        <GesamtUebersicht gesamt={gesamtQuery.data.gesamt} />
      )}
      {gesamtQuery.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Fehler beim Laden: {gesamtQuery.error instanceof Error ? gesamtQuery.error.message : 'Unbekannt'}
        </div>
      )}

      {/* Pro-Kasse-Karten */}
      {kassen.length > 1 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Kassen im Überblick
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {kassen.map(k => (
              <KasseKarte
                key={k.id}
                kasseId={k.id}
                bezeichnung={k.bezeichnung ?? k.kassenId}
                datum={datum}
              />
            ))}
          </div>
        </div>
      )}

      {/* Stundenaufriss für heute */}
      <StundenVerlauf datum={datum} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gesamt-Übersicht (alle Kassen summiert)
// ---------------------------------------------------------------------------

function GesamtUebersicht({ gesamt: g }: { gesamt: BerichtGesamt }) {
  const avgBonCent = g.anzahlBelege > 0 ? Math.round(g.umsatzCent / g.anzahlBelege) : 0

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Kachel
        label="Umsatz heute"
        wert={formatPreis(g.umsatzCent)}
        sub={`${g.anzahlBelege} Belege${g.anzahlStornos > 0 ? `, ${g.anzahlStornos} Stornos` : ''}`}
        hervor
      />
      <Kachel label="Ø Bon-Wert"  wert={formatPreis(avgBonCent)}    sub="pro Barzahlungsbeleg" />
      <Kachel label="Bar"         wert={formatPreis(g.barCent)}      sub={pct(g.barCent,   g.umsatzCent)} />
      <Kachel label="Karte"       wert={formatPreis(g.karteCent)}    sub={pct(g.karteCent, g.umsatzCent)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pro-Kasse-Karte
// ---------------------------------------------------------------------------

function KasseKarte({ kasseId, bezeichnung, datum }: {
  kasseId:     string
  bezeichnung: string
  datum:       string
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard-kasse', kasseId, datum],
    queryFn:  () => berichtApi.umsatz({
      kasseIds: [kasseId],
      von: datum, bis: datum,
      gruppierung: 'tag', nurZielrechnungen: false,
    }),
    refetchInterval: 60_000,
  })

  const g = data?.gesamt

  return (
    <div className={`rounded-lg border bg-white shadow-sm p-4 space-y-3 ${
      isError ? 'border-red-200' : 'border-gray-200'
    }`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 truncate">{bezeichnung}</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          isLoading ? 'bg-gray-100 text-gray-400' :
          isError   ? 'bg-red-100 text-red-600' :
          g && g.umsatzCent > 0 ? 'bg-green-100 text-green-700' :
          'bg-gray-100 text-gray-500'
        }`}>
          {isLoading ? '…' : isError ? 'Fehler' : g && g.umsatzCent > 0 ? 'Aktiv' : 'Kein Umsatz'}
        </span>
      </div>

      {g && (
        <>
          <div>
            <p className="text-2xl font-bold font-mono text-gray-900">{formatPreis(g.umsatzCent)}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {g.anzahlBelege} Belege
              {g.anzahlStornos > 0 && <span className="text-red-500"> · {g.anzahlStornos} Stornos</span>}
            </p>
          </div>

          {g.umsatzCent > 0 && (
            <div className="flex gap-3 text-xs text-gray-600">
              {g.barCent > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
                  Bar {pct(g.barCent, g.umsatzCent)}
                </span>
              )}
              {g.karteCent > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
                  Karte {pct(g.karteCent, g.umsatzCent)}
                </span>
              )}
              {g.sonstigCent > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-purple-400" />
                  Sonst. {pct(g.sonstigCent, g.umsatzCent)}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {isLoading && (
        <div className="text-sm text-gray-400">Wird geladen…</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stunden-Verlauf (kompakte Balken für heute)
// ---------------------------------------------------------------------------

function StundenVerlauf({ datum }: { datum: string }) {
  const { data, isLoading } = useQuery({
    queryKey:      ['dashboard-stunden', datum],
    queryFn:       () => berichtApi.stunden({ von: datum, bis: datum }),
    refetchInterval: 60_000,
  })

  if (isLoading) return null
  if (!data || data.gesamt.umsatzCent === 0) return null

  const maxUmsatz = Math.max(...data.zeilen.map(z => z.umsatzCent), 1)
  const aktiveZeilen = data.zeilen.filter(z => z.umsatzCent > 0)
  if (aktiveZeilen.length === 0) return null

  const ersteStunde = aktiveZeilen[0]!.stunde
  const letzteStunde = aktiveZeilen[aktiveZeilen.length - 1]!.stunde
  const angezeigt = data.zeilen.slice(
    Math.max(0, ersteStunde - 1),
    Math.min(23, letzteStunde + 1) + 1,
  )

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-700">Umsatz nach Tageszeit (heute)</h2>
      </div>
      <div className="px-4 py-4 flex items-end gap-1" style={{ height: '120px' }}>
        {angezeigt.map(z => {
          const hoehe = maxUmsatz > 0 ? Math.max(4, Math.round((z.umsatzCent / maxUmsatz) * 80)) : 0
          return (
            <div key={z.stunde} className="flex flex-col items-center flex-1 min-w-0 group relative">
              <div
                className={`w-full rounded-t transition-all ${z.umsatzCent > 0 ? 'bg-brand-400 hover:bg-brand-500' : 'bg-gray-100'}`}
                style={{ height: `${hoehe}px` }}
              />
              {/* Tooltip */}
              {z.umsatzCent > 0 && (
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded px-2 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                  {z.stunde}:00 — {formatPreis(z.umsatzCent)} ({z.anzahlBelege} Bel.)
                </div>
              )}
              <span className="text-xs text-gray-400 mt-1">{z.stunde}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kachel-Komponente
// ---------------------------------------------------------------------------

function Kachel({ label, wert, sub, hervor }: {
  label:   string
  wert:    string
  sub?:    string
  hervor?: boolean
}) {
  return (
    <div className={`rounded-lg border p-4 shadow-sm ${hervor ? 'bg-brand-50 border-brand-200' : 'bg-white border-gray-200'}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`font-mono font-semibold text-xl mt-1 ${hervor ? 'text-brand-700' : 'text-gray-900'}`}>
        {wert}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}
