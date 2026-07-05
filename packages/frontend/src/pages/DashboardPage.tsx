/**
 * DashboardPage — Tagesübersicht über alle Kassen des Mandanten.
 *
 * Zeigt:
 *  - Quick-Actions (Shortcuts zu häufig genutzten Seiten)
 *  - Gesamt-KPIs für heute (Umsatz, Ø Bon, Bar/Karte)
 *  - Sekundäre Widgets: Offene Tische (Gastro), Offene Posten
 *  - Lagerstand-Warnungen (Artikel unter Mindestbestand)
 *  - Pro-Kasse-Karten (bei mehreren Kassen)
 *  - Stunden-Verlauf (Balkendiagramm)
 */

import { useQuery, useQueries } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { ArtikelBerichtResponse, BerichtGesamt, Artikel } from '@kassa/shared'
import { berichtApi, kasseApi, tischTabApi, artikelApi, offenerPostenApi, kdsApi } from '../lib/api'
import { getAuth, hasBerechtigung, hasModul } from '../lib/auth'
import { formatPreis } from '../lib/format'

// ---------------------------------------------------------------------------
// Datum-Helfer
// ---------------------------------------------------------------------------

function heute(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

function gestern(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

function trendPct(heute: number, gestern: number): { wert: string; positiv: boolean } | null {
  if (gestern === 0) return null
  const diff = ((heute - gestern) / gestern) * 100
  return { wert: `${diff >= 0 ? '+' : ''}${Math.round(diff)} %`, positiv: diff >= 0 }
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
  const auth      = getAuth()!
  const datum     = heute()
  const datumGest = gestern()
  const kassen    = auth.kassen

  const gesamtQuery = useQuery({
    queryKey: ['dashboard-gesamt', datum],
    queryFn:  () => berichtApi.umsatz({
      von: datum, bis: datum, gruppierung: 'tag', nurZielrechnungen: false,
    }),
    refetchInterval: 60_000,
  })

  const gestQuery = useQuery({
    queryKey: ['dashboard-gestern', datumGest],
    queryFn:  () => berichtApi.umsatz({
      von: datumGest, bis: datumGest, gruppierung: 'tag', nurZielrechnungen: false,
    }),
    staleTime: 5 * 60_000,
  })

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Tagesübersicht — {formatDatumAnzeige(datum)}
        </p>
      </div>

      {/* Quick-Actions */}
      <QuickActions />

      {/* Jahresbeleg-Warnung */}
      <JahresbelegDashboardBanner kassen={kassen} />

      {/* Mandant-Gesamt-Kacheln */}
      {gesamtQuery.data && (
        <GesamtUebersicht
          gesamt={gesamtQuery.data.gesamt}
          {...(gestQuery.data ? { gestGesamt: gestQuery.data.gesamt } : {})}
        />
      )}
      {gesamtQuery.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Fehler beim Laden: {gesamtQuery.error instanceof Error ? gesamtQuery.error.message : 'Unbekannt'}
        </div>
      )}

      {/* Sekundäre Widgets */}
      <SekundaereWidgets kassen={kassen} mandantId={auth.mandant.id} />

      {/* Pro-Kasse-Karten */}
      {kassen.length > 1 && (
        <div>
          <h2 className="text-sm font-semibold text-ink-muted uppercase tracking-wide mb-3">
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

      {/* Top-Artikel + 7-Tage-Verlauf */}
      {hasBerechtigung('belege.lesen') && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TopArtikelWidget datum={datum} />
          <SiebentageVerlauf datum={datum} />
        </div>
      )}

      {/* Lagerstand-Warnungen */}
      {hasBerechtigung('artikel.verwalten') && (
        <LagerstandWarnungen mandantId={auth.mandant.id} />
      )}

      {/* Stundenaufriss für heute */}
      <StundenVerlauf datum={datum} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quick-Actions
// ---------------------------------------------------------------------------

function QuickActions() {
  return (
    <div className="flex flex-wrap gap-2">
      {hasBerechtigung('tische') && hasModul('gastro') && (
        <QuickLink to="/tische" label="Tische" color="emerald" />
      )}
      {hasBerechtigung('kasse') && (
        <QuickLink to="/kasse" label="Kasse" color="brand" />
      )}
      {hasBerechtigung('belege.lesen') && (
        <QuickLink to="/tagesabschluss" label="Tagesabschluss" color="amber" />
      )}
      {hasBerechtigung('belege.lesen') && (
        <QuickLink to="/kassensturz" label="Kassensturz" color="amber" />
      )}
      {hasBerechtigung('einstellungen') && (
        <QuickLink to="/kassenbuch" label="Kassenbuch" color="purple" />
      )}
      {hasBerechtigung('belege.lesen') && (
        <QuickLink to="/berichte" label="Berichte" color="blue" />
      )}
      {hasBerechtigung('artikel.verwalten') && (
        <QuickLink to="/wareneingang" label="Wareneingang" color="gray" />
      )}
    </div>
  )
}

function QuickLink({ to, label, color }: {
  to:    string
  label: string
  color: 'brand' | 'emerald' | 'amber' | 'purple' | 'blue' | 'gray'
}) {
  const cls: Record<string, string> = {
    brand:   'bg-brand-50   border-brand-200   text-brand-700   hover:bg-brand-100',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100',
    amber:   'bg-amber-50   border-amber-200   text-amber-700   hover:bg-amber-100',
    purple:  'bg-purple-50  border-purple-200  text-purple-700  hover:bg-purple-100',
    blue:    'bg-blue-50    border-blue-200    text-blue-700    hover:bg-blue-100',
    gray:    'bg-panel-2    border-line    text-ink-muted    hover:bg-panel-2',
  }
  return (
    <Link
      to={to}
      className={`inline-flex items-center px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${cls[color]}`}
    >
      {label}
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Sekundäre Widgets (Offene Tische + Offene Posten)
// ---------------------------------------------------------------------------

type KasseInfo = { id: string; bezeichnung: string | null; kassenId: string }

function SekundaereWidgets({ kassen, mandantId }: { kassen: KasseInfo[]; mandantId: string }) {
  const zeigeGastro = hasBerechtigung('tische') && hasModul('gastro')
  const zeigePosten = hasBerechtigung('kunden.verwalten')

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {zeigeGastro && <OffeneTischeWidget kassen={kassen} />}
      {zeigePosten && <OffenePostenWidget />}
      <KdsBonsWidget />
    </div>
  )
}

// Offene Tische (Gastro)
function OffeneTischeWidget({ kassen }: { kassen: KasseInfo[] }) {
  const results = useQueries({
    queries: kassen.map(k => ({
      queryKey:        ['dashboard-tische', k.id],
      queryFn:         () => tischTabApi.list(k.id),
      refetchInterval: 30_000,
    })),
  })

  const isLoading  = results.some(r => r.isLoading)
  const allTabs    = results.flatMap(r => r.data ?? [])
  const anzahl     = allTabs.length
  const offenCent  = allTabs.reduce((s, t) => s + t.summeGesamtCent, 0)

  return (
    <div className="rounded-lg border border-line bg-panel shadow-sm p-4 space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">Offene Tische</p>
        <Link to="/tische" className="text-xs text-brand-600 hover:underline">Zur Tischansicht →</Link>
      </div>
      {isLoading ? (
        <p className="text-sm text-ink-subtle">Wird geladen…</p>
      ) : (
        <>
          <p className="text-3xl font-bold text-ink">{anzahl}</p>
          {offenCent > 0 && (
            <p className="text-sm text-ink-muted">Offen: {formatPreis(offenCent)}</p>
          )}
          {anzahl === 0 && (
            <p className="text-xs text-ink-subtle">Keine offenen Tabs</p>
          )}
        </>
      )}
    </div>
  )
}

// Offene Posten
function OffenePostenWidget() {
  const { data, isLoading } = useQuery({
    queryKey:        ['dashboard-offene-posten'],
    queryFn:         () => offenerPostenApi.statistik(),
    refetchInterval: 60_000,
  })

  return (
    <div className="rounded-lg border border-line bg-panel shadow-sm p-4 space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">Offene Posten</p>
        <Link to="/offene-posten" className="text-xs text-brand-600 hover:underline">Übersicht →</Link>
      </div>
      {isLoading ? (
        <p className="text-sm text-ink-subtle">Wird geladen…</p>
      ) : data && data.anzahl > 0 ? (
        <>
          <p className="text-3xl font-bold text-ink">{data.anzahl}</p>
          <p className="text-sm text-ink-muted">Ausstehend: {formatPreis(data.gesamtRestCent)}</p>
        </>
      ) : (
        <>
          <p className="text-3xl font-bold text-green-600">0</p>
          <p className="text-xs text-ink-subtle">Alle Posten beglichen</p>
        </>
      )}
    </div>
  )
}

// KDS-Bons-Widget (offene Bons im Browser-KDS)
function KdsBonsWidget() {
  const { data, isLoading } = useQuery({
    queryKey:        ['dashboard-kds'],
    queryFn:         () => kdsApi.uebersicht(),
    refetchInterval: 15_000,
  })

  const STATION_LABELS: Record<string, string> = {
    kueche:       'Küche',
    schank:       'Schank',
    kalte_kueche: 'Kalte Küche',
    dessert:      'Dessert',
  }

  return (
    <div className="rounded-lg border border-line bg-panel shadow-sm p-4 space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">KDS — Offene Bons</p>
        <span className="text-xs text-ink-subtle">alle Stationen</span>
      </div>
      {isLoading ? (
        <p className="text-sm text-ink-subtle">Wird geladen…</p>
      ) : !data || data.total === 0 ? (
        <>
          <p className="text-3xl font-bold text-green-600">0</p>
          <p className="text-xs text-ink-subtle">Keine offenen Bons</p>
        </>
      ) : (
        <>
          <p className="text-3xl font-bold text-amber-600">{data.total}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
            {Object.entries(data.perStation).map(([station, count]) => (
              <span key={station} className="text-xs text-ink-muted">
                {STATION_LABELS[station] ?? station}: <span className="font-semibold">{count}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lagerstand-Warnungen
// ---------------------------------------------------------------------------

function LagerstandWarnungen({ mandantId }: { mandantId: string }) {
  const { data, isLoading } = useQuery({
    queryKey:  ['dashboard-lager', mandantId],
    queryFn:   () => artikelApi.list(mandantId, true),
    staleTime: 5 * 60_000,
  })

  if (isLoading) return null

  const warnungen: Artikel[] = (data ?? []).filter(a =>
    a.lagerstandAktiv &&
    a.mindestbestand  !== null &&
    a.lagerstandMenge !== null &&
    a.lagerstandMenge <= a.mindestbestand
  )

  if (warnungen.length === 0) return null

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50">
      <div className="flex items-center justify-between px-4 py-3 border-b border-orange-200">
        <div className="flex items-center gap-2">
          {/* Warndreieck */}
          <svg className="h-4 w-4 text-orange-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          <h2 className="text-sm font-semibold text-orange-800">
            Lagerstand-Warnungen ({warnungen.length})
          </h2>
        </div>
        <Link to="/wareneingang" className="text-xs font-medium text-orange-700 hover:underline">
          Wareneingang →
        </Link>
      </div>
      <div className="divide-y divide-orange-100">
        {warnungen.slice(0, 8).map(a => (
          <div key={a.id} className="flex items-center justify-between px-4 py-2">
            <span className="text-sm text-orange-900 font-medium truncate pr-4">{a.bezeichnung}</span>
            <div className="flex items-center gap-3 flex-shrink-0 text-xs">
              <span className={`font-mono font-semibold ${
                a.lagerstandMenge === 0 ? 'text-red-600' : 'text-orange-600'
              }`}>
                {a.lagerstandMenge === 0 ? 'Ausverkauft' : `Bestand: ${a.lagerstandMenge}`}
              </span>
              <span className="text-orange-400">
                Min: {a.mindestbestand}
              </span>
            </div>
          </div>
        ))}
        {warnungen.length > 8 && (
          <div className="px-4 py-2 text-xs text-orange-600">
            … und {warnungen.length - 8} weitere Artikel
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Jahresbeleg-Dashboard-Banner
// ---------------------------------------------------------------------------

function JahresbelegDashboardBanner({ kassen }: { kassen: KasseInfo[] }) {
  const results = useQueries({
    queries: kassen.map(k => ({
      queryKey:  ['jahresbeleg-status', k.id],
      queryFn:   () => kasseApi.getJahresbelegStatus(k.id),
      staleTime: 5 * 60_000,
    })),
  })

  // Only render once at least one query has settled
  if (results.every(r => r.isLoading)) return null

  const faelligeKassen = kassen.filter((_k, i) => results[i]?.data?.jahresbelegFaellig === true)
  if (faelligeKassen.length === 0) return null

  const jetzt   = new Date()
  const tagDesJahres =
    Math.floor((jetzt.getTime() - new Date(jetzt.getFullYear(), 0, 1).getTime()) / 86_400_000) + 1
  const ueberfaellig = tagDesJahres > 7

  const [bg, border, text, iconFill] = ueberfaellig
    ? ['bg-red-50',   'border-red-300',   'text-red-800',   'text-red-500']
    : ['bg-amber-50', 'border-amber-300', 'text-amber-800', 'text-amber-500']

  const kassenNamen = faelligeKassen
    .map(k => `„${k.bezeichnung ?? k.kassenId}"`)
    .join(', ')

  const aktivesJahr = jetzt.getFullYear()

  return (
    <div className={`rounded-lg border ${bg} ${border} p-4`} role="alert">
      <div className="flex items-start gap-3">
        {/* Warndreieck */}
        <svg className={`h-5 w-5 flex-shrink-0 mt-0.5 ${iconFill}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
        </svg>

        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${text}`}>
            {ueberfaellig ? 'Jahresbeleg überfällig!' : 'Jahresbeleg fällig'}
          </p>
          <p className={`text-sm mt-1 ${text}`}>
            {faelligeKassen.length === 1
              ? <>Für die Kasse {kassenNamen} wurde noch kein Jahresbeleg für {aktivesJahr} erstellt.</>
              : <>Für {faelligeKassen.length} Kassen ({kassenNamen}) wurde noch kein Jahresbeleg für {aktivesJahr} erstellt.</>
            }
            {' '}
            {ueberfaellig
              ? <>Laut RKSV § 8 Abs. 3 war der Jahresbeleg am 1.&nbsp;Jänner fällig — bitte umgehend nachholen.</>
              : <>Bitte den Jahresbeleg so früh wie möglich erstellen (RKSV § 8 Abs. 3).</>
            }
          </p>
          <Link
            to="/belege"
            className={`inline-block mt-2 text-xs font-semibold underline underline-offset-2 ${text}`}
          >
            Zur Belegseite → Jahresbeleg erstellen
          </Link>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gesamt-Übersicht (alle Kassen summiert)
// ---------------------------------------------------------------------------

function GesamtUebersicht({ gesamt: g, gestGesamt: gg }: { gesamt: BerichtGesamt; gestGesamt?: BerichtGesamt }) {
  const avgBonCent     = g.anzahlBelege  > 0 ? Math.round(g.umsatzCent  / g.anzahlBelege)  : 0
  const avgBonGestCent = gg && gg.anzahlBelege > 0 ? Math.round(gg.umsatzCent / gg.anzahlBelege) : 0

  const umsatzTrend  = gg ? trendPct(g.umsatzCent,  gg.umsatzCent)  : null
  const avgBonTrend  = gg ? trendPct(avgBonCent,     avgBonGestCent) : null

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Kachel
        label="Umsatz heute"
        wert={formatPreis(g.umsatzCent)}
        sub={`${g.anzahlBelege} Belege${g.anzahlStornos > 0 ? `, ${g.anzahlStornos} Stornos` : ''}`}
        {...(umsatzTrend ? { trend: umsatzTrend } : {})}
        hervor
      />
      <Kachel
        label="Ø Bon-Wert"
        wert={formatPreis(avgBonCent)}
        sub="pro Beleg"
        {...(avgBonTrend ? { trend: avgBonTrend } : {})}
      />
      <Kachel label="Bar"   wert={formatPreis(g.barCent)}   sub={pct(g.barCent,   g.umsatzCent)} />
      <Kachel label="Karte" wert={formatPreis(g.karteCent)} sub={pct(g.karteCent, g.umsatzCent)} />
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
    <div className={`rounded-lg border bg-panel shadow-sm p-4 space-y-3 ${
      isError ? 'border-red-200' : 'border-line'
    }`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink truncate">{bezeichnung}</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          isLoading ? 'bg-panel-2 text-ink-subtle' :
          isError   ? 'bg-red-100 text-red-600' :
          g && g.umsatzCent > 0 ? 'bg-green-100 text-green-700' :
          'bg-panel-2 text-ink-muted'
        }`}>
          {isLoading ? '…' : isError ? 'Fehler' : g && g.umsatzCent > 0 ? 'Aktiv' : 'Kein Umsatz'}
        </span>
      </div>

      {g && (
        <>
          <div>
            <p className="text-2xl font-bold font-mono text-ink">{formatPreis(g.umsatzCent)}</p>
            <p className="text-xs text-ink-muted mt-0.5">
              {g.anzahlBelege} Belege
              {g.anzahlStornos > 0 && <span className="text-red-500"> · {g.anzahlStornos} Stornos</span>}
            </p>
          </div>

          {g.umsatzCent > 0 && (
            <div className="flex gap-3 text-xs text-ink-muted">
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
        <div className="text-sm text-ink-subtle">Wird geladen…</div>
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

  const ersteStunde  = aktiveZeilen[0]!.stunde
  const letzteStunde = aktiveZeilen[aktiveZeilen.length - 1]!.stunde
  const angezeigt    = data.zeilen.slice(
    Math.max(0, ersteStunde - 1),
    Math.min(23, letzteStunde + 1) + 1,
  )

  return (
    <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
      <div className="px-4 py-3 bg-panel-2 border-b border-line">
        <h2 className="text-sm font-semibold text-ink">Umsatz nach Tageszeit (heute)</h2>
      </div>
      <div className="px-4 py-4 flex items-end gap-1" style={{ height: '120px' }}>
        {angezeigt.map(z => {
          const hoehe = maxUmsatz > 0 ? Math.max(4, Math.round((z.umsatzCent / maxUmsatz) * 80)) : 0
          return (
            <div key={z.stunde} className="flex flex-col items-center flex-1 min-w-0 group relative">
              <div
                className={`w-full rounded-t transition-all ${z.umsatzCent > 0 ? 'bg-brand-500 hover:bg-brand-600' : 'bg-panel-2'}`}
                style={{ height: `${hoehe}px` }}
              />
              {/* Tooltip */}
              {z.umsatzCent > 0 && (
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-ink text-surface text-xs rounded px-2 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                  {z.stunde}:00 — {formatPreis(z.umsatzCent)} ({z.anzahlBelege} Bel.)
                </div>
              )}
              <span className="text-xs text-ink-subtle mt-1">{z.stunde}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Top-5-Artikel (heute)
// ---------------------------------------------------------------------------

function TopArtikelWidget({ datum }: { datum: string }) {
  const { data, isLoading } = useQuery({
    queryKey:        ['dashboard-top-artikel', datum],
    queryFn:         () => berichtApi.artikel({ von: datum, bis: datum, limit: 5 }),
    refetchInterval: 60_000,
  })

  const maxUmsatz = Math.max(...(data?.zeilen ?? []).map(z => z.umsatzCent), 1)

  return (
    <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
      <div className="px-4 py-3 bg-panel-2 border-b border-line flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Top-Artikel heute</h2>
        <Link to="/berichte" className="text-xs text-brand-600 hover:underline">Alle Artikel →</Link>
      </div>

      {isLoading && (
        <div className="px-4 py-6 text-sm text-ink-subtle">Wird geladen…</div>
      )}

      {!isLoading && (!data || data.zeilen.length === 0) && (
        <div className="px-4 py-6 text-sm text-ink-subtle">Noch keine Artikel verkauft.</div>
      )}

      {data && data.zeilen.length > 0 && (
        <div className="divide-y divide-line">
          {data.zeilen.map((z, i) => {
            const balken = Math.max(8, Math.round((z.umsatzCent / maxUmsatz) * 100))
            return (
              <div key={z.bezeichnung} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-xs font-mono text-ink-subtle w-4 shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-medium text-ink truncate">{z.bezeichnung}</span>
                    <span className="text-xs text-ink-muted shrink-0">{z.mengeSumme}×</span>
                  </div>
                  <div className="h-1.5 bg-panel-2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-500 rounded-full transition-all"
                      style={{ width: `${balken}%` }}
                    />
                  </div>
                </div>
                <span className="text-sm font-mono font-semibold text-ink shrink-0 w-20 text-right">
                  {formatPreis(z.umsatzCent)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 7-Tage-Trendlinie (SVG-Liniendiagramm)
// ---------------------------------------------------------------------------

function SiebentageVerlauf({ datum }: { datum: string }) {
  const von7 = (() => {
    const d = new Date(datum)
    d.setDate(d.getDate() - 6)
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
  })()

  const { data, isLoading } = useQuery({
    queryKey:        ['dashboard-7tage', datum],
    queryFn:         () => berichtApi.umsatz({ von: von7, bis: datum, gruppierung: 'tag', nurZielrechnungen: false }),
    refetchInterval: 60_000,
    staleTime:       5 * 60_000,
  })

  const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
  const W = 400
  const H = 110
  const PAD_L = 44
  const PAD_R = 12
  const PAD_T = 12
  const PAD_B = 24

  const zeilen = data?.zeilen ?? []
  const maxCent = Math.max(...zeilen.map(z => z.umsatzCent), 1)

  function xPos(i: number) {
    const n = zeilen.length <= 1 ? 1 : zeilen.length - 1
    return PAD_L + (i / n) * (W - PAD_L - PAD_R)
  }
  function yPos(cent: number) {
    return PAD_T + (1 - cent / maxCent) * (H - PAD_T - PAD_B)
  }

  const linePath = zeilen.map((z, i) => `${i === 0 ? 'M' : 'L'} ${xPos(i).toFixed(1)} ${yPos(z.umsatzCent).toFixed(1)}`).join(' ')
  const areaPath = zeilen.length > 0
    ? `${linePath} L ${xPos(zeilen.length - 1).toFixed(1)} ${(H - PAD_B).toFixed(1)} L ${xPos(0).toFixed(1)} ${(H - PAD_B).toFixed(1)} Z`
    : ''

  const wochentagLabel = (periode: string) => {
    const d = new Date(periode)
    return WOCHENTAGE[d.getDay()] ?? ''
  }

  const heute7Sum = zeilen.reduce((s, z) => s + z.umsatzCent, 0)
  const tageMitUmsatz = zeilen.filter(z => z.umsatzCent > 0).length
  const durchschnitt = tageMitUmsatz > 0 ? Math.round(heute7Sum / tageMitUmsatz) : 0

  return (
    <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
      <div className="px-4 py-3 bg-panel-2 border-b border-line flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Letzten 7 Tage</h2>
        {!isLoading && durchschnitt > 0 && (
          <span className="text-xs text-ink-muted">
            Ø {formatPreis(durchschnitt)}/Tag
          </span>
        )}
      </div>

      {isLoading && (
        <div className="px-4 py-6 text-sm text-ink-subtle">Wird geladen…</div>
      )}

      {!isLoading && zeilen.length === 0 && (
        <div className="px-4 py-6 text-sm text-ink-subtle">Keine Daten vorhanden.</div>
      )}

      {!isLoading && zeilen.length > 0 && (
        <div className="px-3 pt-3 pb-1">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: '110px' }}>
            <defs>
              <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   style={{ stopColor: 'var(--brand-500)' }} stopOpacity="0.18" />
                <stop offset="100%" style={{ stopColor: 'var(--brand-500)' }} stopOpacity="0.01" />
              </linearGradient>
            </defs>

            {/* Y-Achse — 3 Linien */}
            {[0, 0.5, 1].map(f => {
              const y = PAD_T + (1 - f) * (H - PAD_T - PAD_B)
              const wert = Math.round(maxCent * f)
              return (
                <g key={f}>
                  <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} style={{ stroke: 'var(--line)' }} strokeWidth="1" />
                  <text x={PAD_L - 4} y={y + 4} textAnchor="end" fontSize="9" style={{ fill: 'var(--ink-subtle)' }}>
                    {wert >= 100 ? `${Math.round(wert / 100)}` : '0'}
                  </text>
                </g>
              )
            })}
            <text x={PAD_L - 4} y={PAD_T + (H - PAD_T - PAD_B) / 2 + 3} textAnchor="end" fontSize="8" style={{ fill: 'var(--ink-subtle)' }}>€</text>

            {/* Area */}
            {areaPath && (
              <path d={areaPath} fill="url(#trendGrad)" />
            )}

            {/* Linie */}
            {linePath && (
              <path d={linePath} fill="none" style={{ stroke: 'var(--brand-500)' }} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            )}

            {/* Punkte + Labels */}
            {zeilen.map((z, i) => {
              const x = xPos(i)
              const y = yPos(z.umsatzCent)
              const isHeute = z.periode === datum
              return (
                <g key={z.periode} className="group">
                  <circle cx={x} cy={y} r={isHeute ? 5 : 3.5} style={{ fill: isHeute ? 'var(--brand-700)' : 'var(--brand-500)', stroke: 'var(--panel)' }} strokeWidth="1.5" />
                  <text x={x} y={H - 4} textAnchor="middle" fontSize="9" style={{ fill: isHeute ? 'var(--brand-700)' : 'var(--ink-subtle)' }} fontWeight={isHeute ? '600' : '400'}>
                    {wochentagLabel(z.periode)}
                  </text>
                  {/* Tooltip bei Hover */}
                  <title>{wochentagLabel(z.periode)} — {formatPreis(z.umsatzCent)} ({z.anzahlBelege} Bel.)</title>
                </g>
              )
            })}
          </svg>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kachel-Komponente
// ---------------------------------------------------------------------------

function Kachel({ label, wert, sub, trend, hervor }: {
  label:   string
  wert:    string
  sub?:    string
  trend?:  { wert: string; positiv: boolean }
  hervor?: boolean
}) {
  return (
    <div className={`rounded-lg border p-4 shadow-sm ${hervor ? 'bg-brand-50 border-brand-200' : 'bg-panel border-line'}`}>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`font-mono font-semibold text-xl mt-1 ${hervor ? 'text-brand-700' : 'text-ink'}`}>
        {wert}
      </p>
      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
        {sub && <p className="text-xs text-ink-subtle">{sub}</p>}
        {trend && (
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${
            trend.positiv
              ? 'bg-green-100 text-green-700'
              : 'bg-red-100 text-red-600'
          }`}>
            {trend.wert} vs. gestern
          </span>
        )}
      </div>
    </div>
  )
}
