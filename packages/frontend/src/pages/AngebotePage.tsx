import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AngebotResponse, AngebotStatus, AngebotUpdate, LiferscheinResponse, LiferscheinStatus } from '@kassa/shared'
import { ANGEBOT_STATUS_LABELS, LIEFERSCHEIN_STATUS_LABELS } from '@kassa/shared'
import { angebotApi, lieferscheinApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { druckeAngebot, druckeLiferschein, druckeSammelrechnung } from '../lib/rechnung'
import { sammelrechnungApi } from '../lib/api'

// ---------------------------------------------------------------------------
// Status-Badge
// ---------------------------------------------------------------------------

const STATUS_FARBE: Record<AngebotStatus, string> = {
  offen:      'bg-blue-100 text-blue-800 border-blue-200',
  angenommen: 'bg-green-100 text-green-800 border-green-200',
  abgelehnt:  'bg-red-100 text-red-800 border-red-200',
  abgelaufen: 'bg-gray-100 text-gray-600 border-gray-200',
}

function StatusBadge({ status }: { status: AngebotStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_FARBE[status]}`}>
      {ANGEBOT_STATUS_LABELS[status]}
    </span>
  )
}

// ---------------------------------------------------------------------------
// AngebotDetail-Modal
// ---------------------------------------------------------------------------

interface AngebotDetailProps {
  angebot:  AngebotResponse
  onClose:  () => void
  onUpdate: (id: string, input: AngebotUpdate) => void
  updating: boolean
}

const LS_STATUS_FARBE: Record<LiferscheinStatus, string> = {
  offen:         'bg-blue-100 text-blue-800 border-blue-200',
  abgeschlossen: 'bg-gray-100 text-gray-600 border-gray-200',
}

function AngebotDetailModal({ angebot, onClose, onUpdate, updating }: AngebotDetailProps) {
  const qc = useQueryClient()
  const [neuerStatus, setNeuerStatus] = useState<AngebotStatus>(angebot.status)

  const auth = getAuth()

  const { data: lieferscheine = [] } = useQuery({
    queryKey: ['lieferscheine', 'angebot', angebot.id],
    queryFn:  () => lieferscheinApi.list({ angebotId: angebot.id }),
  })

  const handleDrucken = () => {
    if (!auth) return
    druckeAngebot(angebot, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
  }

  const lieferscheinMutation = useMutation({
    mutationFn: () => lieferscheinApi.create({ angebotId: angebot.id }),
    onSuccess: (ls) => {
      qc.invalidateQueries({ queryKey: ['lieferscheine', 'angebot', angebot.id] })
      if (!auth) return
      druckeLiferschein(ls, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
    },
  })

  const sammelrechnungMutation = useMutation({
    mutationFn: (ids: string[]) => sammelrechnungApi.create({ lieferscheinIds: ids }),
    onSuccess: (sr) => {
      qc.invalidateQueries({ queryKey: ['lieferscheine', 'angebot', angebot.id] })
      if (!auth) return
      druckeSammelrechnung(sr, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
    },
  })

  const offeneLs = lieferscheine.filter(ls => ls.status === 'offen')

  const AENDERBARE_STATI: AngebotStatus[] = ['offen', 'angenommen', 'abgelehnt', 'abgelaufen']

  return (
    <div className="space-y-5">
      {/* Kopfdaten */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-gray-500 block text-xs uppercase tracking-wide mb-0.5">Angebotsnummer</span>
          <span className="font-mono font-semibold">A-{String(angebot.nummer).padStart(4, '0')}</span>
        </div>
        <div>
          <span className="text-gray-500 block text-xs uppercase tracking-wide mb-0.5">Datum</span>
          <span>{new Date(angebot.datum).toLocaleDateString('de-AT')}</span>
        </div>
        {angebot.gueltigBis && (
          <div>
            <span className="text-gray-500 block text-xs uppercase tracking-wide mb-0.5">Gültig bis</span>
            <span className={new Date(angebot.gueltigBis) < new Date() ? 'text-red-600 font-medium' : ''}>
              {angebot.gueltigBis}
            </span>
          </div>
        )}
        <div>
          <span className="text-gray-500 block text-xs uppercase tracking-wide mb-0.5">Status</span>
          <StatusBadge status={angebot.status} />
        </div>
        {angebot.kunde && (
          <div className="col-span-2">
            <span className="text-gray-500 block text-xs uppercase tracking-wide mb-0.5">Kunde</span>
            <span className="font-medium">{angebot.kunde.bezeichnung}</span>
            {angebot.kunde.email && <span className="text-gray-500 ml-2 text-xs">{angebot.kunde.email}</span>}
          </div>
        )}
      </div>

      {/* Positionen */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Positionen</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th className="text-left pb-1.5 font-medium">Bezeichnung</th>
              <th className="text-center pb-1.5 font-medium w-16">Menge</th>
              <th className="text-right pb-1.5 font-medium w-24">Einzelpreis</th>
              <th className="text-right pb-1.5 font-medium w-24">Gesamt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {angebot.positionen.map((p, i) => (
              <tr key={i}>
                <td className="py-1.5 text-gray-800">{p.bezeichnung}</td>
                <td className="py-1.5 text-center text-gray-600">{p.menge}</td>
                <td className="py-1.5 text-right font-mono text-gray-700">{formatPreis(p.einzelpreisBreutto)}</td>
                <td className="py-1.5 text-right font-mono font-medium">{formatPreis(p.einzelpreisBreutto * p.menge)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300">
              <td colSpan={3} className="pt-2 text-sm font-bold text-right pr-2">Angebotssumme</td>
              <td className="pt-2 text-right font-mono font-bold text-base">{formatPreis(angebot.gesamtbetragCent)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {angebot.notiz && (
        <div className="bg-gray-50 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Notiz</p>
          <p className="whitespace-pre-wrap">{angebot.notiz}</p>
        </div>
      )}

      {/* Status ändern */}
      <div className="space-y-2 pt-1 border-t border-gray-200">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Status ändern</p>
        <div className="flex flex-wrap gap-2">
          {AENDERBARE_STATI.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setNeuerStatus(s)}
              className={`px-3 py-1.5 rounded-md border text-sm font-medium transition ${
                neuerStatus === s
                  ? 'bg-brand-600 border-brand-600 text-white'
                  : 'border-gray-300 text-gray-700 hover:border-brand-400'
              }`}
            >
              {ANGEBOT_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        {neuerStatus !== angebot.status && (
          <Button
            onClick={() => onUpdate(angebot.id, { status: neuerStatus })}
            loading={updating}
            className="mt-1"
          >
            Status auf „{ANGEBOT_STATUS_LABELS[neuerStatus]}" setzen
          </Button>
        )}
      </div>

      {/* Lieferscheine zu diesem Angebot */}
      <div className="space-y-2 pt-1 border-t border-gray-200">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Lieferscheine
          </p>
          <Button
            variant="secondary"
            onClick={() => lieferscheinMutation.mutate()}
            loading={lieferscheinMutation.isPending}
            className="text-xs px-2 py-1 h-auto"
          >
            + Neuer Lieferschein
          </Button>
        </div>

        {lieferscheine.length === 0 ? (
          <p className="text-xs text-gray-400 py-2">Noch keine Lieferscheine erstellt.</p>
        ) : (
          <div className="border border-gray-200 rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500">Nr.</th>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500">Datum</th>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500">Status</th>
                  <th className="px-3 py-1.5 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lieferscheine.map((ls: LiferscheinResponse) => (
                  <tr key={ls.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono font-medium text-gray-800">
                      L-{String(ls.nummer).padStart(4, '0')}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {new Date(ls.datum).toLocaleDateString('de-AT')}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${LS_STATUS_FARBE[ls.status as LiferscheinStatus]}`}>
                        {LIEFERSCHEIN_STATUS_LABELS[ls.status as LiferscheinStatus]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => auth && druckeLiferschein(ls, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        Drucken
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {offeneLs.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => sammelrechnungMutation.mutate(offeneLs.map(ls => ls.id))}
            loading={sammelrechnungMutation.isPending}
            className="w-full text-sm"
          >
            Sammelrechnung aus {offeneLs.length} offenen Lieferschein{offeneLs.length !== 1 ? 'en' : ''}
          </Button>
        )}
      </div>

      {/* Aktionen */}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={handleDrucken} className="flex-1">
          Angebot PDF
        </Button>
        <Button variant="secondary" onClick={onClose} className="flex-1">
          Schließen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

const STATUS_FILTER: Array<{ label: string; value: AngebotStatus | 'alle' }> = [
  { label: 'Alle',        value: 'alle' },
  { label: 'Offen',       value: 'offen' },
  { label: 'Angenommen',  value: 'angenommen' },
  { label: 'Abgelehnt',   value: 'abgelehnt' },
  { label: 'Abgelaufen',  value: 'abgelaufen' },
]

export function AngebotePage() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<AngebotStatus | 'alle'>('alle')
  const [gewaehlt, setGewaehlt] = useState<AngebotResponse | null>(null)

  const angeboteQuery = useQuery({
    queryKey: ['angebote', statusFilter],
    queryFn:  () => angebotApi.list(statusFilter !== 'alle' ? { status: statusFilter } : {}),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: AngebotUpdate }) =>
      angebotApi.update(id, input),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['angebote'] })
      setGewaehlt(updated)
    },
  })

  const angebote = angeboteQuery.data ?? []

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-900">Angebote</h1>
        <span className="text-sm text-gray-500">{angebote.length} Angebot{angebote.length !== 1 ? 'e' : ''}</span>
      </div>

      {/* Status-Filter */}
      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTER.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
              statusFilter === f.value
                ? 'bg-brand-600 border-brand-600 text-white'
                : 'bg-white border-gray-300 text-gray-600 hover:border-brand-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Liste */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        {angeboteQuery.isLoading ? (
          <p className="text-sm text-gray-400 text-center py-12">Wird geladen…</p>
        ) : angebote.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-4xl mb-3">📋</p>
            <p className="text-sm font-medium">Keine Angebote vorhanden</p>
            <p className="text-xs mt-1">Erstelle ein Angebot über die Kasse im Angebot-Modus.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-xs uppercase tracking-wide text-gray-500">Nr.</th>
                <th className="text-left px-4 py-3 font-semibold text-xs uppercase tracking-wide text-gray-500">Datum</th>
                <th className="text-left px-4 py-3 font-semibold text-xs uppercase tracking-wide text-gray-500">Kunde</th>
                <th className="text-left px-4 py-3 font-semibold text-xs uppercase tracking-wide text-gray-500">Gültig bis</th>
                <th className="text-left px-4 py-3 font-semibold text-xs uppercase tracking-wide text-gray-500">Status</th>
                <th className="text-right px-4 py-3 font-semibold text-xs uppercase tracking-wide text-gray-500">Betrag</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {angebote.map((a) => {
                const istAbgelaufen = a.gueltigBis && new Date(a.gueltigBis) < new Date() && a.status === 'offen'
                return (
                  <tr
                    key={a.id}
                    className="hover:bg-gray-50 transition cursor-pointer"
                    onClick={() => setGewaehlt(a)}
                  >
                    <td className="px-4 py-3 font-mono font-medium text-gray-800">
                      A-{String(a.nummer).padStart(4, '0')}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(a.datum).toLocaleDateString('de-AT')}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {a.kunde?.bezeichnung ?? <span className="text-gray-400 italic">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {a.gueltigBis ? (
                        <span className={istAbgelaufen ? 'text-red-600 font-medium' : 'text-gray-600'}>
                          {a.gueltigBis}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-gray-800">
                      {formatPreis(a.gesamtbetragCent)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setGewaehlt(a) }}
                        className="text-xs text-brand-600 hover:underline font-medium"
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail-Modal */}
      <Modal
        open={!!gewaehlt}
        onClose={() => setGewaehlt(null)}
        title={gewaehlt ? `Angebot A-${String(gewaehlt.nummer).padStart(4, '0')}` : ''}
        size="lg"
      >
        {gewaehlt && (
          <AngebotDetailModal
            angebot={gewaehlt}
            onClose={() => setGewaehlt(null)}
            onUpdate={(id, input) => updateMutation.mutate({ id, input })}
            updating={updateMutation.isPending}
          />
        )}
      </Modal>
    </div>
  )
}
