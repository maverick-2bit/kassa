import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BerichtGruppierung, BerichtResponse } from '@kassa/shared'
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

export function BerichtePage() {
  const auth = getAuth()!

  const [preset, setPreset]       = useState<ZeitraumPreset>('monat')
  const [von, setVon]             = useState(() => berechneZeitraum('monat', heute()).von)
  const [bis, setBis]             = useState(() => berechneZeitraum('monat', heute()).bis)
  const [gruppierung, setGruppierung] = useState<BerichtGruppierung>('woche')
  const [kasseIds, setKasseIds]   = useState<string[]>([])  // leer = alle
  const [nurZiel, setNurZiel]     = useState(false)
  const [geladenerFilter, setGeladenerFilter] = useState<{
    kasseIds:          string[]
    von:               string
    bis:               string
    nurZielrechnungen: boolean
    gruppierung:       BerichtGruppierung
  } | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bericht', geladenerFilter],
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
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      {/* Kopfzeile */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Umsatzbericht</h1>
        <p className="mt-1 text-sm text-gray-500">
          Umsatzauswertung nach Zeitraum, Kasse und Zahlungsart
        </p>
      </div>

      {/* Filter-Panel */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">

          {/* Zeitraum-Preset */}
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

          {/* Von / Bis + Gruppierung */}
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

          {/* Kassen + Zielrechnungen */}
          <div className="space-y-3">
            {kassenAnzeige.length > 1 && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Kasse
                </label>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={alleKassenGewaehlt}
                      onChange={() => setKasseIds([])}
                      className="rounded"
                    />
                    <span className={alleKassenGewaehlt ? 'font-medium text-gray-900' : 'text-gray-600'}>
                      Alle Kassen
                    </span>
                  </label>
                  {kassenAnzeige.map(k => (
                    <label key={k.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kasseIds.includes(k.id)}
                        onChange={() => toggleKasse(k.id)}
                        className="rounded"
                      />
                      <span className={kasseIds.includes(k.id) ? 'font-medium text-gray-900' : 'text-gray-600'}>
                        {k.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Filter
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={nurZiel}
                  onChange={(e) => setNurZiel(e.target.checked)}
                  className="rounded"
                />
                <span>Nur Zielrechnungen</span>
              </label>
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-gray-100 flex justify-end">
          <Button onClick={ladeBericht} loading={isLoading}>
            Bericht laden
          </Button>
        </div>
      </div>

      {/* Fehler */}
      {isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error ? error.message : 'Fehler beim Laden'}
        </div>
      )}

      {/* Ergebnis */}
      {data && <BerichtErgebnis data={data} gruppierung={geladenerFilter!.gruppierung} />}
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

      {/* Tabelle */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">
            {data.zeilen.length} {gruppierung === 'tag' ? 'Tage' : gruppierung === 'woche' ? 'Wochen' : 'Monate'}
            {' '}({formatDatumAnzeige(data.von)} – {formatDatumAnzeige(data.bis)})
          </h2>
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
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-700">USt-Aufteilung</h2>
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
