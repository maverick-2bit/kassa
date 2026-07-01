import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  GutscheinBuchungResponse,
  GutscheinResponse,
  GutscheinStatus,
} from '@kassa/shared'
import {
  GUTSCHEIN_BUCHUNG_TYP_LABELS,
  GUTSCHEIN_STATUS_LABELS,
} from '@kassa/shared'
import { gutscheinApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'
import { druckeGutschein } from '../lib/rechnung'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { KundePicker } from '../components/KundePicker'
import type { KundeSnapshot } from '@kassa/shared'

// ---------------------------------------------------------------------------
// Status-Farben
// ---------------------------------------------------------------------------

const STATUS_FARBE: Record<GutscheinStatus, string> = {
  aktiv:          'bg-green-100 text-green-800 border-green-200',
  teileingeloest: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  eingeloest:     'bg-panel-2 text-ink-muted border-line',
  storniert:      'bg-red-100 text-red-600 border-red-200',
}

const BUCHUNG_FARBE: Record<GutscheinBuchungResponse['typ'], string> = {
  ausstellung:   'text-green-700',
  einloesung:    'text-red-600',
  restgutschein: 'text-orange-600',
  storno:        'text-red-800',
}

// ---------------------------------------------------------------------------
// Neuer-Gutschein-Modal
// ---------------------------------------------------------------------------

interface NeuerGutscheinModalProps {
  onSubmit: (input: {
    betragCent:  number
    code?:       string
    gueltigBis?: string
    kundeId?:    string
    notiz?:      string
  }) => void
  loading: boolean
  fehler:  string | null
  onClose: () => void
}

function NeuerGutscheinModal({ onSubmit, loading, fehler, onClose }: NeuerGutscheinModalProps) {
  const [betragEuro, setBetragEuro] = useState('')
  const [codeEingabe, setCodeEingabe] = useState('')
  const [gueltigBis, setGueltigBis] = useState('')
  const [notiz,      setNotiz]      = useState('')
  const [kunde,      setKunde]      = useState<KundeSnapshot | null>(null)

  const submit = () => {
    const cents = Math.round(parseFloat(betragEuro.replace(',', '.')) * 100)
    if (isNaN(cents) || cents <= 0) return
    onSubmit({
      betragCent: cents,
      ...(codeEingabe.trim()  && { code:      codeEingabe.trim().toUpperCase() }),
      ...(gueltigBis.trim()   && { gueltigBis: gueltigBis.trim() }),
      ...(kunde               && { kundeId:    kunde.id }),
      ...(notiz.trim()        && { notiz:      notiz.trim() }),
    })
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-ink">Betrag (€) *</span>
        <Input
          autoFocus
          inputMode="decimal"
          placeholder="50,00"
          value={betragEuro}
          onChange={e => setBetragEuro(e.target.value.replace(/[^0-9.,]/g, ''))}
          onKeyDown={e => e.key === 'Enter' && submit()}
          className="mt-1"
        />
      </label>

      <div>
        <span className="text-sm font-medium text-ink block mb-1">Schnellbeträge</span>
        <div className="flex flex-wrap gap-2">
          {[10, 20, 25, 50, 100, 150, 200].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => setBetragEuro(String(n).replace('.', ','))}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                parseFloat(betragEuro.replace(',', '.')) === n
                  ? 'bg-brand-600 border-brand-600 text-white'
                  : 'border-line-strong text-ink hover:border-brand-400'
              }`}
            >
              € {n}
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-ink">Code / EAN / QR (optional)</span>
        <Input
          placeholder="z. B. 1234567890123 oder leer für automatisch"
          value={codeEingabe}
          onChange={e => setCodeEingabe(e.target.value.toUpperCase())}
          className="mt-1 font-mono tracking-wider"
        />
        <p className="mt-1 text-xs text-ink-subtle">
          Leer lassen für automatisch generiertes Format GS-XXXX-XXXX.
          Scanner-freundliche EAN-13 oder beliebige Zeichenkette möglich.
        </p>
      </label>

      <label className="block">
        <span className="text-sm font-medium text-ink">Gültig bis (optional)</span>
        <Input
          type="date"
          value={gueltigBis}
          onChange={e => setGueltigBis(e.target.value)}
          className="mt-1"
        />
      </label>

      <div>
        <span className="text-sm font-medium text-ink block mb-1">Inhaber (optional)</span>
        <KundePicker
          value={kunde}
          onChange={k => setKunde(k)}
        />
      </div>

      <label className="block">
        <span className="text-sm font-medium text-ink">Notiz (optional)</span>
        <textarea
          value={notiz}
          onChange={e => setNotiz(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="z. B. Geburtstag, Stammkunde …"
          className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
        />
      </label>

      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1" disabled={!betragEuro.trim()}>
          Gutschein erstellen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail-Modal mit Transaktionshistorie
// ---------------------------------------------------------------------------

interface GutscheinDetailModalProps {
  gs:      GutscheinResponse
  onClose: () => void
}

function GutscheinDetailModal({ gs, onClose }: GutscheinDetailModalProps) {
  const auth = getAuth()
  const { data: buchungen = [], isLoading } = useQuery({
    queryKey: ['gutschein-buchungen', gs.id],
    queryFn:  () => gutscheinApi.buchungen(gs.id),
  })

  return (
    <div className="space-y-4">
      {/* Kopf */}
      <div className="rounded-lg border border-line bg-panel-2 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-mono font-bold text-xl text-brand-700 tracking-widest">{gs.code}</span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${STATUS_FARBE[gs.status]}`}>
            {GUTSCHEIN_STATUS_LABELS[gs.status]}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <span className="text-ink-muted">Ausstellungsdatum</span>
          <span className="text-right">{new Date(gs.datum).toLocaleDateString('de-AT')}</span>
          <span className="text-ink-muted">Ausgabewert</span>
          <span className="text-right font-mono">{formatPreis(gs.betragCent)}</span>
          <span className="text-ink-muted">Eingelöst</span>
          <span className="text-right font-mono text-red-600">−{formatPreis(gs.bezahltCent)}</span>
          <span className="text-ink-muted font-semibold">Restwert</span>
          <span className={`text-right font-mono font-bold ${gs.restCent > 0 ? 'text-green-700' : 'text-ink-subtle'}`}>
            {gs.restCent > 0 ? formatPreis(gs.restCent) : '–'}
          </span>
          {gs.gueltigBis && (
            <>
              <span className="text-ink-muted">Gültig bis</span>
              <span className="text-right">{gs.gueltigBis}</span>
            </>
          )}
          {gs.kunde && (
            <>
              <span className="text-ink-muted">Inhaber</span>
              <span className="text-right">{gs.kunde.bezeichnung}</span>
            </>
          )}
          {gs.notiz && (
            <>
              <span className="text-ink-muted">Notiz</span>
              <span className="text-right text-xs text-ink-muted">{gs.notiz}</span>
            </>
          )}
        </div>
      </div>

      {/* Transaktionshistorie */}
      <div>
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Transaktionshistorie</p>
        {isLoading ? (
          <p className="text-sm text-ink-subtle py-4 text-center">Lade…</p>
        ) : buchungen.length === 0 ? (
          <p className="text-sm text-ink-subtle py-4 text-center">Keine Buchungen vorhanden.</p>
        ) : (
          <div className="rounded-lg border border-line overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-panel-2 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                  <th className="px-3 py-2 text-left">Datum</th>
                  <th className="px-3 py-2 text-left">Typ</th>
                  <th className="px-3 py-2 text-right">Betrag</th>
                  <th className="px-3 py-2 text-right">Restbetrag</th>
                  <th className="px-3 py-2 text-left">Notiz</th>
                </tr>
              </thead>
              <tbody>
                {[...buchungen].reverse().map((b, idx) => (
                  <tr key={b.id} className={`border-b border-line last:border-0 ${idx % 2 === 0 ? 'bg-panel' : 'bg-panel-2/40'}`}>
                    <td className="px-3 py-2 text-ink-muted whitespace-nowrap">
                      {new Date(b.createdAt).toLocaleDateString('de-AT')}
                    </td>
                    <td className={`px-3 py-2 font-medium ${BUCHUNG_FARBE[b.typ]}`}>
                      {GUTSCHEIN_BUCHUNG_TYP_LABELS[b.typ]}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${b.betragCent > 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {b.betragCent > 0 ? '+' : ''}{formatPreis(Math.abs(b.betragCent))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-ink">
                      {formatPreis(b.restCentNach)}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-muted max-w-[160px] truncate">
                      {b.notiz ?? '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <Button
          variant="secondary"
          onClick={() => {
            if (auth) druckeGutschein(gs, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
          }}
          className="flex-1"
        >
          Drucken
        </Button>
        <Button variant="secondary" onClick={onClose} className="flex-1">Schließen</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function GutscheinPage() {
  const auth        = getAuth()
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<GutscheinStatus | 'alle'>('aktiv')
  const [suche,          setSuche]          = useState('')
  const [neuerOffen,     setNeuerOffen]     = useState(false)
  const [fehler,         setFehler]         = useState<string | null>(null)
  const [detailGs,       setDetailGs]       = useState<GutscheinResponse | null>(null)
  const [storniereGs,    setStorniereGs]    = useState<GutscheinResponse | null>(null)
  const [infoGs,         setInfoGs]         = useState<GutscheinResponse | null>(null)

  const { data: liste = [], isLoading } = useQuery({
    queryKey: ['gutscheine', statusFilter],
    queryFn:  () => gutscheinApi.list(statusFilter === 'alle' ? {} : { status: statusFilter }),
  })

  const erstelleMutation = useMutation({
    mutationFn: gutscheinApi.create,
    onSuccess: (gs) => {
      setNeuerOffen(false)
      setFehler(null)
      void queryClient.invalidateQueries({ queryKey: ['gutscheine'] })
      // Sofort drucken
      if (auth) druckeGutschein(gs, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const storniereMutation = useMutation({
    mutationFn: (id: string) => gutscheinApi.stornieren(id),
    onSuccess: () => {
      setStorniereGs(null)
      void queryClient.invalidateQueries({ queryKey: ['gutscheine'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const angezeigt = liste.filter(gs =>
    !suche ||
    gs.code.toLowerCase().includes(suche.toLowerCase()) ||
    gs.kunde?.bezeichnung.toLowerCase().includes(suche.toLowerCase())
  )

  // Statistik aus allen Status-Gruppen
  const { data: alle = [] } = useQuery({
    queryKey: ['gutscheine', 'alle'],
    queryFn:  () => gutscheinApi.list({}),
  })
  const stats = {
    aktiv:          alle.filter(g => g.status === 'aktiv').length,
    teileingeloest: alle.filter(g => g.status === 'teileingeloest').length,
    gesamtOffen:    alle.filter(g => g.status !== 'eingeloest' && g.status !== 'storniert')
                       .reduce((s, g) => s + g.restCent, 0),
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-start justify-between mb-6">
        <h1 className="text-2xl font-bold text-ink">Gutscheine</h1>
        <Button onClick={() => { setFehler(null); setNeuerOffen(true) }}>
          + Neuer Gutschein
        </Button>
      </div>

      {/* Statistik */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <p className="text-2xl font-bold text-green-700">{stats.aktiv}</p>
          <p className="text-xs text-ink-muted mt-0.5">Aktive Gutscheine</p>
        </div>
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
          <p className="text-2xl font-bold text-yellow-700">{stats.teileingeloest}</p>
          <p className="text-xs text-ink-muted mt-0.5">Teileingelöst</p>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-2xl font-bold text-blue-700">{formatPreis(stats.gesamtOffen)}</p>
          <p className="text-xs text-ink-muted mt-0.5">Offener Gesamtwert</p>
        </div>
      </div>

      {/* Filter + Suche */}
      <div className="flex gap-3 mb-4">
        <div className="flex rounded-lg border border-line overflow-hidden">
          {(['aktiv', 'teileingeloest', 'eingeloest', 'storniert', 'alle'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium border-r border-line last:border-0 transition ${
                statusFilter === s
                  ? 'bg-brand-600 text-white'
                  : 'bg-panel text-ink-muted hover:bg-panel-2'
              }`}
            >
              {s === 'alle' ? 'Alle' : GUTSCHEIN_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Code oder Inhaber suchen…"
          value={suche}
          onChange={e => setSuche(e.target.value)}
          className="flex-1 px-3 py-1.5 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Tabelle */}
      {isLoading ? (
        <p className="text-ink-muted text-sm">Lade…</p>
      ) : angezeigt.length === 0 ? (
        <div className="text-center py-16 text-ink-muted">
          {liste.length === 0 ? 'Keine Gutscheine vorhanden.' : 'Kein Gutschein entspricht dem Filter.'}
        </div>
      ) : (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-panel-2 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Code</th>
                <th className="px-4 py-3 text-left">Datum</th>
                <th className="px-4 py-3 text-left">Inhaber</th>
                <th className="px-4 py-3 text-right">Wert</th>
                <th className="px-4 py-3 text-right">Rest</th>
                <th className="px-4 py-3 text-left">Gültig bis</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {angezeigt.map((gs, idx) => (
                <tr
                  key={gs.id}
                  className={`border-b border-line last:border-0 hover:bg-brand-50/30 cursor-pointer ${idx % 2 === 0 ? 'bg-panel' : 'bg-panel-2/40'}`}
                  onClick={() => setInfoGs(gs)}
                >
                  <td className="px-4 py-3 font-mono font-bold text-brand-700 tracking-wider">
                    {gs.code}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">
                    {new Date(gs.datum).toLocaleDateString('de-AT')}
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {gs.kunde?.bezeichnung ?? <span className="text-ink-subtle">–</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{formatPreis(gs.betragCent)}</td>
                  <td className={`px-4 py-3 text-right font-mono font-semibold ${gs.restCent > 0 ? 'text-green-700' : 'text-ink-subtle'}`}>
                    {gs.restCent > 0 ? formatPreis(gs.restCent) : '–'}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">
                    {gs.gueltigBis ?? <span className="text-ink-subtle">–</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${STATUS_FARBE[gs.status]}`}>
                      {GUTSCHEIN_STATUS_LABELS[gs.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          if (auth) druckeGutschein(gs, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
                        }}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        Drucken
                      </button>
                      {gs.status !== 'eingeloest' && gs.status !== 'storniert' && (
                        <button
                          type="button"
                          onClick={() => { setFehler(null); setStorniereGs(gs) }}
                          className="text-xs text-red-500 hover:underline"
                        >
                          Stornieren
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Neuer Gutschein Modal */}
      <Modal open={neuerOffen} onClose={() => setNeuerOffen(false)} title="Neuer Gutschein">
        <NeuerGutscheinModal
          onSubmit={(input) => erstelleMutation.mutate(input)}
          loading={erstelleMutation.isPending}
          fehler={fehler}
          onClose={() => setNeuerOffen(false)}
        />
      </Modal>

      {/* Detail-Modal mit Transaktionshistorie */}
      {infoGs && (
        <Modal
          open={true}
          onClose={() => setInfoGs(null)}
          title={`Gutschein ${infoGs.code}`}
          size="lg"
        >
          <GutscheinDetailModal gs={infoGs} onClose={() => setInfoGs(null)} />
        </Modal>
      )}

      {/* Stornieren-Bestätigung */}
      {storniereGs && (
        <Modal open={true} onClose={() => setStorniereGs(null)} title="Gutschein stornieren">
          <div className="space-y-4">
            <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm space-y-1">
              <p className="font-semibold text-red-800">Gutschein {storniereGs.code} wirklich stornieren?</p>
              <p className="text-red-700">Restwert: <strong>{formatPreis(storniereGs.restCent)}</strong></p>
              <p className="text-red-600 text-xs">Diese Aktion kann nicht rückgängig gemacht werden.</p>
            </div>
            {fehler && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStorniereGs(null)} className="flex-1">Abbrechen</Button>
              <Button
                onClick={() => storniereMutation.mutate(storniereGs.id)}
                loading={storniereMutation.isPending}
                className="flex-1 bg-red-600 hover:bg-red-700 focus:ring-red-400"
              >
                Stornieren
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Nachfolge-Detail nach Erstellung (wird über detailGs gesteuert) */}
      {detailGs && (
        <Modal
          open={true}
          onClose={() => setDetailGs(null)}
          title={`Gutschein ${detailGs.code} erstellt`}
          size="lg"
        >
          <GutscheinDetailModal gs={detailGs} onClose={() => setDetailGs(null)} />
        </Modal>
      )}
    </div>
  )
}
