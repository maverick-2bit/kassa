/**
 * Bestellliste — Bestellvorschlag aus dem Verbrauch der letzten Tage (Artikel & Lager).
 *
 * Vorschlag = Bedarf für die Reichweite + Mindestbestand − Lagerstand − unterwegs (bestellt, nicht geliefert).
 * Die Rechnung macht der Server (GET /api/einkauf/bestellvorschlag), hier wird gefiltert, geändert, exportiert,
 * gedruckt und je Lieferant die Bestellung angelegt.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BESTELLVORSCHLAG_STANDARD_TAGE, type Lieferant } from '@kassa/shared'
import { einkaufBestellungApi, lieferantApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { heuteKalendertag } from '../lib/geschaeftstag'
import { berichtPdfVorschauUrl, downloadBerichtPdf } from '../lib/pdf'
import { alsCsv, bestellvorschlagTabelle, ladeCsvHerunter, type ExportZeile } from '../lib/bestellvorschlagExport'
import { PdfVorschauModal } from '../components/PdfVorschauModal'

const OHNE = '__ohne__'
const zahl = (n: number) => n.toLocaleString('de-AT', { maximumFractionDigits: 2 })

export function BestelllistePage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tage, setTage] = useState(BESTELLVORSCHLAG_STANDARD_TAGE)
  const [reichweite, setReichweite] = useState(BESTELLVORSCHLAG_STANDARD_TAGE)
  const [nurMitVorschlag, setNurMitVorschlag] = useState(true)
  const [filterLieferant, setFilterLieferant] = useState<string>('alle')
  const [mengen, setMengen] = useState<Record<string, number>>({})
  const [fehler, setFehler] = useState<string | null>(null)
  const [vorschauUrl, setVorschauUrl] = useState<string | null>(null)

  const vorschlagQ = useQuery({
    queryKey: ['bestellvorschlag', tage, reichweite],
    queryFn:  () => einkaufBestellungApi.vorschlag({ tage, reichweite }),
  })
  const { data: lieferanten = [] } = useQuery({ queryKey: ['lieferanten'], queryFn: lieferantApi.list })
  const lieferantenMap = useMemo(() => new Map(lieferanten.map((l: Lieferant) => [l.id, l])), [lieferanten])
  const lieferantName = (id: string | null) => (id && lieferantenMap.get(id)?.name) || 'Ohne Lieferant'

  const zeilen: ExportZeile[] = useMemo(() => (vorschlagQ.data?.zeilen ?? [])
    .map(z => ({ ...z, bestellmenge: mengen[z.artikelId] ?? z.vorschlag }))
    .filter(z => !nurMitVorschlag || z.vorschlag > 0 || (mengen[z.artikelId] ?? 0) > 0)
    .filter(z => filterLieferant === 'alle' || (filterLieferant === OHNE ? !z.lieferantId : z.lieferantId === filterLieferant)),
  [vorschlagQ.data, mengen, nurMitVorschlag, filterLieferant])

  const gruppen = useMemo(() => {
    const map = new Map<string, ExportZeile[]>()
    for (const z of zeilen) {
      const key = z.lieferantId ?? OHNE
      map.set(key, [...(map.get(key) ?? []), z])
    }
    return [...map.entries()].sort(([a], [b]) => lieferantName(a === OHNE ? null : a).localeCompare(lieferantName(b === OHNE ? null : b), 'de'))
  }, [zeilen, lieferantenMap]) // eslint-disable-line react-hooks/exhaustive-deps

  const lieferantenImVorschlag = useMemo(() =>
    [...new Set((vorschlagQ.data?.zeilen ?? []).map(z => z.lieferantId).filter((id): id is string => !!id))],
  [vorschlagQ.data])

  const bestellungAnlegen = useMutation({
    mutationFn: (p: { lieferantId: string; zeilen: ExportZeile[] }) => einkaufBestellungApi.erstelle({
      lieferantId: p.lieferantId,
      positionen: p.zeilen.filter(z => z.bestellmenge > 0).map(z => ({
        artikelId: z.artikelId, bezeichnung: z.bezeichnung, lieferantenArtikelnummer: z.lieferantenArtikelnummer,
        menge: z.bestellmenge, einkaufspreisCent: z.einkaufspreisCent,
      })),
    }),
    onSuccess: b => {
      setFehler(null)
      void qc.invalidateQueries({ queryKey: ['einkauf-bestellungen'] })
      void qc.invalidateQueries({ queryKey: ['bestellvorschlag'] })
      navigate(`/einkaufsbestellungen?oeffne=${b.id}`)
    },
    onError: e => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  // ── Export / PDF / Druck ───────────────────────────────────────────────────
  const tabelle = () => bestellvorschlagTabelle(zeilen, lieferantName, tage)
  const titel = 'Bestellvorschlag'
  const zeitraum = `Verbrauch der letzten ${tage} Tage, Bedarf für ${reichweite} Tage`
  const firma = getAuth()?.mandant.firmenname ?? ''
  const dateiBasis = `Bestellvorschlag-${heuteKalendertag()}`

  const pdf = async () => {
    try { await downloadBerichtPdf(titel, zeitraum, firma, tabelle(), `${dateiBasis}.pdf`) }
    catch (e) { setFehler(e instanceof Error ? e.message : 'PDF fehlgeschlagen') }
  }
  // Drucken: PDF-Vorschau mit „Drucken" (wie bei den Berichten)
  const drucken = async () => {
    try { setVorschauUrl(await berichtPdfVorschauUrl(titel, zeitraum, firma, tabelle())) }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Druckansicht fehlgeschlagen') }
  }
  const schliesseVorschau = () => {
    if (vorschauUrl) URL.revokeObjectURL(vorschauUrl)
    setVorschauUrl(null)
  }

  const zahlFeld = (wert: number, setzen: (n: number) => void, testid: string, label: string) => (
    <label className="flex items-center gap-2 text-sm text-ink-muted">
      {label}
      <input
        type="number" min={1} max={365} value={wert} data-testid={testid}
        onChange={e => { const n = parseInt(e.target.value, 10); if (n >= 1 && n <= 365) setzen(n) }}
        className="w-20 text-right border border-line-strong rounded-md px-2 py-1 text-sm font-semibold text-ink bg-panel focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      Tage
    </label>
  )

  const knopf = 'px-3 py-2 rounded-lg border border-line-strong text-sm font-medium text-ink hover:bg-panel-2 transition disabled:opacity-50'
  const chip = (aktiv: boolean) => `px-3 py-1.5 rounded-full text-sm font-medium border transition ${aktiv ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel text-ink border-line-strong hover:border-brand-400'}`

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <PdfVorschauModal url={vorschauUrl} titel={titel} dateiname={`${dateiBasis}.pdf`} onClose={schliesseVorschau} />
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Bestellliste</h1>
          <p className="text-sm text-ink-muted mt-0.5">
            Vorschlag aus dem Verbrauch: Bedarf für die Reichweite + Mindestbestand − Lagerstand − bereits bestellt
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={knopf} disabled={zeilen.length === 0} onClick={() => ladeCsvHerunter(alsCsv(tabelle()), `${dateiBasis}.csv`)} data-testid="vorschlag-csv">CSV-Export</button>
          <button type="button" className={knopf} disabled={zeilen.length === 0} onClick={() => { void pdf() }} data-testid="vorschlag-pdf">PDF</button>
          <button type="button" className={knopf} disabled={zeilen.length === 0} onClick={() => { void drucken() }} data-testid="vorschlag-drucken">Drucken</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-5 rounded-xl border border-line bg-panel px-4 py-3">
        {zahlFeld(tage, setTage, 'vorschlag-tage', 'Verbrauch der letzten')}
        {zahlFeld(reichweite, setReichweite, 'vorschlag-reichweite', 'Bestellen für')}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={nurMitVorschlag} onChange={e => setNurMitVorschlag(e.target.checked)} data-testid="vorschlag-nur-mit" />
          Nur Artikel mit Vorschlag
        </label>
      </div>

      {lieferantenImVorschlag.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          <button type="button" onClick={() => setFilterLieferant('alle')} className={chip(filterLieferant === 'alle')}>Alle</button>
          {lieferantenImVorschlag.map(lid => (
            <button key={lid} type="button" onClick={() => setFilterLieferant(lid)} className={chip(filterLieferant === lid)}>
              {lieferantName(lid)}
            </button>
          ))}
          <button type="button" onClick={() => setFilterLieferant(OHNE)} className={chip(filterLieferant === OHNE)}>Ohne Lieferant</button>
        </div>
      )}

      {fehler && <p className="mb-3 text-sm text-red-600" role="alert">{fehler}</p>}

      {vorschlagQ.isLoading ? (
        <div className="p-8 text-sm text-ink-muted">Wird berechnet…</div>
      ) : vorschlagQ.isError ? (
        <p className="text-sm text-red-600" role="alert">{vorschlagQ.error instanceof Error ? vorschlagQ.error.message : 'Fehler'}</p>
      ) : zeilen.length === 0 ? (
        <div className="rounded-xl border border-green-200 bg-green-50 p-12 text-center">
          <p className="text-green-700 font-medium">Nichts zu bestellen.</p>
          <p className="text-green-600 text-sm mt-1">Bestand und bereits Bestelltes reichen für {reichweite} Tage.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {gruppen.map(([key, gz]) => {
            const lieferant = key !== OHNE ? lieferantenMap.get(key) : undefined
            return (
              <div key={key} className="bg-panel rounded-xl border border-line overflow-hidden">
                <div className="px-4 py-3 bg-panel-2 border-b border-line flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="font-semibold text-ink">{lieferant ? lieferant.name : 'Ohne Lieferant'}</p>
                    {lieferant && (
                      <div className="flex gap-4 text-xs text-ink-muted mt-0.5">
                        {lieferant.kontakt && <span>{lieferant.kontakt}</span>}
                        {lieferant.email   && <a href={`mailto:${lieferant.email}`} className="text-brand-600 hover:underline">{lieferant.email}</a>}
                        {lieferant.telefon && <a href={`tel:${lieferant.telefon}`}  className="text-brand-600 hover:underline">{lieferant.telefon}</a>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-ink-muted">{gz.length} Artikel</p>
                    {lieferant && (
                      <button
                        type="button" data-testid="bestellung-anlegen"
                        disabled={bestellungAnlegen.isPending || gz.every(z => z.bestellmenge <= 0)}
                        onClick={() => bestellungAnlegen.mutate({ lieferantId: lieferant.id, zeilen: gz })}
                        className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition"
                      >
                        Bestellung anlegen
                      </button>
                    )}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs font-semibold text-ink-muted uppercase tracking-wide border-b border-line">
                        <th className="px-4 py-2 text-left">Artikel</th>
                        <th className="px-3 py-2 text-right">Bestand</th>
                        <th className="px-3 py-2 text-right">Unterwegs</th>
                        <th className="px-3 py-2 text-right">Verbrauch {tage} T</th>
                        <th className="px-3 py-2 text-right">Ø/Tag</th>
                        <th className="px-3 py-2 text-right">Reicht</th>
                        <th className="px-3 py-2 text-right">Mindest</th>
                        <th className="px-3 py-2 text-right">Vorschlag</th>
                        <th className="px-4 py-2 text-right w-28">Bestellen</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {gz.map(z => (
                        <tr key={z.artikelId} className="hover:bg-panel-2" data-testid="vorschlag-zeile">
                          <td className="px-4 py-2.5 font-medium text-ink">{z.bezeichnung}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-ink-muted">{zahl(z.bestand)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-ink-muted">{z.unterwegs > 0 ? zahl(z.unterwegs) : '–'}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-ink-muted">{zahl(z.verbrauch)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-ink-muted">{zahl(z.verbrauchProTag)}</td>
                          <td className={`px-3 py-2.5 text-right font-mono ${z.reichtTage !== null && z.reichtTage < reichweite ? 'text-red-600 font-semibold' : 'text-ink-muted'}`}>
                            {z.reichtTage === null ? '–' : `${zahl(z.reichtTage)} T`}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-ink-muted">{z.mindestbestand ?? '–'}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-ink">{zahl(z.vorschlag)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <input
                              type="number" min={0} value={z.bestellmenge} data-testid="vorschlag-menge" aria-label={`Bestellmenge ${z.bezeichnung}`}
                              onChange={e => setMengen(m => ({ ...m, [z.artikelId]: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                              className="w-24 text-right border border-line-strong rounded-md px-2 py-1 text-sm font-semibold bg-panel text-ink focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
