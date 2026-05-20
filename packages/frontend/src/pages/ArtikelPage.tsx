import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MWST_LABELS, type Artikel, type ArtikelInput } from '@kassa/shared'
import { artikelApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { ArtikelFormular } from '../components/ArtikelFormular'

export function ArtikelPage() {
  const identity = getKasseIdentity()!
  const queryClient = useQueryClient()

  const [modalOpen, setModalOpen]   = useState(false)
  const [editing, setEditing]       = useState<Artikel | null>(null)
  const [nurAktive, setNurAktive]   = useState(true)
  const [mutationError, setError]   = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['artikel', identity.mandantId, nurAktive],
    queryFn:  () => artikelApi.list(identity.mandantId, nurAktive),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['artikel', identity.mandantId] })

  const create = useMutation({
    mutationFn: artikelApi.create,
    onSuccess: () => {
      setModalOpen(false)
      setEditing(null)
      setError(null)
      invalidate()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ArtikelInput }) =>
      artikelApi.update(id, {
        bezeichnung:     input.bezeichnung,
        preisBruttoCent: input.preisBruttoCent,
        mwstSatz:        input.mwstSatz,
        artikelnummer:   input.artikelnummer ?? null,
      }),
    onSuccess: () => {
      setModalOpen(false)
      setEditing(null)
      setError(null)
      invalidate()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const deaktiviere = useMutation({
    mutationFn: artikelApi.deaktiviere,
    onSuccess: () => invalidate(),
  })

  const handleSubmit = (input: ArtikelInput) => {
    if (editing) {
      update.mutate({ id: editing.id, input })
    } else {
      create.mutate(input)
    }
  }

  const openNew = () => {
    setEditing(null)
    setError(null)
    setModalOpen(true)
  }

  const openEdit = (a: Artikel) => {
    setEditing(a)
    setError(null)
    setModalOpen(true)
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Artikel</h1>
          <p className="mt-1 text-sm text-gray-500">
            Artikelstamm verwalten — Bezeichnung, Preis, MwSt-Satz
          </p>
        </div>
        <Button onClick={openNew}>+ Neuer Artikel</Button>
      </div>

      {/* Filter */}
      <div className="mb-4 flex items-center gap-2">
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            className="rounded border-gray-300 text-brand-500 focus:ring-brand-500"
            checked={nurAktive}
            onChange={(e) => setNurAktive(e.target.checked)}
          />
          Nur aktive Artikel anzeigen
        </label>
      </div>

      {/* Liste */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        {list.isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Wird geladen…</div>
        ) : list.isError ? (
          <div className="p-8 text-center text-sm text-red-600">
            Fehler: {list.error instanceof Error ? list.error.message : 'Unbekannt'}
          </div>
        ) : list.data && list.data.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-gray-500">Noch keine Artikel angelegt.</p>
            <Button className="mt-4" onClick={openNew}>Ersten Artikel anlegen</Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Bezeichnung</th>
                <th className="px-4 py-2 font-semibold">Nummer</th>
                <th className="px-4 py-2 font-semibold">MwSt</th>
                <th className="px-4 py-2 font-semibold text-right">Preis</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.data?.map((a) => (
                <tr key={a.id} className={a.aktiv ? '' : 'opacity-60'}>
                  <td className="px-4 py-2.5 font-medium text-gray-900">{a.bezeichnung}</td>
                  <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">
                    {a.artikelnummer ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">{MWST_LABELS[a.mwstSatz]}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-900">
                    {formatPreis(a.preisBruttoCent)}
                  </td>
                  <td className="px-4 py-2.5">
                    {a.aktiv ? (
                      <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                        aktiv
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                        deaktiviert
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openEdit(a)}
                      className="text-xs text-brand-600 hover:underline mr-3"
                    >
                      Bearbeiten
                    </button>
                    {a.aktiv && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`„${a.bezeichnung}" wirklich deaktivieren?`)) {
                            deaktiviere.mutate(a.id)
                          }
                        }}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Deaktivieren
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); setError(null) }}
        title={editing ? 'Artikel bearbeiten' : 'Neuer Artikel'}
      >
        <ArtikelFormular
          mandantId={identity.mandantId}
          initial={editing}
          onSubmit={handleSubmit}
          onCancel={() => { setModalOpen(false); setEditing(null); setError(null) }}
          loading={create.isPending || update.isPending}
          fehler={mutationError ?? undefined}
        />
      </Modal>
    </div>
  )
}
