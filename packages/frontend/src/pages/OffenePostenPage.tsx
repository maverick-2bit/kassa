import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { OffenerPostenResponse, OffenerPostenStatus } from '@kassa/shared'
import { OFFENER_POSTEN_STATUS_LABELS } from '@kassa/shared'
import { offenerPostenApi } from '../lib/api'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'

// ---------------------------------------------------------------------------
// Status-Farben
// ---------------------------------------------------------------------------

const STATUS_FARBE: Record<OffenerPostenStatus, string> = {
  offen:       'bg-red-100 text-red-800 border-red-200',
  teilbezahlt: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  bezahlt:     'bg-green-100 text-green-800 border-green-200',
}

// ---------------------------------------------------------------------------
// Zahlungs-Modal
// ---------------------------------------------------------------------------

interface ZahlungModalProps {
  op:      OffenerPostenResponse
  loading: boolean
  onSubmit: (zahlungCent: number) => void
  onClose:  () => void
}

function ZahlungModal({ op, loading, onSubmit, onClose }: ZahlungModalProps) {
  const [betragEuro, setBetragEuro] = useState(
    (op.restCent / 100).toFixed(2).replace('.', ','),
  )

  const submit = () => {
    const cents = Math.round(parseFloat(betragEuro.replace(',', '.')) * 100)
    if (isNaN(cents) || cents <= 0) return
    onSubmit(cents)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-gray-50 border border-gray-200 p-4 space-y-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Posten-Nr.</span>
          <span className="font-mono">OP-{String(op.nummer).padStart(4, '0')}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Ursprungsbetrag</span>
          <span className="font-mono">{formatPreis(op.betragCent)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Bereits bezahlt</span>
          <span className="font-mono text-green-700">{formatPreis(op.bezahltCent)}</span>
        </div>
        <div className="flex justify-between border-t border-gray-200 pt-1.5 font-semibold">
          <span>Restbetrag</span>
          <span className="font-mono text-red-700">{formatPreis(op.restCent)}</span>
        </div>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Zahlung (€)</span>
        <Input
          autoFocus
          inputMode="decimal"
          value={betragEuro}
          onChange={(e) => setBetragEuro(e.target.value.replace(/[^0-9.,]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-1"
        />
      </label>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => setBetragEuro((op.restCent / 100).toFixed(2).replace('.', ','))}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition"
        >
          Vollständig
        </button>
        <div className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Abbrechen</Button>
        <Button onClick={submit} loading={loading} disabled={!betragEuro.trim()}>
          Zahlung erfassen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function OffenePostenPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<OffenerPostenStatus | 'alle'>('offen')
  const [suche, setSuche]               = useState('')
  const [zahlungModal, setZahlungModal] = useState<OffenerPostenResponse | null>(null)

  const { data: liste = [], isLoading } = useQuery({
    queryKey: ['offene-posten', statusFilter],
    queryFn:  () => offenerPostenApi.list(
      statusFilter === 'alle' ? {} : { status: statusFilter },
    ),
  })

  const { data: stats } = useQuery({
    queryKey: ['offene-posten', 'statistik'],
    queryFn:  () => offenerPostenApi.statistik(),
    refetchInterval: 30_000,
  })

  const zahlungMutation = useMutation({
    mutationFn: ({ id, zahlungCent }: { id: string; zahlungCent: number }) =>
      offenerPostenApi.zahlung(id, { zahlungCent }),
    onSuccess: () => {
      setZahlungModal(null)
      void queryClient.invalidateQueries({ queryKey: ['offene-posten'] })
    },
  })

  const angezeigt = liste.filter(op =>
    !suche ||
    op.kunde?.bezeichnung.toLowerCase().includes(suche.toLowerCase()) ||
    String(op.nummer).includes(suche)
  )

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Offene Posten</h1>

      {/* Statistik */}
      {stats && (
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-2xl font-bold text-red-700">{stats.anzahl}</p>
            <p className="text-xs text-gray-500 mt-0.5">Unbezahlte Posten</p>
          </div>
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-2xl font-bold text-red-700">{formatPreis(stats.gesamtRestCent)}</p>
            <p className="text-xs text-gray-500 mt-0.5">Offener Gesamtbetrag</p>
          </div>
        </div>
      )}

      {/* Filter + Suche */}
      <div className="flex gap-3 mb-4">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(['offen', 'teilbezahlt', 'bezahlt', 'alle'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium border-r border-gray-200 last:border-0 transition ${
                statusFilter === s
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s === 'alle' ? 'Alle' : OFFENER_POSTEN_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Kunde oder Nummer suchen…"
          value={suche}
          onChange={e => setSuche(e.target.value)}
          className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Tabelle */}
      {isLoading ? (
        <p className="text-gray-500 text-sm">Lade…</p>
      ) : angezeigt.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          {liste.length === 0
            ? 'Keine Offenen Posten vorhanden.'
            : 'Kein Eintrag entspricht dem Filter.'}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Nr.</th>
                <th className="px-4 py-3 text-left">Datum</th>
                <th className="px-4 py-3 text-left">Kunde</th>
                <th className="px-4 py-3 text-right">Beleg</th>
                <th className="px-4 py-3 text-right">Betrag</th>
                <th className="px-4 py-3 text-right">Bezahlt</th>
                <th className="px-4 py-3 text-right">Rest</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {angezeigt.map((op, idx) => (
                <tr key={op.id} className={`border-b border-gray-100 last:border-0 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}>
                  <td className="px-4 py-3 font-mono text-gray-500 text-xs">
                    OP-{String(op.nummer).padStart(4, '0')}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {new Date(op.datum).toLocaleDateString('de-AT')}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {op.kunde?.bezeichnung ?? '–'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-500 text-xs">
                    {op.belegNummer ? `#${op.belegNummer}` : '–'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{formatPreis(op.betragCent)}</td>
                  <td className="px-4 py-3 text-right font-mono text-green-700">
                    {op.bezahltCent > 0 ? formatPreis(op.bezahltCent) : '–'}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono font-semibold ${op.restCent > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                    {op.restCent > 0 ? formatPreis(op.restCent) : '–'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${STATUS_FARBE[op.status]}`}>
                      {OFFENER_POSTEN_STATUS_LABELS[op.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {op.status !== 'bezahlt' && (
                      <button
                        type="button"
                        onClick={() => setZahlungModal(op)}
                        className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                      >
                        Zahlung
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Zahlungs-Modal */}
      <Modal
        open={!!zahlungModal}
        onClose={() => setZahlungModal(null)}
        title={`Zahlung erfassen – OP-${String(zahlungModal?.nummer ?? 0).padStart(4, '0')}`}
      >
        {zahlungModal && (
          <ZahlungModal
            op={zahlungModal}
            loading={zahlungMutation.isPending}
            onSubmit={(zahlungCent) => zahlungMutation.mutate({ id: zahlungModal.id, zahlungCent })}
            onClose={() => setZahlungModal(null)}
          />
        )}
      </Modal>
    </div>
  )
}
