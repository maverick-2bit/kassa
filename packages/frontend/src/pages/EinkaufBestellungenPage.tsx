/**
 * EinkaufBestellungenPage — Bestellungen BEIM Lieferanten: anlegen, als PDF holen, per Mail senden, Status führen.
 *
 * Liste mit Statusfilter; ein Klick öffnet die Bestellung. Entwurf = bearbeitbar (Lieferant fix, Positionen,
 * Termin, Bemerkung); danach nur noch Statuswechsel. Aus der Bestellliste führt `?oeffne=<id>` direkt hierher.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  EINKAUF_BESTELLSTATUS, EINKAUF_BESTELLSTATUS_LABELS, summeBestellung,
  type Artikel, type EinkaufBestellstatus, type EinkaufBestellung, type EinkaufBestellungInput, type Lieferant,
} from '@kassa/shared'
import { artikelApi, einkaufBestellungApi, lieferantApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis, parseEuroToCent } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Select } from '../components/ui/Select'
import { Field } from '../components/ui/Field'
import { Modal } from '../components/ui/Modal'

const STATUS_FARBE: Record<EinkaufBestellstatus, string> = {
  entwurf:       'bg-gray-100 text-gray-700 border-gray-200',
  gesendet:      'bg-blue-100 text-blue-700 border-blue-200',
  teilgeliefert: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  erledigt:      'bg-green-100 text-green-700 border-green-200',
  storniert:     'bg-red-100 text-red-700 border-red-200',
}

function StatusChip({ status }: { status: EinkaufBestellstatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_FARBE[status]}`}>
      {EINKAUF_BESTELLSTATUS_LABELS[status]}
    </span>
  )
}

const datumKurz = (iso: string) => new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })
const terminKurz = (t: string) => t.split('-').reverse().join('.')

// ---------------------------------------------------------------------------
// Editor (neu + Entwurf bearbeiten)
// ---------------------------------------------------------------------------

interface Zeile {
  key:                      string
  artikelId:                string | null
  bezeichnung:              string
  lieferantenArtikelnummer: string
  menge:                    string
  ek:                       string   // Euro-Eingabe, leer = unbekannt
}

let zeilenZaehler = 0
const neuerKey = () => `z${++zeilenZaehler}`

const centZuEuro = (c: number | null | undefined) => c == null ? '' : (c / 100).toFixed(2).replace('.', ',')

export interface Vorbelegung {
  lieferantId: string
  positionen:  { artikelId: string | null; bezeichnung: string; lieferantenArtikelnummer: string | null; menge: number; einkaufspreisCent: number | null }[]
}

function BestellEditor({
  initial, vorbelegung, lieferanten, artikel, onFertig, onAbbrechen,
}: {
  initial?:     EinkaufBestellung | null
  vorbelegung?: Vorbelegung | null
  lieferanten:  Lieferant[]
  artikel:      Artikel[]
  onFertig:     (b: EinkaufBestellung) => void
  onAbbrechen:  () => void
}) {
  const qc = useQueryClient()
  const [lieferantId, setLieferantId] = useState(initial?.lieferantId ?? vorbelegung?.lieferantId ?? '')
  const [bemerkung, setBemerkung] = useState(initial?.bemerkung ?? '')
  const [liefertermin, setLiefertermin] = useState(initial?.liefertermin ?? '')
  const [fehler, setFehler] = useState<string | null>(null)
  const [zeilen, setZeilen] = useState<Zeile[]>(() => {
    const quelle = initial?.positionen ?? vorbelegung?.positionen ?? []
    return quelle.map(p => ({
      key: neuerKey(), artikelId: p.artikelId, bezeichnung: p.bezeichnung,
      lieferantenArtikelnummer: p.lieferantenArtikelnummer ?? '', menge: String(p.menge), ek: centZuEuro(p.einkaufspreisCent),
    }))
  })
  const [freitext, setFreitext] = useState('')

  // Artikel des Lieferanten zuerst anbieten
  const artikelSortiert = useMemo(() => {
    return artikel.filter(a => a.aktiv).sort((a, b) =>
      Number(b.lieferantId === lieferantId) - Number(a.lieferantId === lieferantId) || a.bezeichnung.localeCompare(b.bezeichnung, 'de'))
  }, [artikel, lieferantId])

  function artikelHinzu(id: string) {
    const a = artikel.find(x => x.id === id)
    if (!a) return
    setZeilen(z => [...z, {
      key: neuerKey(), artikelId: a.id, bezeichnung: a.bezeichnung,
      lieferantenArtikelnummer: a.lieferantenArtikelnummer ?? '', menge: '1', ek: centZuEuro(a.einkaufspreisCent),
    }])
  }

  function aendere(key: string, teil: Partial<Zeile>) {
    setZeilen(z => z.map(r => r.key === key ? { ...r, ...teil } : r))
  }

  const aufbereitet = useMemo(() => zeilen.map(z => {
    const menge = Number(z.menge)
    const ek = z.ek.trim() === '' ? null : parseEuroToCent(z.ek)
    return { z, menge, ek, mengeOk: Number.isInteger(menge) && menge > 0, ekOk: z.ek.trim() === '' || (ek !== null && ek >= 0) }
  }), [zeilen])
  const alleOk = aufbereitet.length > 0 && aufbereitet.every(r => r.mengeOk && r.ekOk && r.z.bezeichnung.trim() !== '')
  const summe = summeBestellung(aufbereitet.map(r => ({ menge: r.mengeOk ? r.menge : 0, einkaufspreisCent: r.ek })))

  const speichern = useMutation({
    mutationFn: async () => {
      const positionen = aufbereitet.map(r => ({
        artikelId: r.z.artikelId, bezeichnung: r.z.bezeichnung.trim(),
        lieferantenArtikelnummer: r.z.lieferantenArtikelnummer.trim() || null, menge: r.menge, einkaufspreisCent: r.ek,
      }))
      const gemeinsam = { bemerkung: bemerkung.trim() || null, liefertermin: liefertermin || null, positionen }
      if (initial) return einkaufBestellungApi.aktualisiere(initial.id, gemeinsam)
      const input: EinkaufBestellungInput = { lieferantId, ...gemeinsam }
      return einkaufBestellungApi.erstelle(input)
    },
    onSuccess: b => { void qc.invalidateQueries({ queryKey: ['einkauf-bestellungen'] }); onFertig(b) },
    onError:   e => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  return (
    <div className="space-y-4" data-testid="bestell-editor">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Lieferant *">
          <Select data-testid="bestell-lieferant" value={lieferantId} disabled={!!initial}
            onChange={e => setLieferantId(e.target.value)}>
            <option value="">— bitte wählen —</option>
            {lieferanten.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Gewünschter Liefertermin">
          <Input type="date" data-testid="bestell-termin" value={liefertermin} onChange={e => setLiefertermin(e.target.value)} />
        </Field>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel-2 text-xs text-ink-muted">
            <tr>
              <th className="px-2 py-2 text-left">Artikel</th>
              <th className="px-2 py-2 text-left">Art.-Nr. Lieferant</th>
              <th className="px-2 py-2 text-right">Menge</th>
              <th className="px-2 py-2 text-right">EK netto (€)</th>
              <th className="px-2 py-2 text-right">Summe</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {aufbereitet.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-muted">Noch keine Position — unten einen Artikel hinzufügen.</td></tr>
            )}
            {aufbereitet.map(({ z, menge, ek, mengeOk, ekOk }) => (
              <tr key={z.key} className="border-t border-line" data-testid="bestell-zeile">
                <td className="px-2 py-1.5 min-w-[12rem]">{z.bezeichnung}</td>
                <td className="px-2 py-1.5">
                  <Input aria-label="Artikelnummer beim Lieferanten" value={z.lieferantenArtikelnummer} maxLength={60}
                    onChange={e => aendere(z.key, { lieferantenArtikelnummer: e.target.value })} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Input aria-label="Menge" data-testid="bestell-menge" inputMode="numeric" value={z.menge}
                    className={`w-20 text-right ${mengeOk ? '' : 'border-red-400'}`}
                    onChange={e => aendere(z.key, { menge: e.target.value })} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Input aria-label="Einkaufspreis netto" data-testid="bestell-ek" inputMode="decimal" value={z.ek} placeholder="–"
                    className={`w-24 text-right ${ekOk ? '' : 'border-red-400'}`}
                    onChange={e => aendere(z.key, { ek: e.target.value })} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                  {mengeOk && ek !== null ? formatPreis(menge * ek) : '–'}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button type="button" aria-label="Position entfernen" className="text-red-500 hover:text-red-700 text-xs font-medium"
                    onClick={() => setZeilen(l => l.filter(r => r.key !== z.key))}>Entfernen</button>
                </td>
              </tr>
            ))}
          </tbody>
          {aufbereitet.length > 0 && (
            <tfoot>
              <tr className="border-t border-line bg-panel-2 font-semibold">
                <td colSpan={4} className="px-2 py-2 text-right">
                  {summe.summeUnvollstaendig ? 'Summe netto (ohne Positionen ohne Preis)' : 'Summe netto'}
                </td>
                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap" data-testid="bestell-summe">{formatPreis(summe.summeNettoCent)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Artikel hinzufügen" hint={lieferantId ? 'Artikel dieses Lieferanten stehen oben' : 'Zuerst den Lieferanten wählen'}>
          <Select data-testid="bestell-artikel-hinzu" value="" onChange={e => { artikelHinzu(e.target.value); e.target.value = '' }}>
            <option value="">— Artikel wählen —</option>
            {artikelSortiert.map(a => (
              <option key={a.id} value={a.id}>{a.bezeichnung}{a.lieferantId === lieferantId && lieferantId ? ' ★' : ''}</option>
            ))}
          </Select>
        </Field>
        <Field label="Freie Position" hint="Etwas, das nicht als Artikel angelegt ist">
          <div className="flex gap-2">
            <Input value={freitext} placeholder="Bezeichnung" maxLength={200} onChange={e => setFreitext(e.target.value)} />
            <Button type="button" variant="secondary" disabled={!freitext.trim()}
              onClick={() => { setZeilen(z => [...z, { key: neuerKey(), artikelId: null, bezeichnung: freitext.trim(), lieferantenArtikelnummer: '', menge: '1', ek: '' }]); setFreitext('') }}>
              Hinzufügen
            </Button>
          </div>
        </Field>
      </div>

      <Field label="Bemerkung" hint="Erscheint auf der Bestellung">
        <textarea value={bemerkung} onChange={e => setBemerkung(e.target.value)} rows={2} maxLength={2000}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none" />
      </Field>

      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
      <div className="flex justify-end gap-2 pt-2 border-t border-line">
        <Button variant="secondary" type="button" onClick={onAbbrechen}>Abbrechen</Button>
        <Button type="button" data-testid="bestell-speichern" loading={speichern.isPending}
          disabled={!alleOk || (!initial && !lieferantId)} onClick={() => { setFehler(null); speichern.mutate() }}>
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail (nicht bearbeitbar) + Aktionen
// ---------------------------------------------------------------------------

function BestellDetail({
  bestellung, lieferant, onGeaendert, onGeloescht, onBearbeiten,
}: {
  bestellung:   EinkaufBestellung
  lieferant?:   Lieferant | undefined
  onGeaendert:  (b: EinkaufBestellung) => void
  onGeloescht:  () => void
  onBearbeiten: () => void
}) {
  const qc = useQueryClient()
  const [fehler, setFehler] = useState<string | null>(null)
  const [hinweis, setHinweis] = useState<string | null>(null)
  const [empfaenger, setEmpfaenger] = useState(lieferant?.email ?? '')
  const [bestaetige, setBestaetige] = useState<'storniert' | 'loeschen' | null>(null)
  const entwurf = bestellung.status === 'entwurf'
  const kannMailen = entwurf || bestellung.status === 'gesendet'

  const nachAenderung = (b: EinkaufBestellung) => { void qc.invalidateQueries({ queryKey: ['einkauf-bestellungen'] }); onGeaendert(b) }
  const onError = (e: unknown) => { setHinweis(null); setFehler(e instanceof Error ? e.message : 'Fehler') }

  const status = useMutation({
    mutationFn: ({ s, an }: { s: EinkaufBestellstatus; an?: string }) => einkaufBestellungApi.status(bestellung.id, s, an),
    onSuccess: b => { setFehler(null); setBestaetige(null); nachAenderung(b) }, onError,
  })
  const mail = useMutation({
    mutationFn: () => einkaufBestellungApi.email(bestellung.id, empfaenger.trim() || undefined),
    onSuccess: b => { setFehler(null); setHinweis(`Bestellung an ${b.gesendetAn ?? 'den Lieferanten'} gesendet.`); nachAenderung(b) }, onError,
  })
  const loesche = useMutation({
    mutationFn: () => einkaufBestellungApi.loesche(bestellung.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['einkauf-bestellungen'] }); onGeloescht() }, onError,
  })

  return (
    <div className="space-y-4" data-testid="bestell-detail">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip status={bestellung.status} />
        <span className="text-sm text-ink-muted">{bestellung.lieferantName} · {datumKurz(bestellung.createdAt)}
          {bestellung.liefertermin ? ` · Wunschtermin ${terminKurz(bestellung.liefertermin)}` : ''}</span>
      </div>
      {bestellung.gesendetAm && (
        <p className="text-xs text-ink-muted">Gesendet am {datumKurz(bestellung.gesendetAm)}{bestellung.gesendetAn ? ` an ${bestellung.gesendetAn}` : ''}</p>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel-2 text-xs text-ink-muted">
            <tr>
              <th className="px-2 py-2 text-left">Pos.</th><th className="px-2 py-2 text-left">Artikel</th>
              <th className="px-2 py-2 text-left">Art.-Nr.</th><th className="px-2 py-2 text-right">Menge</th>
              <th className="px-2 py-2 text-right">EK netto</th><th className="px-2 py-2 text-right">Summe</th>
            </tr>
          </thead>
          <tbody>
            {bestellung.positionen.map(p => (
              <tr key={p.id} className="border-t border-line">
                <td className="px-2 py-1.5">{p.position}</td>
                <td className="px-2 py-1.5">{p.bezeichnung}</td>
                <td className="px-2 py-1.5">{p.lieferantenArtikelnummer ?? ''}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{p.menge}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{p.einkaufspreisCent != null ? formatPreis(p.einkaufspreisCent) : '–'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{p.einkaufspreisCent != null ? formatPreis(p.menge * p.einkaufspreisCent) : '–'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-panel-2 font-semibold">
              <td colSpan={5} className="px-2 py-2 text-right">{bestellung.summeUnvollstaendig ? 'Summe netto (ohne Positionen ohne Preis)' : 'Summe netto'}</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatPreis(bestellung.summeNettoCent)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {bestellung.bemerkung && <p className="text-sm whitespace-pre-line text-ink"><span className="text-ink-muted">Bemerkung: </span>{bestellung.bemerkung}</p>}

      {kannMailen && (
        <div className="rounded-lg border border-line p-3 space-y-2">
          <Field label="E-Mail an" hint={lieferant?.email ? 'Vorbelegt aus dem Lieferanten-Stamm' : 'Beim Lieferanten ist keine Adresse hinterlegt'}>
            <Input type="email" data-testid="bestell-empfaenger" value={empfaenger} placeholder="bestellung@lieferant.at"
              onChange={e => setEmpfaenger(e.target.value)} />
          </Field>
          <Button type="button" data-testid="bestell-mail" loading={mail.isPending} disabled={!empfaenger.trim()}
            onClick={() => { setFehler(null); setHinweis(null); mail.mutate() }}>
            {bestellung.status === 'gesendet' ? 'Erneut per E-Mail senden' : 'Per E-Mail senden'}
          </Button>
        </div>
      )}

      {hinweis && <p className="text-sm text-green-700" role="status" data-testid="bestell-hinweis">{hinweis}</p>}
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}

      <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-line">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" data-testid="bestell-pdf"
            onClick={() => einkaufBestellungApi.pdf(bestellung.id, `Bestellung-${bestellung.nummer}.pdf`).catch(onError)}>PDF</Button>
          {entwurf && <Button type="button" variant="secondary" data-testid="bestell-bearbeiten" onClick={onBearbeiten}>Bearbeiten</Button>}
          {entwurf && (
            <Button type="button" variant="secondary" data-testid="bestell-als-gesendet" loading={status.isPending}
              onClick={() => status.mutate({ s: 'gesendet', an: 'ohne E-Mail (telefonisch/Portal)' })}>Als gesendet markieren</Button>
          )}
          {(bestellung.status === 'gesendet' || bestellung.status === 'teilgeliefert') && (
            <Button type="button" data-testid="bestell-erledigt" loading={status.isPending}
              onClick={() => status.mutate({ s: 'erledigt' })}>Erledigt</Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {entwurf && <Button type="button" variant="danger" data-testid="bestell-loeschen" onClick={() => setBestaetige('loeschen')}>Löschen</Button>}
          {(entwurf || bestellung.status === 'gesendet') && (
            <Button type="button" variant="danger" data-testid="bestell-stornieren" onClick={() => setBestaetige('storniert')}>Stornieren</Button>
          )}
        </div>
      </div>

      {bestaetige && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2" role="alertdialog" data-testid="bestell-bestaetigung">
          <p className="text-sm text-red-800">
            {bestaetige === 'loeschen'
              ? `Entwurf ${bestellung.nummer} wirklich löschen? Das lässt sich nicht rückgängig machen.`
              : `Bestellung ${bestellung.nummer} wirklich stornieren?`}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setBestaetige(null)}>Zurück</Button>
            <Button type="button" variant="danger" data-testid="bestell-bestaetigen" loading={status.isPending || loesche.isPending}
              onClick={() => bestaetige === 'loeschen' ? loesche.mutate() : status.mutate({ s: 'storniert' })}>
              {bestaetige === 'loeschen' ? 'Ja, löschen' : 'Ja, stornieren'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function EinkaufBestellungenPage() {
  const auth = getAuth()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<EinkaufBestellstatus | ''>('')
  const [offenId, setOffenId] = useState<string | null>(params.get('oeffne'))
  const [bearbeiten, setBearbeiten] = useState(false)
  const [neu, setNeu] = useState(false)

  // ?oeffne=<id> nur einmal auswerten, dann aus der Adresse nehmen
  useEffect(() => {
    if (params.get('oeffne')) { setOffenId(params.get('oeffne')); setParams({}, { replace: true }) }
  }, [params, setParams])

  const { data: liste = [], isLoading } = useQuery({
    queryKey: ['einkauf-bestellungen', 'liste', filter],
    queryFn:  () => einkaufBestellungApi.liste(filter ? { status: filter } : {}),
  })
  const { data: lieferanten = [] } = useQuery({ queryKey: ['lieferanten'], queryFn: lieferantApi.list })
  const { data: alleArtikel = [] } = useQuery({
    queryKey: ['artikel', auth?.mandant.id, true],
    queryFn:  () => artikelApi.list(auth!.mandant.id, true),
    enabled:  !!auth,
  })
  const { data: offen } = useQuery({
    queryKey: ['einkauf-bestellungen', 'detail', offenId],
    queryFn:  () => einkaufBestellungApi.hole(offenId!),
    enabled:  !!offenId,
  })

  const schliesse = () => { setOffenId(null); setBearbeiten(false) }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Bestellungen beim Lieferanten</h1>
          <p className="text-sm text-ink-muted mt-0.5">Waren bestellen, als PDF drucken oder per E-Mail senden und den Stand verfolgen.</p>
        </div>
        <Button data-testid="bestell-neu" onClick={() => setNeu(true)}>+ Neue Bestellung</Button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Status filtern">
        {(['', ...EINKAUF_BESTELLSTATUS] as const).map(s => (
          <button key={s || 'alle'} type="button" onClick={() => setFilter(s)} data-testid={`bestell-filter-${s || 'alle'}`}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${filter === s ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel text-ink border-line-strong hover:border-brand-400'}`}>
            {s ? EINKAUF_BESTELLSTATUS_LABELS[s] : 'Alle'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-ink-muted">Lädt…</p>
      ) : liste.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong py-14 text-center">
          <p className="text-ink-muted">{filter ? 'Keine Bestellungen mit diesem Status.' : 'Noch keine Bestellungen.'}</p>
          {!filter && <p className="text-sm text-ink-subtle mt-1">Klicke auf «+ Neue Bestellung» oder lege sie aus der Bestellliste an.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {liste.map(b => (
            <button key={b.id} type="button" data-testid="bestell-zeile-liste" onClick={() => { setOffenId(b.id); setBearbeiten(false) }}
              className="w-full text-left rounded-xl border border-line bg-panel p-3 hover:border-brand-400 transition grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
              <span className="font-semibold text-ink truncate">{b.nummer} · {b.lieferantName}</span>
              <StatusChip status={b.status} />
              <span className="text-xs text-ink-muted">{datumKurz(b.createdAt)} · {b.anzahlPositionen} Position{b.anzahlPositionen === 1 ? '' : 'en'}
                {b.liefertermin ? ` · Wunschtermin ${terminKurz(b.liefertermin)}` : ''}</span>
              <span className="text-sm tabular-nums text-ink text-right">{formatPreis(b.summeNettoCent)}{b.summeUnvollstaendig ? '*' : ''} netto</span>
            </button>
          ))}
        </div>
      )}

      <Modal open={neu} onClose={() => setNeu(false)} title="Neue Bestellung" size="xl" closeOnBackdrop={false}>
        <BestellEditor lieferanten={lieferanten} artikel={alleArtikel}
          onFertig={b => { setNeu(false); setOffenId(b.id); setBearbeiten(false) }} onAbbrechen={() => setNeu(false)} />
      </Modal>

      <Modal open={!!offenId} onClose={schliesse} title={offen ? `Bestellung ${offen.nummer}` : 'Bestellung'} size="xl" closeOnBackdrop={false}>
        {offen && !bearbeiten && (
          <BestellDetail bestellung={offen} lieferant={lieferanten.find(l => l.id === offen.lieferantId)}
            onGeaendert={() => { /* Detail lädt über den invalidierten Query neu */ }}
            onGeloescht={schliesse} onBearbeiten={() => setBearbeiten(true)} />
        )}
        {offen && bearbeiten && (
          <BestellEditor key={offen.updatedAt} initial={offen} lieferanten={lieferanten} artikel={alleArtikel}
            onFertig={() => setBearbeiten(false)} onAbbrechen={() => setBearbeiten(false)} />
        )}
      </Modal>
    </div>
  )
}
