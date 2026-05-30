import { useState, useMemo, useCallback } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import type { ArtikelBerichtResponse, BerichtGesamt, BerichtGruppierung, BerichtResponse, KellnerBerichtResponse, KellnerBerichtZeile, StundenBerichtResponse, StundenBerichtZeile, WarengruppeBerichtResponse } from '@kassa/shared'
import { berichtApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'

// ---------------------------------------------------------------------------
// Datum-Helfer
// ---------------------------------------------------------------------------

/** YYYY-MM-DD für heute in Wiener Lokalzeit */
function heute(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

/** Addiere `tage` Tage zu einem YYYY-MM-DD-String */
function addTage(datum: string, tage: number): string {
  const d = new Date(datum)
  d.setDate(d.getDate() + tage)
  return d.toLocaleDateString('sv-SE')
}

/** Ersten Tag der ISO-Woche (Montag) für ein gegebenes YYYY-MM-DD */
function startDerWoche(datum: string): string {
  const d = new Date(datum)
  const tag = d.getDay() || 7          // Sonntag = 7
  d.setDate(d.getDate() - (tag - 1))
  return d.toLocaleDateString('sv-SE')
}

/** YYYY-MM-01 für gegebenes Datum */
function startDesMonats(datum: string): string {
  return datum.slice(0, 7) + '-01'
}

/** Letzter Tag des Monats */
function endeDesMonats(datum: string): string {
  const [y, m] = datum.split('-').map(Number)
  return new Date(y!, m!, 0).toLocaleDateString('sv-SE')
}

/** YYYY-01-01 */
function startDesJahres(datum: string): string {
  return datum.slice(0, 4) + '-01-01'
}

/** YYYY-12-31 */
function endeDesJahres(datum: string): string {
  return datum.slice(0, 4) + '-12-31'
}

type ZeitraumPreset = 'heute' | 'gestern' | 'woche' | 'monat' | 'quartal' | 'jahr' | 'individuell'

interface ZeitraumOption {
  key:   ZeitraumPreset
  label: string
}

const ZEITRAUM_OPTIONEN: ZeitraumOption[] = [
  { key: 'heute',       label: 'Heute' },
  { key: 'gestern',     label: 'Gestern' },
  { key: 'woche',       label: 'Diese Woche' },
  { key: 'monat',       label: 'Dieser Monat' },
  { key: 'quartal',     label: 'Dieses Quartal' },
  { key: 'jahr',        label: 'Dieses Jahr' },
  { key: 'individuell', label: 'Individuell' },
]

function berechneZeitraum(preset: ZeitraumPreset, h: string): { von: string; bis: string } {
  switch (preset) {
    case 'heute':   return { von: h, bis: h }
    case 'gestern': { const g = addTage(h, -1); return { von: g, bis: g } }
    case 'woche':   return { von: startDerWoche(h),  bis: addTage(startDerWoche(h), 6) }
    case 'monat':   return { von: startDesMonats(h),  bis: endeDesMonats(h) }
    case 'quartal': {
      const m = parseInt(h.slice(5, 7))
      const qStart = Math.floor((m - 1) / 3) * 3 + 1
      const vonStr = `${h.slice(0, 4)}-${String(qStart).padStart(2, '0')}-01`
      const bisStr = endeDesMonats(`${h.slice(0, 4)}-${String(qStart + 2).padStart(2, '0')}-01`)
      return { von: vonStr, bis: bisStr }
    }
    case 'jahr':    return { von: startDesJahres(h), bis: endeDesJahres(h) }
    case 'individuell': return { von: h, bis: h }
  }
}

function standardGruppierung(preset: ZeitraumPreset): BerichtGruppierung {
  if (preset === 'jahr' || preset === 'quartal') return 'monat'
  if (preset === 'monat') return 'woche'
  return 'tag'
}

// ---------------------------------------------------------------------------
// Haupt-Komponente
// ---------------------------------------------------------------------------

type BerichtTab = 'gesamtumsatz' | 'umsatz' | 'zahlungsart' | 'warengruppe' | 'artikel' | 'stunden' | 'kellner' | 'vergleich'

const TABS: [BerichtTab, string][] = [
  ['gesamtumsatz', 'Übersicht'],
  ['umsatz',       'Umsatz'],
  ['zahlungsart',  'Zahlungsart'],
  ['warengruppe',  'Warengruppe'],
  ['artikel',      'Artikel'],
  ['stunden',      'Tageszeit'],
  ['kellner',      'Kellner'],
  ['vergleich',    'Vergleich'],
]

export function BerichtePage() {
  const [aktTab, setAktTab] = useState<BerichtTab>('gesamtumsatz')

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Berichte</h1>
        <p className="mt-1 text-sm text-gray-500">Umsatz- und Artikel-Auswertungen</p>
      </div>

      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
        {TABS.map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => setAktTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition whitespace-nowrap ${
              aktTab === tab
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {aktTab === 'gesamtumsatz' && <GesamtumsatzBericht />}
      {aktTab === 'umsatz'       && <UmsatzBericht />}
      {aktTab === 'zahlungsart'  && <ZahlungsartBericht />}
      {aktTab === 'warengruppe'  && <WarengruppeBericht />}
      {aktTab === 'artikel'      && <ArtikelBericht />}
      {aktTab === 'stunden'      && <StundenBericht />}
      {aktTab === 'kellner'      && <KellnerBericht />}
      {aktTab === 'vergleich'    && <VergleichBericht />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Umsatz-Bericht (bestehende Logik, in eigene Komponente extrahiert)
// ---------------------------------------------------------------------------

function UmsatzBericht() {
  const auth = getAuth()!

  const [preset, setPreset]       = useState<ZeitraumPreset>('monat')
  const [von, setVon]             = useState(() => berechneZeitraum('monat', heute()).von)
  const [bis, setBis]             = useState(() => berechneZeitraum('monat', heute()).bis)
  const [gruppierung, setGruppierung] = useState<BerichtGruppierung>('woche')
  const [kasseIds, setKasseIds]   = useState<string[]>([])
  const [nurZiel, setNurZiel]     = useState(false)
  const [geladenerFilter, setGeladenerFilter] = useState<{
    kasseIds:          string[]
    von:               string
    bis:               string
    nurZielrechnungen: boolean
    gruppierung:       BerichtGruppierung
  } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht-umsatz', geladenerFilter],
    queryFn:  () => berichtApi.umsatz(geladenerFilter!),
    enabled:  geladenerFilter !== null,
  })

  function ladeBericht() {
    setGeladenerFilter({ kasseIds, von, bis, nurZielrechnungen: nurZiel, gruppierung })
  }

  function waehlePreset(p: ZeitraumPreset) {
    setPreset(p)
    if (p !== 'individuell') {
      const { von: v, bis: b } = berechneZeitraum(p, heute())
      setVon(v)
      setBis(b)
      setGruppierung(standardGruppierung(p))
    }
  }

  function toggleKasse(id: string) {
    setKasseIds(prev =>
      prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id]
    )
  }

  const kassenAnzeige = useMemo(() => auth.kassen.map(k => ({
    id:    k.id,
    label: k.bezeichnung ?? k.kassenId,
  })), [auth.kassen])

  const alleKassenGewaehlt = kasseIds.length === 0

  return (
    <div className="space-y-6">
      {/* Filter-Panel */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Zeitraum
            </label>
            <div className="space-y-1">
              {ZEITRAUM_OPTIONEN.map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => waehlePreset(opt.key)}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm transition ${
                    preset === opt.key
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Datum
              </label>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-6">Von</span>
                  <input
                    type="date"
                    value={von}
                    max={bis}
                    onChange={(e) => { setVon(e.target.value); setPreset('individuell') }}
                    className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-6">Bis</span>
                  <input
                    type="date"
                    value={bis}
                    min={von}
                    max={heute()}
                    onChange={(e) => { setBis(e.target.value); setPreset('individuell') }}
                    className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                  />
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Gruppierung
              </label>
              <div className="flex gap-1">
                {(['tag', 'woche', 'monat'] as BerichtGruppierung[]).map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGruppierung(g)}
                    className={`flex-1 px-2 py-1.5 rounded text-xs font-medium border transition ${
                      gruppierung === g
                        ? 'bg-brand-600 text-white border-brand-600'
                        : 'text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {g === 'tag' ? 'Tag' : g === 'woche' ? 'Woche' : 'Monat'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {kassenAnzeige.length > 1 && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Kasse
                </label>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={alleKassenGewaehlt} onChange={() => setKasseIds([])} className="rounded" />
                    <span className={alleKassenGewaehlt ? 'font-medium text-gray-900' : 'text-gray-600'}>Alle Kassen</span>
                  </label>
                  {kassenAnzeige.map(k => (
                    <label key={k.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={kasseIds.includes(k.id)} onChange={() => toggleKasse(k.id)} className="rounded" />
                      <span className={kasseIds.includes(k.id) ? 'font-medium text-gray-900' : 'text-gray-600'}>{k.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Filter</label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={nurZiel} onChange={(e) => setNurZiel(e.target.checked)} className="rounded" />
                <span>Nur Zielrechnungen</span>
              </label>
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => berichtApi.buchungsjournalDownload({ kasseIds, von, bis })}
            className="text-xs text-gray-500 hover:text-brand-700 underline underline-offset-2"
          >
            Buchungsjournal exportieren (DATEV/BMD)
          </button>
          <Button onClick={ladeBericht} loading={isLoading}>Bericht laden</Button>
        </div>
      </div>

      {isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error ? error.message : 'Fehler beim Laden'}
        </div>
      )}
      {data && <BerichtErgebnis data={data} gruppierung={geladenerFilter!.gruppierung} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Artikel-Bericht
// ---------------------------------------------------------------------------

function ArtikelBericht() {
  const auth = getAuth()!

  const [preset, setPreset] = useState<ZeitraumPreset>('monat')
  const [von, setVon]       = useState(() => berechneZeitraum('monat', heute()).von)
  const [bis, setBis]       = useState(() => berechneZeitraum('monat', heute()).bis)
  const [kasseIds, setKasseIds] = useState<string[]>([])
  const [geladenerFilter, setGeladenerFilter] = useState<{
    kasseIds: string[]; von: string; bis: string
  } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht-artikel', geladenerFilter],
    queryFn:  () => berichtApi.artikel(geladenerFilter!),
    enabled:  geladenerFilter !== null,
  })

  function ladeBericht() {
    setGeladenerFilter({ kasseIds, von, bis })
  }

  function waehlePreset(p: ZeitraumPreset) {
    setPreset(p)
    if (p !== 'individuell') {
      const { von: v, bis: b } = berechneZeitraum(p, heute())
      setVon(v)
      setBis(b)
    }
  }

  function toggleKasse(id: string) {
    setKasseIds(prev => prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id])
  }

  const kassenAnzeige = useMemo(() => auth.kassen.map(k => ({
    id: k.id, label: k.bezeichnung ?? k.kassenId,
  })), [auth.kassen])
  const alleKassenGewaehlt = kasseIds.length === 0

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Zeitraum</label>
            <div className="space-y-1">
              {ZEITRAUM_OPTIONEN.map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => waehlePreset(opt.key)}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm transition ${
                    preset === opt.key ? 'bg-brand-50 text-brand-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Datum</label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">Von</span>
                <input
                  type="date" value={von} max={bis}
                  onChange={(e) => { setVon(e.target.value); setPreset('individuell') }}
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">Bis</span>
                <input
                  type="date" value={bis} min={von} max={heute()}
                  onChange={(e) => { setBis(e.target.value); setPreset('individuell') }}
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                />
              </div>
            </div>
          </div>

          {kassenAnzeige.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Kasse</label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={alleKassenGewaehlt} onChange={() => setKasseIds([])} className="rounded" />
                  <span className={alleKassenGewaehlt ? 'font-medium text-gray-900' : 'text-gray-600'}>Alle Kassen</span>
                </label>
                {kassenAnzeige.map(k => (
                  <label key={k.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={kasseIds.includes(k.id)} onChange={() => toggleKasse(k.id)} className="rounded" />
                    <span className={kasseIds.includes(k.id) ? 'font-medium text-gray-900' : 'text-gray-600'}>{k.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-gray-100 flex justify-end">
          <Button onClick={ladeBericht} loading={isLoading}>Bericht laden</Button>
        </div>
      </div>

      {isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error ? error.message : 'Fehler beim Laden'}
        </div>
      )}
      {data && <ArtikelBerichtTabelle data={data} />}
    </div>
  )
}

function ArtikelBerichtTabelle({ data }: { data: ArtikelBerichtResponse }) {
  if (data.zeilen.length === 0) {
    return (
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
        Keine Belege im gewählten Zeitraum.
      </div>
    )
  }

  const gesamtUmsatz = data.zeilen.reduce((s, z) => s + z.umsatzCent, 0)
  const gesamtMenge  = data.zeilen.reduce((s, z) => s + z.mengeSumme, 0)

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          {data.zeilen.length} Artikel ({formatDatumAnzeige(data.von)} – {formatDatumAnzeige(data.bis)})
        </h2>
        <CsvExportButton onClick={() => {
          const kopfzeile = ['Rang', 'Artikel', 'Menge', 'Umsatz (€)', 'Anteil (%)']
          const datenzeilen = data.zeilen.map((z, i) => [
            String(i + 1),
            z.bezeichnung,
            String(z.mengeSumme),
            centZuEuro(z.umsatzCent),
            gesamtUmsatz !== 0 ? String(Math.round(Math.abs(z.umsatzCent / gesamtUmsatz) * 100)) : '0',
          ])
          const fusszeile = ['', 'Gesamt', String(gesamtMenge), centZuEuro(gesamtUmsatz), '100']
          csvHerunterladen(`bericht-artikel_${data.von}_${data.bis}.csv`, [kopfzeile, ...datenzeilen, fusszeile])
        }} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2 font-semibold">#</th>
              <th className="px-4 py-2 font-semibold">Artikel</th>
              <th className="px-4 py-2 font-semibold text-right">Menge</th>
              <th className="px-4 py-2 font-semibold text-right">Umsatz</th>
              <th className="px-4 py-2 font-semibold text-right">Anteil</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.zeilen.map((z, i) => (
              <tr key={z.bezeichnung} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-400 font-mono text-xs">{i + 1}</td>
                <td className="px-4 py-2 text-gray-900">{z.bezeichnung}</td>
                <td className="px-4 py-2 text-right font-mono text-gray-700">{z.mengeSumme}</td>
                <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900">
                  {formatPreis(z.umsatzCent)}
                </td>
                <td className="px-4 py-2 text-right text-gray-500 text-xs">
                  {gesamtUmsatz !== 0 ? `${Math.round(Math.abs(z.umsatzCent / gesamtUmsatz) * 100)} %` : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
              <td className="px-4 py-2" colSpan={2}>Gesamt</td>
              <td className="px-4 py-2 text-right font-mono text-gray-900">{gesamtMenge}</td>
              <td className="px-4 py-2 text-right font-mono text-gray-900">{formatPreis(gesamtUmsatz)}</td>
              <td className="px-4 py-2 text-right text-gray-400 text-xs">100 %</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ergebnis-Darstellung
// ---------------------------------------------------------------------------

function BerichtErgebnis({ data, gruppierung }: { data: BerichtResponse; gruppierung: BerichtGruppierung }) {
  if (data.zeilen.length === 0) {
    return (
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
        Keine Belege im gewählten Zeitraum.
      </div>
    )
  }

  const g = data.gesamt

  return (
    <div className="space-y-4">
      {/* Kennzahlen-Kacheln */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kachel
          label="Netto-Umsatz"
          wert={formatPreis(g.umsatzCent)}
          sub={`${g.anzahlBelege} Belege${g.anzahlStornos > 0 ? `, ${g.anzahlStornos} Stornos` : ''}`}
          hervor
        />
        <Kachel label="Bar"      wert={formatPreis(g.barCent)}      sub={pct(g.barCent,      g.umsatzCent)} />
        <Kachel label="Karte"    wert={formatPreis(g.karteCent)}    sub={pct(g.karteCent,    g.umsatzCent)} />
        <Kachel label="Sonstige" wert={formatPreis(g.sonstigCent)}  sub={pct(g.sonstigCent,  g.umsatzCent)} />
      </div>

      {/* Balkendiagramm */}
      <UmsatzBalkendiagramm data={data} />

      {/* Tabelle */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">
            {data.zeilen.length} {gruppierung === 'tag' ? 'Tage' : gruppierung === 'woche' ? 'Wochen' : 'Monate'}
            {' '}({formatDatumAnzeige(data.von)} – {formatDatumAnzeige(data.bis)})
          </h2>
          <CsvExportButton onClick={() => {
            const kopfzeile = ['Periode', 'Belege', 'Stornos', 'Umsatz (€)', 'Bar (€)', 'Karte (€)', 'Sonstige (€)']
            const datenzeilen = data.zeilen.map(z => [
              z.periode,
              String(z.anzahlBelege),
              String(z.anzahlStornos),
              centZuEuro(z.umsatzCent),
              centZuEuro(z.barCent),
              centZuEuro(z.karteCent),
              centZuEuro(z.sonstigCent),
            ])
            const fusszeile = [
              'Gesamt',
              String(g.anzahlBelege),
              String(g.anzahlStornos),
              centZuEuro(g.umsatzCent),
              centZuEuro(g.barCent),
              centZuEuro(g.karteCent),
              centZuEuro(g.sonstigCent),
            ]
            csvHerunterladen(`bericht-umsatz_${data.von}_${data.bis}.csv`, [kopfzeile, ...datenzeilen, fusszeile])
          }} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 font-semibold">Periode</th>
                <th className="px-4 py-2 font-semibold text-right">Belege</th>
                <th className="px-4 py-2 font-semibold text-right">Stornos</th>
                <th className="px-4 py-2 font-semibold text-right">Umsatz</th>
                <th className="px-4 py-2 font-semibold text-right">Bar</th>
                <th className="px-4 py-2 font-semibold text-right">Karte</th>
                {g.sonstigCent !== 0 && (
                  <th className="px-4 py-2 font-semibold text-right">Sonstig</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.zeilen.map((z) => (
                <tr key={z.periode} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{z.periode}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{z.anzahlBelege}</td>
                  <td className={`px-4 py-2 text-right ${z.anzahlStornos > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                    {z.anzahlStornos > 0 ? z.anzahlStornos : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900">
                    {formatPreis(z.umsatzCent)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700">
                    {z.barCent !== 0 ? formatPreis(z.barCent) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700">
                    {z.karteCent !== 0 ? formatPreis(z.karteCent) : '—'}
                  </td>
                  {g.sonstigCent !== 0 && (
                    <td className="px-4 py-2 text-right font-mono text-gray-700">
                      {z.sonstigCent !== 0 ? formatPreis(z.sonstigCent) : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                <td className="px-4 py-2 text-gray-900">Gesamt</td>
                <td className="px-4 py-2 text-right text-gray-900">{g.anzahlBelege}</td>
                <td className={`px-4 py-2 text-right ${g.anzahlStornos > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                  {g.anzahlStornos > 0 ? g.anzahlStornos : '—'}
                </td>
                <td className="px-4 py-2 text-right font-mono text-gray-900">
                  {formatPreis(g.umsatzCent)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-gray-700">
                  {g.barCent !== 0 ? formatPreis(g.barCent) : '—'}
                </td>
                <td className="px-4 py-2 text-right font-mono text-gray-700">
                  {g.karteCent !== 0 ? formatPreis(g.karteCent) : '—'}
                </td>
                {g.sonstigCent !== 0 && (
                  <td className="px-4 py-2 text-right font-mono text-gray-700">
                    {formatPreis(g.sonstigCent)}
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* USt-Aufteilung */}
      {g.mwst.length > 0 && (
        <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">USt-Aufteilung</h2>
            <CsvExportButton onClick={() => {
              const kopfzeile = ['Steuersatz', 'Brutto (€)', 'Netto (€)', 'USt (€)']
              const datenzeilen = g.mwst.map(z => [
                z.label,
                centZuEuro(z.bruttoCent),
                centZuEuro(z.nettoCent),
                centZuEuro(z.ustCent),
              ])
              csvHerunterladen(`bericht-ust_${data.von}_${data.bis}.csv`, [kopfzeile, ...datenzeilen])
            }} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-semibold">Steuersatz</th>
                  <th className="px-4 py-2 font-semibold text-right">Brutto</th>
                  <th className="px-4 py-2 font-semibold text-right">Netto</th>
                  <th className="px-4 py-2 font-semibold text-right">USt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {g.mwst.map((z) => (
                  <tr key={z.satzKey}>
                    <td className="px-4 py-2 text-gray-700">{z.label}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900">{formatPreis(z.bruttoCent)}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">{formatPreis(z.nettoCent)}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">{formatPreis(z.ustCent)}</td>
                  </tr>
                ))}
                {g.mwst.length > 1 && (
                  <tr className="border-t-2 border-gray-300 font-semibold bg-gray-50">
                    <td className="px-4 py-2 text-gray-900">Gesamt</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900">
                      {formatPreis(g.mwst.reduce((s, z) => s + z.bruttoCent, 0))}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-700">
                      {formatPreis(g.mwst.reduce((s, z) => s + z.nettoCent, 0))}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-700">
                      {formatPreis(g.mwst.reduce((s, z) => s + z.ustCent, 0))}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfs-Komponenten
// ---------------------------------------------------------------------------

function Kachel({ label, wert, sub, hervor }: {
  label:  string
  wert:   string
  sub?:   string
  hervor?: boolean
}) {
  return (
    <div className={`rounded-lg border p-4 ${hervor ? 'bg-brand-50 border-brand-200' : 'bg-white border-gray-200'} shadow-sm`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`font-mono font-semibold text-xl mt-1 ${hervor ? 'text-brand-700' : 'text-gray-900'}`}>
        {wert}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function pct(teil: number, gesamt: number): string {
  if (gesamt === 0) return ''
  return `${Math.round(Math.abs(teil / gesamt) * 100)} %`
}

function formatDatumAnzeige(datum: string): string {
  const [y, m, d] = datum.split('-')
  return `${d}.${m}.${y}`
}

// ---------------------------------------------------------------------------
// CSV-Export-Hilfsfunktionen
// ---------------------------------------------------------------------------

function centZuEuro(cent: number): string {
  return (cent / 100).toFixed(2).replace('.', ',')
}

function escapeCsvCell(v: string): string {
  if (v.includes(';') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}

function csvHerunterladen(dateiname: string, zeilen: string[][]): void {
  // BOM damit Excel in DE/AT direkt korrekt öffnet
  const inhalt = '﻿' + zeilen
    .map(z => z.map(escapeCsvCell).join(';'))
    .join('\r\n')
  const blob = new Blob([inhalt], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function CsvExportButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
    >
      CSV exportieren
    </button>
  )
}

// ---------------------------------------------------------------------------
// Gemeinsamer Filter-Block (Zeitraum + optionale Kasse) — wiederverwendet
// ---------------------------------------------------------------------------

function FilterPanel({
  preset, onPreset, von, onVon, bis, onBis,
  kasseIds, onToggleKasse,
  isLoading, onLaden,
  children,
}: {
  preset: ZeitraumPreset
  onPreset: (p: ZeitraumPreset) => void
  von: string
  onVon: (v: string) => void
  bis: string
  onBis: (v: string) => void
  kasseIds: string[]
  onToggleKasse: (id: string) => void
  isLoading: boolean
  onLaden: () => void
  children?: React.ReactNode
}) {
  const auth = getAuth()!
  const kassenAnzeige = useMemo(() => auth.kassen.map(k => ({
    id: k.id, label: k.bezeichnung ?? k.kassenId,
  })), [auth.kassen])
  const alleKassenGewaehlt = kasseIds.length === 0

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Zeitraum</label>
          <div className="space-y-1">
            {ZEITRAUM_OPTIONEN.map(opt => (
              <button key={opt.key} type="button" onClick={() => onPreset(opt.key)}
                className={`w-full text-left px-3 py-1.5 rounded text-sm transition ${
                  preset === opt.key ? 'bg-brand-50 text-brand-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Datum</label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">Von</span>
                <input type="date" value={von} max={bis}
                  onChange={e => { onVon(e.target.value); onPreset('individuell') }}
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">Bis</span>
                <input type="date" value={bis} min={von} max={heute()}
                  onChange={e => { onBis(e.target.value); onPreset('individuell') }}
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none" />
              </div>
            </div>
          </div>
          {children}
        </div>

        {kassenAnzeige.length > 1 && (
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Kasse</label>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={alleKassenGewaehlt} onChange={() => { for (const k of kassenAnzeige) onToggleKasse(k.id); }} className="rounded" />
                <span className={alleKassenGewaehlt ? 'font-medium text-gray-900' : 'text-gray-600'}>Alle Kassen</span>
              </label>
              {kassenAnzeige.map(k => (
                <label key={k.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={kasseIds.includes(k.id)} onChange={() => onToggleKasse(k.id)} className="rounded" />
                  <span className={kasseIds.includes(k.id) ? 'font-medium text-gray-900' : 'text-gray-600'}>{k.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="pt-2 border-t border-gray-100 flex justify-end">
        <Button onClick={onLaden} loading={isLoading}>Bericht laden</Button>
      </div>
    </div>
  )
}

function useFilterState(initialPreset: ZeitraumPreset = 'monat') {
  const [preset, setPreset]   = useState<ZeitraumPreset>(initialPreset)
  const [von, setVon]         = useState(() => berechneZeitraum(initialPreset, heute()).von)
  const [bis, setBis]         = useState(() => berechneZeitraum(initialPreset, heute()).bis)
  const [kasseIds, setKasseIds] = useState<string[]>([])

  function waehlePreset(p: ZeitraumPreset) {
    setPreset(p)
    if (p !== 'individuell') {
      const { von: v, bis: b } = berechneZeitraum(p, heute())
      setVon(v); setBis(b)
    }
  }
  function toggleKasse(id: string) {
    setKasseIds(prev => prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id])
  }

  return { preset, von, bis, kasseIds, waehlePreset, setVon, setBis, toggleKasse }
}

// ---------------------------------------------------------------------------
// Gesamtumsatz-Übersicht
// ---------------------------------------------------------------------------

function GesamtumsatzBericht() {
  const { preset, von, bis, kasseIds, waehlePreset, setVon, setBis, toggleKasse } = useFilterState()
  const [geladenerFilter, setGeladenerFilter] = useState<{ kasseIds: string[]; von: string; bis: string; gruppierung: 'monat' } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht-gesamt', geladenerFilter],
    queryFn:  () => berichtApi.umsatz({ ...geladenerFilter!, gruppierung: 'monat', nurZielrechnungen: false }),
    enabled:  geladenerFilter !== null,
  })

  return (
    <div className="space-y-6">
      <FilterPanel preset={preset} onPreset={waehlePreset} von={von} onVon={setVon} bis={bis} onBis={setBis}
        kasseIds={kasseIds} onToggleKasse={toggleKasse} isLoading={isLoading}
        onLaden={() => setGeladenerFilter({ kasseIds, von, bis, gruppierung: 'monat' })} />

      {isError && <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error instanceof Error ? error.message : 'Fehler'}</div>}
      {data && <GesamtumsatzErgebnis data={data.gesamt} von={data.von} bis={data.bis} />}
    </div>
  )
}

function GesamtumsatzErgebnis({ data, von, bis }: { data: BerichtGesamt; von: string; bis: string }) {
  const avgBonCent = data.anzahlBelege > 0
    ? Math.round(data.umsatzCent / data.anzahlBelege)
    : 0
  const stornoPct = data.anzahlBelege > 0
    ? Math.round((data.anzahlStornos / data.anzahlBelege) * 100)
    : 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kachel label="Gesamtumsatz"    wert={formatPreis(data.umsatzCent)}    sub={`${formatDatumAnzeige(von)} – ${formatDatumAnzeige(bis)}`} hervor />
        <Kachel label="Anzahl Belege"   wert={String(data.anzahlBelege)}       sub={data.anzahlStornos > 0 ? `${data.anzahlStornos} Stornos (${stornoPct} %)` : 'keine Stornos'} />
        <Kachel label="Ø Bon-Wert"      wert={formatPreis(avgBonCent)}         sub="pro Barzahlungsbeleg" />
        <Kachel label="Bar"             wert={formatPreis(data.barCent)}        sub={pct(data.barCent, data.umsatzCent)} />
      </div>

      {data.mwst.length > 0 && (
        <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">USt-Aufteilung</h2>
            <CsvExportButton onClick={() => {
              const kopfzeile = ['Steuersatz', 'Brutto (€)', 'Netto (€)', 'USt (€)', 'Anteil (%)']
              const datenzeilen = data.mwst.map(z => [
                z.label,
                centZuEuro(z.bruttoCent),
                centZuEuro(z.nettoCent),
                centZuEuro(z.ustCent),
                data.umsatzCent !== 0 ? String(Math.round(Math.abs(z.bruttoCent / data.umsatzCent) * 100)) : '0',
              ])
              csvHerunterladen(`bericht-ust_${von}_${bis}.csv`, [kopfzeile, ...datenzeilen])
            }} />
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Steuersatz</th>
                <th className="px-4 py-2 font-semibold text-right">Brutto</th>
                <th className="px-4 py-2 font-semibold text-right">Netto</th>
                <th className="px-4 py-2 font-semibold text-right">USt</th>
                <th className="px-4 py-2 font-semibold text-right">Anteil</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.mwst.map(z => (
                <tr key={z.satzKey} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-700">{z.label}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-900">{formatPreis(z.bruttoCent)}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-600">{formatPreis(z.nettoCent)}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-600">{formatPreis(z.ustCent)}</td>
                  <td className="px-4 py-2 text-right text-gray-500 text-xs">{pct(z.bruttoCent, data.umsatzCent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Zahlungsart-Bericht
// ---------------------------------------------------------------------------

function ZahlungsartBericht() {
  const { preset, von, bis, kasseIds, waehlePreset, setVon, setBis, toggleKasse } = useFilterState()
  const [geladenerFilter, setGeladenerFilter] = useState<{ kasseIds: string[]; von: string; bis: string; gruppierung: BerichtGruppierung } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht-zahlungsart', geladenerFilter],
    queryFn:  () => berichtApi.umsatz({ ...geladenerFilter!, nurZielrechnungen: false }),
    enabled:  geladenerFilter !== null,
  })

  return (
    <div className="space-y-6">
      <FilterPanel preset={preset} onPreset={waehlePreset} von={von} onVon={setVon} bis={bis} onBis={setBis}
        kasseIds={kasseIds} onToggleKasse={toggleKasse} isLoading={isLoading}
        onLaden={() => setGeladenerFilter({ kasseIds, von, bis, gruppierung: standardGruppierung(preset) })} />

      {isError && <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error instanceof Error ? error.message : 'Fehler'}</div>}
      {data && <ZahlungsartErgebnis data={data} />}
    </div>
  )
}

function ZahlungsartErgebnis({ data }: { data: BerichtResponse }) {
  const g = data.gesamt
  if (g.anzahlBelege === 0) {
    return <div className="rounded-lg bg-white border border-gray-200 p-8 text-center text-sm text-gray-500">Keine Belege im gewählten Zeitraum.</div>
  }

  const zahlarten = [
    { label: 'Barzahlung',  cent: g.barCent,     farbe: 'bg-green-500'  },
    { label: 'Kartenzahlung', cent: g.karteCent,  farbe: 'bg-blue-500'   },
    { label: 'Sonstige',    cent: g.sonstigCent,  farbe: 'bg-purple-500' },
  ].filter(z => z.cent !== 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {zahlarten.map(z => (
          <div key={z.label} className="rounded-lg border border-gray-200 bg-white shadow-sm p-4">
            <div className="flex justify-between items-start mb-2">
              <p className="text-xs text-gray-500">{z.label}</p>
              <span className="text-xs font-medium text-gray-500">{pct(z.cent, g.umsatzCent)}</span>
            </div>
            <p className="font-mono font-semibold text-xl text-gray-900">{formatPreis(z.cent)}</p>
            <div className="mt-3 h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full ${z.farbe}`}
                style={{ width: g.umsatzCent !== 0 ? `${Math.round(Math.abs(z.cent / g.umsatzCent) * 100)}%` : '0%' }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Verlauf ({formatDatumAnzeige(data.von)} – {formatDatumAnzeige(data.bis)})</h2>
          <CsvExportButton onClick={() => {
            const kopfzeile = ['Periode', 'Bar (€)', 'Karte (€)', 'Sonstige (€)', 'Gesamt (€)']
            const datenzeilen = data.zeilen.map(z => [
              z.periode,
              centZuEuro(z.barCent),
              centZuEuro(z.karteCent),
              centZuEuro(z.sonstigCent),
              centZuEuro(z.umsatzCent),
            ])
            const fusszeile = [
              'Gesamt',
              centZuEuro(g.barCent),
              centZuEuro(g.karteCent),
              centZuEuro(g.sonstigCent),
              centZuEuro(g.umsatzCent),
            ]
            csvHerunterladen(`bericht-zahlungsart_${data.von}_${data.bis}.csv`, [kopfzeile, ...datenzeilen, fusszeile])
          }} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 font-semibold">Periode</th>
                <th className="px-4 py-2 font-semibold text-right">Bar</th>
                <th className="px-4 py-2 font-semibold text-right">Karte</th>
                {g.sonstigCent !== 0 && <th className="px-4 py-2 font-semibold text-right">Sonstige</th>}
                <th className="px-4 py-2 font-semibold text-right">Gesamt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.zeilen.map(z => (
                <tr key={z.periode} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{z.periode}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700">{z.barCent !== 0 ? formatPreis(z.barCent) : '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700">{z.karteCent !== 0 ? formatPreis(z.karteCent) : '—'}</td>
                  {g.sonstigCent !== 0 && <td className="px-4 py-2 text-right font-mono text-gray-700">{z.sonstigCent !== 0 ? formatPreis(z.sonstigCent) : '—'}</td>}
                  <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900">{formatPreis(z.umsatzCent)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                <td className="px-4 py-2 text-gray-900">Gesamt</td>
                <td className="px-4 py-2 text-right font-mono">{g.barCent !== 0 ? formatPreis(g.barCent) : '—'}</td>
                <td className="px-4 py-2 text-right font-mono">{g.karteCent !== 0 ? formatPreis(g.karteCent) : '—'}</td>
                {g.sonstigCent !== 0 && <td className="px-4 py-2 text-right font-mono">{formatPreis(g.sonstigCent)}</td>}
                <td className="px-4 py-2 text-right font-mono text-gray-900">{formatPreis(g.umsatzCent)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Warengruppen-Bericht
// ---------------------------------------------------------------------------

function WarengruppeBericht() {
  const { preset, von, bis, kasseIds, waehlePreset, setVon, setBis, toggleKasse } = useFilterState()
  const [geladenerFilter, setGeladenerFilter] = useState<{ kasseIds: string[]; von: string; bis: string } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht-warengruppe', geladenerFilter],
    queryFn:  () => berichtApi.warengruppe(geladenerFilter!),
    enabled:  geladenerFilter !== null,
  })

  return (
    <div className="space-y-6">
      <FilterPanel preset={preset} onPreset={waehlePreset} von={von} onVon={setVon} bis={bis} onBis={setBis}
        kasseIds={kasseIds} onToggleKasse={toggleKasse} isLoading={isLoading}
        onLaden={() => setGeladenerFilter({ kasseIds, von, bis })} />

      {isError && <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error instanceof Error ? error.message : 'Fehler'}</div>}
      {data && <WarengruppeTabelle data={data} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stunden-Bericht (Umsatz nach Tageszeit)
// ---------------------------------------------------------------------------

function StundenBericht() {
  const { preset, von, bis, kasseIds, waehlePreset, setVon, setBis, toggleKasse } = useFilterState()
  const [geladenerFilter, setGeladenerFilter] = useState<{ kasseIds: string[]; von: string; bis: string } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht-stunden', geladenerFilter],
    queryFn:  () => berichtApi.stunden(geladenerFilter!),
    enabled:  geladenerFilter !== null,
  })

  return (
    <div className="space-y-6">
      <FilterPanel preset={preset} onPreset={waehlePreset} von={von} onVon={setVon} bis={bis} onBis={setBis}
        kasseIds={kasseIds} onToggleKasse={toggleKasse} isLoading={isLoading}
        onLaden={() => setGeladenerFilter({ kasseIds, von, bis })} />

      {isError && <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error instanceof Error ? error.message : 'Fehler'}</div>}
      {data && <StundenDiagramm data={data} />}
    </div>
  )
}

function StundenDiagramm({ data }: { data: StundenBerichtResponse }) {
  const maxUmsatz = Math.max(...data.zeilen.map(z => z.umsatzCent), 1)
  const gesamtUmsatz = data.gesamt.umsatzCent

  if (gesamtUmsatz === 0) {
    return (
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
        Keine Belege im gewählten Zeitraum.
      </div>
    )
  }

  // Geschäftszeiten ermitteln (erste/letzte Stunde mit Umsatz)
  const aktiveStunden = data.zeilen.filter(z => z.umsatzCent > 0)
  const ersteStunde = aktiveStunden[0]?.stunde ?? 0
  const letzteStunde = aktiveStunden[aktiveStunden.length - 1]?.stunde ?? 23
  // ±2 Stunden Puffer
  const von = Math.max(0, ersteStunde - 1)
  const bis = Math.min(23, letzteStunde + 1)
  const angezeigteZeilen = data.zeilen.slice(von, bis + 1)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kachel label="Gesamtumsatz"  wert={formatPreis(gesamtUmsatz)}       sub={`${formatDatumAnzeige(data.von)} – ${formatDatumAnzeige(data.bis)}`} hervor />
        <Kachel label="Anzahl Belege" wert={String(data.gesamt.anzahlBelege)} {...(data.gesamt.anzahlStornos > 0 ? { sub: `${data.gesamt.anzahlStornos} Stornos` } : {})} />
        <Kachel label="Spitzenstunde" wert={`${data.zeilen.reduce((best: StundenBerichtZeile, z: StundenBerichtZeile) => z.umsatzCent > best.umsatzCent ? z : best, data.zeilen[0]!).stunde}:00 Uhr`} sub={formatPreis(maxUmsatz)} />
        <Kachel label="Aktive Stunden" wert={String(aktiveStunden.length)} sub="Stunden mit Umsatz" />
      </div>

      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">
            Umsatz nach Tageszeit ({formatDatumAnzeige(data.von)} – {formatDatumAnzeige(data.bis)})
          </h2>
          <CsvExportButton onClick={() => {
            const kopfzeile = ['Stunde', 'Belege', 'Umsatz (€)', 'Bar (€)', 'Karte (€)']
            const datenzeilen = data.zeilen.map(z => [
              `${z.stunde}:00`,
              String(z.anzahlBelege),
              centZuEuro(z.umsatzCent),
              centZuEuro(z.barCent),
              centZuEuro(z.karteCent),
            ])
            csvHerunterladen(`bericht-stunden_${data.von}_${data.bis}.csv`, [kopfzeile, ...datenzeilen])
          }} />
        </div>
        <div className="px-4 py-4 space-y-1.5">
          {angezeigteZeilen.map(z => {
            const balkenBreite = maxUmsatz > 0 ? Math.round((z.umsatzCent / maxUmsatz) * 100) : 0
            const istSpitze = z.umsatzCent === maxUmsatz && z.umsatzCent > 0
            return (
              <div key={z.stunde} className="flex items-center gap-3 group">
                <span className="text-xs font-mono text-gray-500 w-12 shrink-0 text-right">
                  {z.stunde.toString().padStart(2, '0')}:00
                </span>
                <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden">
                  <div
                    className={`h-full rounded transition-all ${istSpitze ? 'bg-brand-500' : 'bg-brand-300'}`}
                    style={{ width: `${balkenBreite}%` }}
                  />
                </div>
                <span className={`text-xs font-mono w-28 shrink-0 text-right ${z.umsatzCent > 0 ? 'text-gray-900 font-semibold' : 'text-gray-300'}`}>
                  {z.umsatzCent > 0 ? formatPreis(z.umsatzCent) : '—'}
                </span>
                <span className="text-xs text-gray-400 w-14 shrink-0 text-right">
                  {z.anzahlBelege > 0 ? `${z.anzahlBelege} Bel.` : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Detailtabelle */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Stundendetails</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 font-semibold">Stunde</th>
                <th className="px-4 py-2 font-semibold text-right">Belege</th>
                <th className="px-4 py-2 font-semibold text-right">Umsatz</th>
                <th className="px-4 py-2 font-semibold text-right">Bar</th>
                <th className="px-4 py-2 font-semibold text-right">Karte</th>
                <th className="px-4 py-2 font-semibold text-right">Anteil</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.zeilen.filter(z => z.umsatzCent > 0).map(z => (
                <tr key={z.stunde} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900 font-mono">
                    {z.stunde.toString().padStart(2, '0')}:00–{(z.stunde + 1).toString().padStart(2, '0')}:00
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700">{z.anzahlBelege}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900">{formatPreis(z.umsatzCent)}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-600">{z.barCent > 0 ? formatPreis(z.barCent) : '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-600">{z.karteCent > 0 ? formatPreis(z.karteCent) : '—'}</td>
                  <td className="px-4 py-2 text-right text-gray-500 text-xs">
                    {gesamtUmsatz > 0 ? `${Math.round((z.umsatzCent / gesamtUmsatz) * 100)} %` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Umsatz-Balkendiagramm (vertikale Balken, rein CSS)
// ---------------------------------------------------------------------------

function UmsatzBalkendiagramm({ data }: { data: BerichtResponse }) {
  if (data.zeilen.length < 2) return null

  const maxCent = Math.max(...data.zeilen.map(z => z.umsatzCent), 1)
  const BAR_H   = 120 // px — max Balkenhöhe

  // Bei mehr als 31 Balken jeden zweiten überspringen
  const zeilen = data.zeilen.length > 31
    ? data.zeilen.filter((_, i) => i % 2 === 0)
    : data.zeilen

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-700">Verlauf</h2>
      </div>
      <div className="px-4 pt-4 pb-2 overflow-x-auto">
        <div
          className="flex items-end gap-1"
          style={{ minWidth: `${zeilen.length * 28}px`, height: `${BAR_H + 36}px` }}
        >
          {zeilen.map(z => {
            const barH = maxCent > 0 ? Math.max(2, Math.round((z.umsatzCent / maxCent) * BAR_H)) : 0
            return (
              <div
                key={z.periode}
                className="relative flex flex-col items-center flex-1 min-w-[20px] group"
                style={{ height: `${BAR_H + 36}px` }}
              >
                {/* Tooltip */}
                <div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center z-10 pointer-events-none">
                  <div className="bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap">
                    <span className="font-medium">{z.periode}</span>
                    <br />
                    <span className="font-mono">{formatPreis(z.umsatzCent)}</span>
                    {z.anzahlBelege > 0 && (
                      <><br /><span className="text-gray-300">{z.anzahlBelege} Bel.</span></>
                    )}
                  </div>
                  <div className="w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900" />
                </div>
                {/* Balken-Bereich */}
                <div className="flex-1 flex items-end w-full">
                  <div
                    className={`w-full rounded-t transition-colors ${
                      z.umsatzCent > 0 ? 'bg-brand-400 group-hover:bg-brand-500' : 'bg-gray-100'
                    }`}
                    style={{ height: `${barH}px` }}
                  />
                </div>
                {/* Label */}
                <span className="text-[9px] text-gray-400 mt-1 w-full text-center truncate leading-tight px-0.5">
                  {z.periode.length > 7 ? z.periode.slice(-5) : z.periode}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vergleich-Bericht (Aktueller Zeitraum vs. Vorperiode)
// ---------------------------------------------------------------------------

type VergleichPreset = 'woche' | 'monat' | 'jahr'

const VERGLEICH_OPTIONEN: { key: VergleichPreset; label: string; sublabel: string }[] = [
  { key: 'woche', label: 'Diese Woche',   sublabel: 'vs. Vorwoche' },
  { key: 'monat', label: 'Dieser Monat',  sublabel: 'vs. Vormonat' },
  { key: 'jahr',  label: 'Dieses Jahr',   sublabel: 'vs. Vorjahr'  },
]

function berechneVergleichsZeitraeume(preset: VergleichPreset, h: string): {
  vonAkt: string; bisAkt: string
  vonVor: string; bisVor: string
} {
  switch (preset) {
    case 'woche': {
      const vonAkt = startDerWoche(h)
      const bisAkt = addTage(vonAkt, 6)
      return { vonAkt, bisAkt, vonVor: addTage(vonAkt, -7), bisVor: addTage(vonAkt, -1) }
    }
    case 'monat': {
      const vonAkt = startDesMonats(h)
      const bisAkt = endeDesMonats(h)
      // Vormonat: einen Monat zurück
      const d = new Date(vonAkt)
      d.setMonth(d.getMonth() - 1)
      const vonVor = d.toLocaleDateString('sv-SE')
      return { vonAkt, bisAkt, vonVor, bisVor: endeDesMonats(vonVor) }
    }
    case 'jahr': {
      const y    = parseInt(h.slice(0, 4))
      const vonAkt = `${y}-01-01`
      const bisAkt = `${y}-12-31`
      return { vonAkt, bisAkt, vonVor: `${y - 1}-01-01`, bisVor: `${y - 1}-12-31` }
    }
  }
}

function VergleichBericht() {
  const auth = getAuth()!
  const [preset, setPreset]     = useState<VergleichPreset>('woche')
  const [kasseIds, setKasseIds] = useState<string[]>([])
  const [geladen, setGeladen]   = useState<{
    vonAkt: string; bisAkt: string
    vonVor: string; bisVor: string
    kasseIds: string[]
  } | null>(null)

  // Zwei parallele Queries — immer mit zwei Einträgen (stabiles Tupel), enabled steuert Ausführung
  const [aktResult, vorResult] = useQueries({
    queries: [
      {
        queryKey: ['bericht-vergleich-akt', geladen] as const,
        queryFn:  () => berichtApi.umsatz({
          kasseIds:          geladen!.kasseIds,
          von:               geladen!.vonAkt,
          bis:               geladen!.bisAkt,
          gruppierung:       'tag' as const,
          nurZielrechnungen: false,
        }),
        enabled: geladen !== null,
      },
      {
        queryKey: ['bericht-vergleich-vor', geladen] as const,
        queryFn:  () => berichtApi.umsatz({
          kasseIds:          geladen!.kasseIds,
          von:               geladen!.vonVor,
          bis:               geladen!.bisVor,
          gruppierung:       'tag' as const,
          nurZielrechnungen: false,
        }),
        enabled: geladen !== null,
      },
    ],
  })

  const isLoading = aktResult.isLoading || vorResult.isLoading
  const isError   = aktResult.isError   || vorResult.isError

  const kassenAnzeige = useMemo(
    () => auth.kassen.map(k => ({ id: k.id, label: k.bezeichnung ?? k.kassenId })),
    [auth.kassen],
  )
  const alleKassenGewaehlt = kasseIds.length === 0

  function toggleKasse(id: string) {
    setKasseIds(prev => prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id])
  }

  function ladeBericht() {
    const zt = berechneVergleichsZeitraeume(preset, heute())
    setGeladen({ ...zt, kasseIds })
  }

  const optionInfo = VERGLEICH_OPTIONEN.find(o => o.key === preset)!

  return (
    <div className="space-y-6">
      {/* Filter */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {/* Preset-Auswahl */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Vergleich
            </label>
            <div className="space-y-2">
              {VERGLEICH_OPTIONEN.map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setPreset(opt.key)}
                  className={`w-full text-left px-3 py-2 rounded border transition ${
                    preset === opt.key
                      ? 'bg-brand-50 border-brand-300 text-brand-700'
                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <div className="text-sm font-medium">{opt.label}</div>
                  <div className="text-xs text-gray-400">{opt.sublabel}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Zeitraum-Vorschau */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Zeiträume
            </label>
            {(() => {
              const zt = berechneVergleichsZeitraeume(preset, heute())
              return (
                <div className="space-y-3">
                  <div className="rounded border border-brand-200 bg-brand-50 p-3">
                    <p className="text-xs font-semibold text-brand-700 mb-0.5">Aktueller Zeitraum</p>
                    <p className="text-sm font-mono text-brand-900">
                      {formatDatumAnzeige(zt.vonAkt)} – {formatDatumAnzeige(zt.bisAkt)}
                    </p>
                  </div>
                  <div className="rounded border border-gray-200 bg-gray-50 p-3">
                    <p className="text-xs font-semibold text-gray-500 mb-0.5">Vorperiode</p>
                    <p className="text-sm font-mono text-gray-700">
                      {formatDatumAnzeige(zt.vonVor)} – {formatDatumAnzeige(zt.bisVor)}
                    </p>
                  </div>
                </div>
              )
            })()}
          </div>

          {/* Kassen */}
          {kassenAnzeige.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Kasse</label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={alleKassenGewaehlt} onChange={() => setKasseIds([])} className="rounded" />
                  <span className={alleKassenGewaehlt ? 'font-medium text-gray-900' : 'text-gray-600'}>Alle Kassen</span>
                </label>
                {kassenAnzeige.map(k => (
                  <label key={k.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={kasseIds.includes(k.id)} onChange={() => toggleKasse(k.id)} className="rounded" />
                    <span className={kasseIds.includes(k.id) ? 'font-medium text-gray-900' : 'text-gray-600'}>{k.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-gray-100 flex justify-end">
          <Button onClick={ladeBericht} loading={isLoading}>
            {optionInfo.label} vs. {optionInfo.sublabel.replace('vs. ', '')} laden
          </Button>
        </div>
      </div>

      {isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Fehler beim Laden eines Berichts
        </div>
      )}

      {aktResult.data && vorResult.data && (
        <VergleichErgebnis
          akt={aktResult.data}
          vor={vorResult.data}
          aktLabel={optionInfo.label}
          vorLabel={optionInfo.sublabel.replace('vs. ', '')}
        />
      )}
    </div>
  )
}

function VergleichErgebnis({
  akt, vor, aktLabel, vorLabel,
}: {
  akt:      BerichtResponse
  vor:      BerichtResponse
  aktLabel: string
  vorLabel: string
}) {
  const a = akt.gesamt
  const v = vor.gesamt

  const delta        = a.umsatzCent - v.umsatzCent
  const deltaPct     = v.umsatzCent !== 0 ? Math.round((delta / Math.abs(v.umsatzCent)) * 100) : null
  const deltaPositiv = delta >= 0

  const deltaBarCent   = a.barCent   - v.barCent
  const deltaKarteCent = a.karteCent - v.karteCent
  const deltaBelege    = a.anzahlBelege - v.anzahlBelege

  /** Kleines farbiges Chip mit Pfeil für Delta-Werte */
  function absDeltaChip(wert: number, fmtFn: (n: number) => string) {
    const pos = wert >= 0
    return (
      <span className={`inline-flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded ${
        pos ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
      }`}>
        {pos ? '▲' : '▼'} {fmtFn(Math.abs(wert))}
      </span>
    )
  }

  const zahlarten = [
    { label: 'Barzahlung',    aktCent: a.barCent,   vorCent: v.barCent,   deltaCent: deltaBarCent   },
    { label: 'Kartenzahlung', aktCent: a.karteCent, vorCent: v.karteCent, deltaCent: deltaKarteCent },
  ].filter(z => z.aktCent !== 0 || z.vorCent !== 0)

  return (
    <div className="space-y-4">
      {/* KPI-Kacheln */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-brand-200 bg-brand-50 shadow-sm p-4">
          <p className="text-xs text-brand-600 font-medium">{aktLabel}</p>
          <p className="font-mono font-bold text-xl mt-1 text-brand-800">{formatPreis(a.umsatzCent)}</p>
          <p className="text-xs text-brand-500 mt-0.5">{a.anzahlBelege} Belege</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm p-4">
          <p className="text-xs text-gray-500 font-medium">{vorLabel}</p>
          <p className="font-mono font-semibold text-xl mt-1 text-gray-700">{formatPreis(v.umsatzCent)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{v.anzahlBelege} Belege</p>
        </div>
        <div className={`rounded-lg border shadow-sm p-4 ${deltaPositiv ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          <p className={`text-xs font-medium ${deltaPositiv ? 'text-green-600' : 'text-red-600'}`}>Differenz</p>
          <p className={`font-mono font-bold text-xl mt-1 ${deltaPositiv ? 'text-green-800' : 'text-red-800'}`}>
            {delta >= 0 ? '+' : ''}{formatPreis(delta)}
          </p>
          <p className={`text-xs mt-0.5 ${deltaPositiv ? 'text-green-500' : 'text-red-500'}`}>
            {deltaBelege >= 0 ? '+' : ''}{deltaBelege} Belege
          </p>
        </div>
        <div className={`rounded-lg border shadow-sm p-4 ${deltaPositiv ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          <p className={`text-xs font-medium ${deltaPositiv ? 'text-green-600' : 'text-red-600'}`}>Veränderung</p>
          <p className={`font-mono font-bold text-2xl mt-1 ${deltaPositiv ? 'text-green-800' : 'text-red-800'}`}>
            {deltaPct !== null
              ? `${deltaPct >= 0 ? '+' : ''}${deltaPct} %`
              : v.umsatzCent === 0 ? '—' : '>999 %'}
          </p>
          <p className={`text-xs mt-0.5 ${deltaPositiv ? 'text-green-500' : 'text-red-500'}`}>
            {deltaPositiv ? 'Zuwachs' : 'Rückgang'}
          </p>
        </div>
      </div>

      {/* Zahlungsarten-Vergleich */}
      {zahlarten.length > 0 && (
        <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-700">Zahlungsarten</h2>
          </div>
          <div className="p-4 space-y-4">
            {zahlarten.map(z => {
              const maxV = Math.max(z.aktCent, z.vorCent, 1)
              return (
                <div key={z.label}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-gray-700">{z.label}</span>
                    {absDeltaChip(z.deltaCent, formatPreis)}
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-brand-600 w-20 shrink-0 font-medium">{aktLabel}</span>
                      <div className="flex-1 h-5 bg-brand-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-brand-400"
                          style={{ width: `${Math.round((z.aktCent / maxV) * 100)}%` }} />
                      </div>
                      <span className="text-xs font-mono text-gray-700 w-24 text-right shrink-0">{formatPreis(z.aktCent)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 w-20 shrink-0">{vorLabel}</span>
                      <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-gray-300"
                          style={{ width: `${Math.round((z.vorCent / maxV) * 100)}%` }} />
                      </div>
                      <span className="text-xs font-mono text-gray-400 w-24 text-right shrink-0">{formatPreis(z.vorCent)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Vergleichs-Tabelle */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Kennzahlen im Vergleich</h2>
          <CsvExportButton onClick={() => {
            const kopfzeile = ['Kennzahl', aktLabel, vorLabel, 'Differenz', 'Veränderung (%)']
            const rows: string[][] = [
              ['Umsatz (€)',   centZuEuro(a.umsatzCent), centZuEuro(v.umsatzCent), centZuEuro(delta),         deltaPct !== null ? `${deltaPct}` : ''],
              ['Bar (€)',      centZuEuro(a.barCent),    centZuEuro(v.barCent),    centZuEuro(deltaBarCent),   ''],
              ['Karte (€)',    centZuEuro(a.karteCent),  centZuEuro(v.karteCent),  centZuEuro(deltaKarteCent), ''],
              ['Belege',       String(a.anzahlBelege),   String(v.anzahlBelege),   String(deltaBelege),        ''],
            ]
            csvHerunterladen(`bericht-vergleich_${akt.von}_vs_${vor.von}.csv`, [kopfzeile, ...rows])
          }} />
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2 font-semibold text-left">Kennzahl</th>
              <th className="px-4 py-2 font-semibold text-right text-brand-700">{aktLabel}</th>
              <th className="px-4 py-2 font-semibold text-right text-gray-500">{vorLabel}</th>
              <th className="px-4 py-2 font-semibold text-right">Differenz</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            <VergleichZeile label="Netto-Umsatz"  aktStr={formatPreis(a.umsatzCent)} vorStr={formatPreis(v.umsatzCent)} deltaStr={`${delta >= 0 ? '+' : ''}${formatPreis(delta)}`}  pos={delta >= 0} />
            <VergleichZeile label="Barzahlung"    aktStr={formatPreis(a.barCent)}    vorStr={formatPreis(v.barCent)}    deltaStr={`${deltaBarCent >= 0 ? '+' : ''}${formatPreis(deltaBarCent)}`}    pos={deltaBarCent >= 0} />
            <VergleichZeile label="Kartenzahlung" aktStr={formatPreis(a.karteCent)}  vorStr={formatPreis(v.karteCent)}  deltaStr={`${deltaKarteCent >= 0 ? '+' : ''}${formatPreis(deltaKarteCent)}`}  pos={deltaKarteCent >= 0} />
            <VergleichZeile label="Belege"        aktStr={String(a.anzahlBelege)}    vorStr={String(v.anzahlBelege)}    deltaStr={`${deltaBelege >= 0 ? '+' : ''}${deltaBelege}`}                     pos={deltaBelege >= 0} />
          </tbody>
        </table>
        <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-400">
          {aktLabel}: {formatDatumAnzeige(akt.von)} – {formatDatumAnzeige(akt.bis)}
          {' · '}
          {vorLabel}: {formatDatumAnzeige(vor.von)} – {formatDatumAnzeige(vor.bis)}
        </div>
      </div>
    </div>
  )
}

function VergleichZeile({ label, aktStr, vorStr, deltaStr, pos }: {
  label:    string
  aktStr:   string
  vorStr:   string
  deltaStr: string
  pos:      boolean
}) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-2 text-gray-700">{label}</td>
      <td className="px-4 py-2 text-right font-mono font-semibold text-brand-800">{aktStr}</td>
      <td className="px-4 py-2 text-right font-mono text-gray-500">{vorStr}</td>
      <td className={`px-4 py-2 text-right font-mono text-xs ${pos ? 'text-green-700' : 'text-red-700'}`}>
        {deltaStr}
      </td>
    </tr>
  )
}

function WarengruppeTabelle({ data }: { data: WarengruppeBerichtResponse }) {
  if (data.zeilen.length === 0) {
    return <div className="rounded-lg bg-white border border-gray-200 p-8 text-center text-sm text-gray-500">Keine Belege im gewählten Zeitraum.</div>
  }

  const gesamtUmsatz = data.zeilen.reduce((s, z) => s + z.umsatzCent, 0)

  return (
    <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          {data.zeilen.length} Warengruppen ({formatDatumAnzeige(data.von)} – {formatDatumAnzeige(data.bis)})
        </h2>
        <CsvExportButton onClick={() => {
          const kopfzeile = ['Warengruppe', 'Menge', 'Umsatz (€)', 'Anteil (%)']
          const datenzeilen = data.zeilen.map(z => [
            z.kategorieName,
            String(z.mengeSumme),
            centZuEuro(z.umsatzCent),
            gesamtUmsatz !== 0 ? String(Math.round(Math.abs(z.umsatzCent / gesamtUmsatz) * 100)) : '0',
          ])
          const fusszeile = [
            'Gesamt',
            String(data.zeilen.reduce((s, z) => s + z.mengeSumme, 0)),
            centZuEuro(gesamtUmsatz),
            '100',
          ]
          csvHerunterladen(`bericht-warengruppe_${data.von}_${data.bis}.csv`, [kopfzeile, ...datenzeilen, fusszeile])
        }} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2 font-semibold">Warengruppe</th>
              <th className="px-4 py-2 font-semibold text-right">Menge</th>
              <th className="px-4 py-2 font-semibold text-right">Umsatz</th>
              <th className="px-4 py-2 font-semibold text-right">Anteil</th>
              <th className="px-4 py-2 font-semibold">Verteilung</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.zeilen.map(z => {
              const anteil = gesamtUmsatz !== 0 ? Math.round(Math.abs(z.umsatzCent / gesamtUmsatz) * 100) : 0
              return (
                <tr key={z.kategorieName} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-900 font-medium">{z.kategorieName}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700">{z.mengeSumme}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900">{formatPreis(z.umsatzCent)}</td>
                  <td className="px-4 py-2 text-right text-gray-500 text-xs">{anteil} %</td>
                  <td className="px-4 py-2 w-32">
                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${anteil}%` }} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
              <td className="px-4 py-2 text-gray-900">Gesamt</td>
              <td className="px-4 py-2 text-right font-mono">{data.zeilen.reduce((s, z) => s + z.mengeSumme, 0)}</td>
              <td className="px-4 py-2 text-right font-mono text-gray-900">{formatPreis(gesamtUmsatz)}</td>
              <td className="px-4 py-2 text-right text-gray-400 text-xs">100 %</td>
              <td className="px-4 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kellner-Bericht
// ---------------------------------------------------------------------------

function KellnerBericht() {
  const auth = getAuth()!

  const [preset,   setPreset]   = useState<ZeitraumPreset>('monat')
  const [von,      setVon]      = useState(() => berechneZeitraum('monat', heute()).von)
  const [bis,      setBis]      = useState(() => berechneZeitraum('monat', heute()).bis)
  const [kasseIds, setKasseIds] = useState<string[]>([])
  const [geladenerFilter, setGeladenerFilter] = useState<{
    kasseIds: string[]; von: string; bis: string
  } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht-kellner', geladenerFilter],
    queryFn:  () => berichtApi.kellner(geladenerFilter!),
    enabled:  geladenerFilter !== null,
  })

  const ladeBericht = useCallback(() => setGeladenerFilter({ kasseIds, von, bis }), [kasseIds, von, bis])

  function waehlePreset(p: ZeitraumPreset) {
    setPreset(p)
    if (p !== 'individuell') {
      const { von: v, bis: b } = berechneZeitraum(p, heute())
      setVon(v); setBis(b)
    }
  }

  const kassenAnzeige = useMemo(() => auth.kassen.map(k => ({
    id: k.id, label: k.bezeichnung ?? k.kassenId,
  })), [auth.kassen])

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Zeitraum</label>
            <div className="space-y-1">
              {ZEITRAUM_OPTIONEN.map(opt => (
                <button key={opt.key} type="button" onClick={() => waehlePreset(opt.key)}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm transition ${preset === opt.key ? 'bg-brand-50 text-brand-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Datum</label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">Von</span>
                <input type="date" value={von} max={bis} onChange={e => { setVon(e.target.value); setPreset('individuell') }}
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 outline-none" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">Bis</span>
                <input type="date" value={bis} min={von} max={heute()} onChange={e => { setBis(e.target.value); setPreset('individuell') }}
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 outline-none" />
              </div>
            </div>
          </div>
          {kassenAnzeige.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Kasse</label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={kasseIds.length === 0} onChange={() => setKasseIds([])} className="rounded" />
                  <span className={kasseIds.length === 0 ? 'font-medium text-gray-900' : 'text-gray-600'}>Alle Kassen</span>
                </label>
                {kassenAnzeige.map(k => (
                  <label key={k.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={kasseIds.includes(k.id)}
                      onChange={() => setKasseIds(prev => prev.includes(k.id) ? prev.filter(x => x !== k.id) : [...prev, k.id])}
                      className="rounded" />
                    <span className={kasseIds.includes(k.id) ? 'font-medium text-gray-900' : 'text-gray-600'}>{k.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="pt-2 border-t border-gray-100 flex justify-end">
          <Button onClick={ladeBericht} loading={isLoading}>Bericht laden</Button>
        </div>
      </div>

      {isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error ? error.message : 'Fehler beim Laden'}
        </div>
      )}
      {data && <KellnerBerichtTabelle data={data} />}
    </div>
  )
}

function KellnerBerichtTabelle({ data }: { data: KellnerBerichtResponse }) {
  const maxUmsatz = Math.max(...data.zeilen.map(z => Math.abs(z.umsatzCent)), 1)

  if (data.zeilen.length === 0) {
    return <p className="text-sm text-gray-500">Keine Daten für diesen Zeitraum.</p>
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {([
          { label: 'Kellner',       wert: data.zeilen.length,        fmt: (n: number) => String(n) },
          { label: 'Belege gesamt', wert: data.gesamt.anzahlBelege,  fmt: (n: number) => String(n) },
          { label: 'Umsatz gesamt', wert: data.gesamt.umsatzCent,    fmt: formatPreis },
          { label: 'Ø pro Kellner', wert: data.zeilen.length > 0 ? Math.round(data.gesamt.umsatzCent / data.zeilen.length) : 0, fmt: formatPreis },
        ] as const).map(k => (
          <div key={k.label} className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500">{k.label}</p>
            <p className="mt-1 text-xl font-bold text-gray-900">{k.fmt(k.wert)}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Kellner</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Belege</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Stornos</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Bar</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Karte</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Umsatz</th>
              <th className="px-4 py-3 w-28" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.zeilen.map((z: KellnerBerichtZeile) => {
              const anteil = Math.round(Math.abs(z.umsatzCent / maxUmsatz) * 100)
              return (
                <tr key={z.kellner} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{z.kellner}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-700">{z.anzahlBelege}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-500">{z.anzahlStornos || '—'}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-700">{formatPreis(z.barCent)}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-700">{formatPreis(z.karteCent)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-gray-900">{formatPreis(z.umsatzCent)}</td>
                  <td className="px-4 py-3">
                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${anteil}%` }} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
              <td className="px-4 py-3 text-gray-900">Gesamt</td>
              <td className="px-4 py-3 text-right font-mono">{data.gesamt.anzahlBelege}</td>
              <td className="px-4 py-3 text-right font-mono text-gray-500">{data.gesamt.anzahlStornos || '—'}</td>
              <td className="px-4 py-3 text-right font-mono">{formatPreis(data.gesamt.barCent)}</td>
              <td className="px-4 py-3 text-right font-mono">{formatPreis(data.gesamt.karteCent)}</td>
              <td className="px-4 py-3 text-right font-mono text-gray-900">{formatPreis(data.gesamt.umsatzCent)}</td>
              <td className="px-4 py-3" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
