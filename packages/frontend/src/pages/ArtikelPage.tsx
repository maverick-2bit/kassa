import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KATEGORIE_FARBE_LABELS,
  MWST_LABELS,
  type Artikel,
  type ArtikelInput,
  type Kategorie,
  type KategorieInput,
} from '@kassa/shared'
import { artikelApi, kategorieApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { ArtikelFormular } from '../components/ArtikelFormular'
import { KategorieFormular } from '../components/KategorieFormular'

export function ArtikelPage() {
  const identity = getKasseIdentity()!
  const queryClient = useQueryClient()

  // ---------------------------------------------------------------------------
  // Artikel-State
  // ---------------------------------------------------------------------------
  const [modalOpen, setModalOpen]   = useState(false)
  const [editing, setEditing]       = useState<Artikel | null>(null)
  const [nurAktive, setNurAktive]   = useState(true)
  const [mutationError, setError]   = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Kategorie-State
  // ---------------------------------------------------------------------------
  const [katModalOpen, setKatModalOpen]   = useState(false)
  const [editingKat, setEditingKat]       = useState<Kategorie | null>(null)
  const [katMutationError, setKatError]   = useState<string | null>(null)
  const [katPanelOffen, setKatPanelOffen] = useState(false)

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------
  const list = useQuery({
    queryKey: ['artikel', identity.mandantId, nurAktive],
    queryFn:  () => artikelApi.list(identity.mandantId, nurAktive),
  })

  const katList = useQuery({
    queryKey: ['kategorien'],
    queryFn:  () => kategorieApi.list(false),
  })

  const invalidateArtikel = () =>
    queryClient.invalidateQueries({ queryKey: ['artikel', identity.mandantId] })

  const invalidateKategorien = () =>
    queryClient.invalidateQueries({ queryKey: ['kategorien'] })

  // ---------------------------------------------------------------------------
  // Artikel-Mutationen
  // ---------------------------------------------------------------------------
  const create = useMutation({
    mutationFn: artikelApi.create,
    onSuccess: () => { setModalOpen(false); setEditing(null); setError(null); invalidateArtikel() },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ArtikelInput }) =>
      artikelApi.update(id, {
        bezeichnung:     input.bezeichnung,
        preisBruttoCent: input.preisBruttoCent,
        mwstSatz:        input.mwstSatz,
        artikelnummer:   input.artikelnummer ?? null,
        station:         input.station ?? null,
        kategorieId:     input.kategorieId ?? null,
      }),
    onSuccess: () => { setModalOpen(false); setEditing(null); setError(null); invalidateArtikel() },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const deaktiviere = useMutation({
    mutationFn: artikelApi.deaktiviere,
    onSuccess: () => invalidateArtikel(),
  })

  const handleSubmit = (input: ArtikelInput) => {
    if (editing) {
      update.mutate({ id: editing.id, input })
    } else {
      create.mutate(input)
    }
  }

  // ---------------------------------------------------------------------------
  // Kategorie-Mutationen
  // ---------------------------------------------------------------------------
  const katCreate = useMutation({
    mutationFn: kategorieApi.create,
    onSuccess: () => { setKatModalOpen(false); setEditingKat(null); setKatError(null); invalidateKategorien() },
    onError: (err) => setKatError(err instanceof Error ? err.message : String(err)),
  })

  const katUpdate = useMutation({
    mutationFn: ({ id, input }: { id: string; input: KategorieInput }) =>
      kategorieApi.update(id, input),
    onSuccess: () => { setKatModalOpen(false); setEditingKat(null); setKatError(null); invalidateKategorien() },
    onError: (err) => setKatError(err instanceof Error ? err.message : String(err)),
  })

  const katDeaktiviere = useMutation({
    mutationFn: kategorieApi.deaktiviere,
    onSuccess: () => invalidateKategorien(),
  })

  const handleKatSubmit = (input: KategorieInput) => {
    if (editingKat) {
      katUpdate.mutate({ id: editingKat.id, input })
    } else {
      katCreate.mutate(input)
    }
  }

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------
  const openNew = () => { setEditing(null); setError(null); setModalOpen(true) }
  const openEdit = (a: Artikel) => { setEditing(a); setError(null); setModalOpen(true) }

  const openNewKat = () => { setEditingKat(null); setKatError(null); setKatModalOpen(true) }
  const openEditKat = (k: Kategorie) => { setEditingKat(k); setKatError(null); setKatModalOpen(true) }

  // Kategorie-Name für eine ID
  const katNameFuerId = (id: string | null) => {
    if (!id) return null
    return katList.data?.find(k => k.id === id)?.name ?? null
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* Artikel-Bereich                                                     */}
      {/* ------------------------------------------------------------------ */}
      <div>
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Artikel</h1>
            <p className="mt-1 text-sm text-gray-500">
              Artikelstamm verwalten — Bezeichnung, Preis, MwSt-Satz, Kategorie
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
                  <th className="px-4 py-2 font-semibold">Kategorie</th>
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
                    <td className="px-4 py-2.5 text-gray-500 text-xs">
                      {katNameFuerId(a.kategorieId) ?? <span className="text-gray-300">—</span>}
                    </td>
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
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Kategorien-Bereich (aufklappbar)                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200">
        <button
          type="button"
          onClick={() => setKatPanelOffen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <h2 className="text-base font-semibold text-gray-900">Kategorien</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Artikel-Kategorien für Tab-Gruppierung in der Kassen-Ansicht
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">
              {katList.data?.filter(k => k.aktiv).length ?? 0} aktiv
            </span>
            <svg
              className={`h-4 w-4 text-gray-400 transition-transform ${katPanelOffen ? 'rotate-180' : ''}`}
              viewBox="0 0 20 20" fill="currentColor"
            >
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06z" clipRule="evenodd" />
            </svg>
          </div>
        </button>

        {katPanelOffen && (
          <div className="border-t border-gray-200">
            <div className="px-4 py-3 flex justify-end">
              <Button onClick={openNewKat}>+ Neue Kategorie</Button>
            </div>

            {katList.isLoading ? (
              <div className="px-4 pb-4 text-sm text-gray-500">Wird geladen…</div>
            ) : !katList.data || katList.data.length === 0 ? (
              <div className="px-4 pb-6 text-center">
                <p className="text-sm text-gray-500">Noch keine Kategorien angelegt.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-4 py-2 font-semibold">Farbe</th>
                    <th className="px-4 py-2 font-semibold">Reihenfolge</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {katList.data
                    .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
                    .map((k) => (
                      <tr key={k.id} className={k.aktiv ? '' : 'opacity-60'}>
                        <td className="px-4 py-2.5 font-medium text-gray-900">{k.name}</td>
                        <td className="px-4 py-2.5">
                          <FarbChip farbe={k.farbe} />
                        </td>
                        <td className="px-4 py-2.5 text-gray-500">{k.reihenfolge}</td>
                        <td className="px-4 py-2.5">
                          {k.aktiv ? (
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
                            onClick={() => openEditKat(k)}
                            className="text-xs text-brand-600 hover:underline mr-3"
                          >
                            Bearbeiten
                          </button>
                          {k.aktiv && (
                            <button
                              type="button"
                              onClick={() => {
                                if (confirm(`Kategorie „${k.name}" wirklich deaktivieren?`)) {
                                  katDeaktiviere.mutate(k.id)
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
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Modals                                                               */}
      {/* ------------------------------------------------------------------ */}

      {/* Artikel-Modal */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); setError(null) }}
        title={editing ? 'Artikel bearbeiten' : 'Neuer Artikel'}
      >
        <ArtikelFormular
          mandantId={identity.mandantId}
          initial={editing}
          kategorien={katList.data}
          onSubmit={handleSubmit}
          onCancel={() => { setModalOpen(false); setEditing(null); setError(null) }}
          loading={create.isPending || update.isPending}
          fehler={mutationError ?? undefined}
        />
      </Modal>

      {/* Kategorie-Modal */}
      <Modal
        open={katModalOpen}
        onClose={() => { setKatModalOpen(false); setEditingKat(null); setKatError(null) }}
        title={editingKat ? 'Kategorie bearbeiten' : 'Neue Kategorie'}
      >
        <KategorieFormular
          initial={editingKat}
          onSubmit={handleKatSubmit}
          onCancel={() => { setKatModalOpen(false); setEditingKat(null); setKatError(null) }}
          loading={katCreate.isPending || katUpdate.isPending}
          fehler={katMutationError ?? undefined}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfkomponente: Farb-Chip
// ---------------------------------------------------------------------------

import type { KategorieFarbe } from '@kassa/shared'

const CHIP_KLASSEN: Record<KategorieFarbe, string> = {
  grau:   'bg-gray-200 text-gray-700',
  rot:    'bg-red-100 text-red-700',
  orange: 'bg-orange-100 text-orange-700',
  gelb:   'bg-yellow-100 text-yellow-700',
  gruen:  'bg-green-100 text-green-700',
  blau:   'bg-blue-100 text-blue-700',
  lila:   'bg-purple-100 text-purple-700',
  pink:   'bg-pink-100 text-pink-700',
}

function FarbChip({ farbe }: { farbe: KategorieFarbe }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_KLASSEN[farbe]}`}>
      {KATEGORIE_FARBE_LABELS[farbe]}
    </span>
  )
}
