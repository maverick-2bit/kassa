/**
 * Kassenbuch — Bar-Einlagen und -Entnahmen.
 * Nicht umsatzbezogen: Wechselgeld, Bankeinlagen, Ausgaben aus der Kasse.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { hasBerechtigung } from '../lib/auth'
import type { KassenbuchBuchung, KassenbuchBuchungInput } from '@kassa/shared'
import { KASSENBUCH_TYP_LABELS } from '@kassa/shared'
import { kassenbuchApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'
import { downloadKassenbuchPdf } from '../lib/pdf'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'

// ---------------------------------------------------------------------------
// Datum-Helfer
// ---------------------------------------------------------------------------

function heute(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

function addTage(datum: string, n: number): string {
  const d = new Date(datum)
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('sv-SE')
}

function startDesMonats(datum: string): string {
  return datum.slice(0, 7) + '-01'
}

function endeDesMonats(datum: string): string {
  const [y, m] = datum.split('-').map(Number)
  return new Date(y!, m!, 0).toLocaleDateString('sv-SE')
}

function formatDatum(datum: string): string {
  const [y, m, d] = datum.split('-')
  return `${d}.${m}.${y}`
}

function formatZeit(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-AT', {
    timeZone: 'Europe/Vienna',
    hour:   '2-digit',
    minute: '2-digit',
  })
}

type ZeitraumPreset = 'heute' | 'gestern' | 'woche' | 'monat'

const ZEITRAUM_OPTIONEN: { key: ZeitraumPreset; label: string }[] = [
  { key: 'heute',   label: 'Heute'         },
  { key: 'gestern', label: 'Gestern'        },
  { key: 'woche',   label: 'Diese Woche'    },
  { key: 'monat',   label: 'Dieser Monat'   },
]

function berechneZeitraum(preset: ZeitraumPreset): { von: string; bis: string } {
  const h = heute()
  switch (preset) {
    case 'heute':   return { von: h, bis: h }
    case 'gestern': { const g = addTage(h, -1); return { von: g, bis: g } }
    case 'woche': {
      const d = new Date(h)
      const tag = d.getDay() || 7
      d.setDate(d.getDate() - (tag - 1))
      const von = d.toLocaleDateString('sv-SE')
      return { von, bis: addTage(von, 6) }
    }
    case 'monat': return { von: startDesMonats(h), bis: endeDesMonats(h) }
  }
}

// ---------------------------------------------------------------------------
// Hauptkomponente
// ---------------------------------------------------------------------------

export function KassenbuchPage() {
  const identity   = getKasseIdentity()!
  const auth       = getAuth()!
  const qc         = useQueryClient()

  const [preset, setPreset]       = useState<ZeitraumPreset>('heute')
  const [von, setVon]             = useState(() => heute())
  const [bis, setBis]             = useState(() => heute())
  const [modalOffen, setModal]    = useState(false)
  const [pdfLaedt, setPdfLaedt]   = useState(false)
  const [pdfFehler, setPdfFehler] = useState<string | null>(null)
  const [bonFehler, setBonFehler] = useState<string | null>(null)

  function waehlePreset(p: ZeitraumPreset) {
    setPreset(p)
    const { von: v, bis: b } = berechneZeitraum(p)
    setVon(v); setBis(b)
  }

  const query = useQuery({
    queryKey: ['kassenbuch', identity.kasseId, von, bis],
    queryFn:  () => kassenbuchApi.liste(identity.kasseId, von, bis),
  })

  const erstelleMutation = useMutation({
    mutationFn: kassenbuchApi.erstelle,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kassenbuch', identity.kasseId] })
      setModal(false)
    },
  })

  const druckenMutation = useMutation({
    mutationFn: () => kassenbuchApi.drucken(identity.kasseId, von, bis),
    onSuccess:  () => setBonFehler(null),
    onError:    (err) => setBonFehler(err instanceof Error ? err.message : 'Druckfehler'),
  })

  async function pdfHerunterladen() {
    if (!query.data) return
    setPdfLaedt(true); setPdfFehler(null)
    try {
      const kasseInfo   = auth.kassen.find(k => k.id === identity.kasseId)
      const bezeichnung = kasseInfo?.bezeichnung ?? kasseInfo?.kassenId ?? identity.kasseId
      await downloadKassenbuchPdf(query.data, auth.mandant.firmenname, bezeichnung)
    } catch (err) {
      setPdfFehler(err instanceof Error ? err.message : 'PDF-Erstellung fehlgeschlagen')
    } finally {
      setPdfLaedt(false)
    }
  }

  const data = query.data

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Kassenbuch</h1>
          <p className="mt-1 text-sm text-ink-muted">Bar-Einlagen und -Entnahmen</p>
        </div>
        <Button onClick={() => setModal(true)}>+ Neue Buchung</Button>
      </div>

      {/* Filter */}
      <div className="rounded-lg bg-panel shadow-sm border border-line p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex gap-1">
            {ZEITRAUM_OPTIONEN.map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => waehlePreset(opt.key)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition ${
                  preset === opt.key
                    ? 'bg-brand-600 text-white'
                    : 'bg-panel-2 text-ink-muted hover:bg-panel-2'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <div className="flex items-center gap-1">
              <span className="text-xs text-ink-muted">Von</span>
              <input
                type="date"
                value={von}
                max={bis}
                onChange={e => { setVon(e.target.value); setPreset('heute') }}
                className="rounded border border-line-strong px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs text-ink-muted">Bis</span>
              <input
                type="date"
                value={bis}
                min={von}
                max={heute()}
                onChange={e => { setBis(e.target.value); setPreset('heute') }}
                className="rounded border border-line-strong px-2 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Übersicht-Kacheln */}
      {data && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-green-200 bg-green-50 shadow-sm p-4">
            <p className="text-xs text-green-600 font-medium">Einlagen</p>
            <p className="font-mono font-bold text-xl mt-1 text-green-800">
              {formatPreis(data.einlagenCent)}
            </p>
            <p className="text-xs text-green-500 mt-0.5">
              {data.buchungen.filter(b => b.typ === 'einlage').length} Buchungen
            </p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 shadow-sm p-4">
            <p className="text-xs text-red-600 font-medium">Entnahmen</p>
            <p className="font-mono font-bold text-xl mt-1 text-red-800">
              {formatPreis(data.entnahmenCent)}
            </p>
            <p className="text-xs text-red-500 mt-0.5">
              {data.buchungen.filter(b => b.typ === 'entnahme').length} Buchungen
            </p>
          </div>
          <div className={`rounded-lg border shadow-sm p-4 ${
            data.saldoCent >= 0
              ? 'border-brand-200 bg-brand-50'
              : 'border-orange-200 bg-orange-50'
          }`}>
            <p className={`text-xs font-medium ${data.saldoCent >= 0 ? 'text-brand-600' : 'text-orange-600'}`}>
              Saldo
            </p>
            <p className={`font-mono font-bold text-xl mt-1 ${data.saldoCent >= 0 ? 'text-brand-800' : 'text-orange-800'}`}>
              {data.saldoCent >= 0 ? '+' : ''}{formatPreis(data.saldoCent)}
            </p>
            <p className={`text-xs mt-0.5 ${data.saldoCent >= 0 ? 'text-brand-500' : 'text-orange-500'}`}>
              {formatDatum(data.von)} – {formatDatum(data.bis)}
            </p>
          </div>
        </div>
      )}

      {/* Buchungsliste */}
      <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
        <div className="px-4 py-3 bg-panel-2 border-b border-line flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            Buchungen
            {data && data.buchungen.length > 0 && (
              <span className="ml-2 text-ink-subtle font-normal">({data.buchungen.length})</span>
            )}
          </h2>
          <div className="flex items-center gap-3">
            {(pdfFehler || bonFehler) && (
              <span className="text-xs text-red-600">{pdfFehler ?? bonFehler}</span>
            )}
            <Button
              variant="secondary"
              onClick={() => void pdfHerunterladen()}
              loading={pdfLaedt}
              disabled={!data || data.buchungen.length === 0}
            >
              <svg className="h-4 w-4 mr-1.5 inline-block" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
              PDF
            </Button>
            {hasBerechtigung('einstellungen') && (
              <Button
                onClick={() => { setBonFehler(null); druckenMutation.mutate() }}
                loading={druckenMutation.isPending}
                disabled={!data}
                title="Kassenbuch auf Thermodrucker ausgeben"
              >
                🖨 Bon drucken
              </Button>
            )}
          </div>
        </div>

        {query.isLoading && (
          <div className="p-8 text-center text-sm text-ink-subtle">Wird geladen…</div>
        )}
        {query.isError && (
          <div className="p-6 text-sm text-red-600">
            {query.error instanceof Error ? query.error.message : 'Fehler beim Laden'}
          </div>
        )}
        {data && data.buchungen.length === 0 && (
          <div className="p-8 text-center text-sm text-ink-muted">
            Keine Buchungen im gewählten Zeitraum.
          </div>
        )}
        {data && data.buchungen.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-panel-2 text-left text-xs uppercase tracking-wide text-ink-muted border-b border-line">
                <tr>
                  <th className="px-4 py-2 font-semibold">Datum</th>
                  <th className="px-4 py-2 font-semibold">Uhrzeit</th>
                  <th className="px-4 py-2 font-semibold">Art</th>
                  <th className="px-4 py-2 font-semibold">Grund</th>
                  <th className="px-4 py-2 font-semibold">Benutzer</th>
                  <th className="px-4 py-2 font-semibold text-right">Betrag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.buchungen.map((b) => (
                  <tr key={b.id} className="hover:bg-panel-2">
                    <td className="px-4 py-2.5 text-ink font-mono text-xs">
                      {formatDatum(b.datum)}
                    </td>
                    <td className="px-4 py-2.5 text-ink-muted font-mono text-xs">
                      {formatZeit(b.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        b.typ === 'einlage'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {KASSENBUCH_TYP_LABELS[b.typ]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-muted">
                      {b.grund ?? <span className="text-ink-subtle">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-ink-muted text-xs">
                      {b.userName ?? '—'}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono font-semibold ${
                      b.typ === 'einlage' ? 'text-green-700' : 'text-red-700'
                    }`}>
                      {b.typ === 'einlage' ? '+' : '−'}{formatPreis(b.betragCent)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong bg-panel-2">
                  <td colSpan={5} className="px-4 py-2 text-sm font-semibold text-ink">Saldo</td>
                  <td className={`px-4 py-2 text-right font-mono font-bold text-sm ${
                    data.saldoCent >= 0 ? 'text-brand-700' : 'text-orange-700'
                  }`}>
                    {data.saldoCent >= 0 ? '+' : ''}{formatPreis(data.saldoCent)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Neue Buchung Modal */}
      <Modal
        open={modalOffen}
        onClose={() => setModal(false)}
        title="Neue Buchung"
      >
        <BuchungFormular
          kasseId={identity.kasseId}
          loading={erstelleMutation.isPending}
          fehler={erstelleMutation.error instanceof Error ? erstelleMutation.error.message : null}
          onSubmit={(input) => erstelleMutation.mutate(input)}
          onAbbrechen={() => setModal(false)}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Buchungs-Formular
// ---------------------------------------------------------------------------

function BuchungFormular({
  kasseId, loading, fehler, onSubmit, onAbbrechen,
}: {
  kasseId:    string
  loading:    boolean
  fehler:     string | null
  onSubmit:   (input: KassenbuchBuchungInput) => void
  onAbbrechen: () => void
}) {
  const [typ, setTyp]           = useState<'einlage' | 'entnahme'>('einlage')
  const [betragStr, setBetrag]  = useState('')
  const [grund, setGrund]       = useState('')
  const [datum, setDatum]       = useState(() => heute())

  const betragCent = Math.round(parseFloat(betragStr.replace(',', '.') || '0') * 100)
  const gueltig    = betragCent >= 1 && datum.length === 10

  const submit = () => {
    if (!gueltig) return
    onSubmit({
      kasseId,
      typ,
      betragCent,
      grund: grund.trim() || null,
      datum,
    })
  }

  return (
    <div className="space-y-4">
      {/* Typ */}
      <div>
        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Art</label>
        <div className="flex gap-2">
          {(['einlage', 'entnahme'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTyp(t)}
              className={`flex-1 py-2.5 rounded-lg border-2 text-sm font-semibold transition ${
                typ === t
                  ? t === 'einlage'
                    ? 'border-green-500 bg-green-50 text-green-700'
                    : 'border-red-400 bg-red-50 text-red-700'
                  : 'border-line text-ink-muted hover:border-line-strong'
              }`}
            >
              {KASSENBUCH_TYP_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Betrag */}
      <label className="block">
        <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Betrag *</span>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-ink-muted">€</span>
          <Input
            autoFocus
            inputMode="decimal"
            value={betragStr}
            onChange={e => setBetrag(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="0,00"
            className="w-36"
          />
        </div>
      </label>

      {/* Datum */}
      <label className="block">
        <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Datum *</span>
        <input
          type="date"
          value={datum}
          max={heute()}
          onChange={e => setDatum(e.target.value)}
          className="mt-1 block rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
        />
      </label>

      {/* Grund */}
      <label className="block">
        <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
          Grund <span className="text-ink-subtle normal-case font-normal">(optional)</span>
        </span>
        <Input
          value={grund}
          onChange={e => setGrund(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="z. B. Wechselgeld, Bankeinzahlung, Büromaterial …"
          className="mt-1"
          maxLength={200}
        />
      </label>

      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button
          onClick={submit}
          loading={loading}
          disabled={!gueltig}
          className={`flex-1 ${typ === 'entnahme' ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500' : ''}`}
        >
          {KASSENBUCH_TYP_LABELS[typ]} buchen
        </Button>
      </div>
    </div>
  )
}
