import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KATEGORIE_FARBE_LABELS,
  MWST_LABELS,
  type Artikel,
  type ArtikelInput,
  type Kategorie,
  type KategorieInput,
  type ModifikatorGruppe,
  type ModifikatorGruppeErstellen,
  type ModifikatorErstellen,
} from '@kassa/shared'
import { artikelApi, kategorieApi, modifikatorApi, bonierdruckerApi, lieferantApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { ArtikelFormular } from '../components/ArtikelFormular'
import { KategorieFormular } from '../components/KategorieFormular'
import { ArtikelImportModal } from '../components/ArtikelImportModal'
import { exportArtikelVorlage } from '../lib/artikel-excel'

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
  // Modifikator-Gruppen-State
  // ---------------------------------------------------------------------------
  const [modPanelOffen, setModPanelOffen]         = useState(false)
  const [modGruppeModalOpen, setModGruppeModalOpen] = useState(false)
  const [editingModGruppe, setEditingModGruppe]   = useState<ModifikatorGruppe | null>(null)
  const [modGruppeError, setModGruppeError]       = useState<string | null>(null)
  const [modModalOpen, setModModalOpen]           = useState(false)
  const [modZielGruppeId, setModZielGruppeId]     = useState<string | null>(null)
  const [modError, setModError]                   = useState<string | null>(null)
  /** Artikel, für den gerade die Gruppen-Zuweisung bearbeitet wird */
  const [zuweisungArtikelId, setZuweisungArtikelId] = useState<string | null>(null)
  /** Import-Modal */
  const [importModalOpen, setImportModalOpen] = useState(false)

  /** Modifikator, dessen Lagerstand gerade gesetzt wird */
  const [bestandModal, setBestandModal] = useState<{
    modId:   string
    name:    string
    current: number | null
  } | null>(null)

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

  const modGruppenQuery = useQuery({
    queryKey: ['modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeGruppen(),
  })

  const bonierdruckerQuery = useQuery({
    queryKey: ['bonierdrucker'],
    queryFn:  bonierdruckerApi.list,
  })

  const lieferantenQuery = useQuery({
    queryKey: ['lieferanten'],
    queryFn:  lieferantApi.list,
  })

  const invalidateArtikel = () =>
    queryClient.invalidateQueries({ queryKey: ['artikel', identity.mandantId] })

  const invalidateKategorien = () =>
    queryClient.invalidateQueries({ queryKey: ['kategorien'] })

  const invalidateModGruppen = () =>
    queryClient.invalidateQueries({ queryKey: ['modifikator-gruppen'] })

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
        station:         input.station          ?? null,
        kategorieId:     input.kategorieId      ?? null,
        istFavorit:      input.istFavorit,
        bonierdruckerId: input.bonierdruckerId  ?? null,
        lagerstandAktiv: input.lagerstandAktiv,
        lagerstandMenge: input.lagerstandMenge  ?? null,
        bild:            input.bild             ?? null,
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
  // Modifikator-Gruppen-Mutationen
  // ---------------------------------------------------------------------------
  const modGruppeCreate = useMutation({
    mutationFn: (input: ModifikatorGruppeErstellen) => modifikatorApi.erstelleGruppe(input),
    onSuccess: () => {
      setModGruppeModalOpen(false); setEditingModGruppe(null)
      setModGruppeError(null); invalidateModGruppen()
      queryClient.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] })
    },
    onError: (err) => setModGruppeError(err instanceof Error ? err.message : String(err)),
  })

  const modGruppeUpdate = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ModifikatorGruppeErstellen }) =>
      modifikatorApi.aktualisiereGruppe(id, input),
    onSuccess: () => {
      setModGruppeModalOpen(false); setEditingModGruppe(null)
      setModGruppeError(null); invalidateModGruppen()
      queryClient.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] })
    },
    onError: (err) => setModGruppeError(err instanceof Error ? err.message : String(err)),
  })

  const modGruppeLoeschen = useMutation({
    mutationFn: (id: string) => modifikatorApi.loescheGruppe(id),
    onSuccess: () => {
      invalidateModGruppen()
      queryClient.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] })
    },
  })

  const modCreate = useMutation({
    mutationFn: ({ gruppeId, input }: { gruppeId: string; input: ModifikatorErstellen }) =>
      modifikatorApi.erstelleModifikator(gruppeId, input),
    onSuccess: () => {
      setModModalOpen(false); setModZielGruppeId(null)
      setModError(null); invalidateModGruppen()
    },
    onError: (err) => setModError(err instanceof Error ? err.message : String(err)),
  })

  const modLoeschen = useMutation({
    mutationFn: (id: string) => modifikatorApi.loescheModifikator(id),
    onSuccess: () => invalidateModGruppen(),
  })

  const modBestandUpdate = useMutation({
    mutationFn: ({ id, lagerstandMenge }: { id: string; lagerstandMenge: number | null }) =>
      modifikatorApi.aktualisiereModifikator(id, { lagerstandMenge }),
    onSuccess: () => { setBestandModal(null); invalidateModGruppen() },
  })

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
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => exportArtikelVorlage(undefined, katList.data ?? [])}
              title="Leere Excel-Vorlage herunterladen (mit Dropdowns für Kategorie, MwSt & Station)"
            >
              Vorlage
            </Button>
            <Button
              variant="secondary"
              onClick={() => exportArtikelVorlage(list.data ?? [], katList.data ?? [])}
              title="Alle Artikel als Excel exportieren"
            >
              Exportieren
            </Button>
            <Button
              variant="secondary"
              onClick={() => setImportModalOpen(true)}
            >
              Importieren
            </Button>
            <Button onClick={openNew}>+ Neuer Artikel</Button>
          </div>
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
                  <th className="px-4 py-2 font-semibold text-right">Bestand</th>
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
                    <td className="px-4 py-2.5 text-right">
                      {a.lagerstandAktiv ? (
                        a.lagerstandMenge === 0 ? (
                          <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
                            Ausverkauft
                          </span>
                        ) : a.lagerstandMenge !== null ? (
                          <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-mono font-medium text-amber-700">
                            {a.lagerstandMenge}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">∞</span>
                        )
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
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
                      <button
                        type="button"
                        onClick={() => setZuweisungArtikelId(a.id)}
                        className="text-xs text-purple-600 hover:underline mr-3"
                        title="Modifikator-Gruppen zuweisen"
                      >
                        Optionen
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
      {/* Modifikator-Gruppen-Bereich (aufklappbar)                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200">
        <button
          type="button"
          onClick={() => setModPanelOffen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <h2 className="text-base font-semibold text-gray-900">Modifikator-Gruppen</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Varianten und Extras — z. B. Größe, Sauce, Garpunkt
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">
              {modGruppenQuery.data?.filter(g => g.aktiv).length ?? 0} aktiv
            </span>
            <svg
              className={`h-4 w-4 text-gray-400 transition-transform ${modPanelOffen ? 'rotate-180' : ''}`}
              viewBox="0 0 20 20" fill="currentColor"
            >
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06z" clipRule="evenodd" />
            </svg>
          </div>
        </button>

        {modPanelOffen && (
          <div className="border-t border-gray-200">
            <div className="px-4 py-3 flex justify-end">
              <Button onClick={() => { setEditingModGruppe(null); setModGruppeError(null); setModGruppeModalOpen(true) }}>
                + Neue Gruppe
              </Button>
            </div>

            {modGruppenQuery.isLoading ? (
              <div className="px-4 pb-4 text-sm text-gray-500">Wird geladen…</div>
            ) : !modGruppenQuery.data || modGruppenQuery.data.length === 0 ? (
              <div className="px-4 pb-6 text-center">
                <p className="text-sm text-gray-500">Noch keine Modifikator-Gruppen angelegt.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 pb-2">
                {modGruppenQuery.data
                  .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
                  .map((gruppe) => (
                    <div key={gruppe.id} className={`px-4 py-3 ${gruppe.aktiv ? '' : 'opacity-60'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-gray-900">{gruppe.name}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                            gruppe.typ === 'pflicht'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}>
                            {gruppe.typ === 'pflicht' ? 'Pflicht' : 'Optional'}
                          </span>
                          {gruppe.maxAuswahl && (
                            <span className="text-xs text-gray-400">max. {gruppe.maxAuswahl}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setModZielGruppeId(gruppe.id)
                              setModError(null)
                              setModModalOpen(true)
                            }}
                            className="text-xs text-brand-600 hover:underline"
                          >
                            + Option
                          </button>
                          <button
                            type="button"
                            onClick={() => { setEditingModGruppe(gruppe); setModGruppeError(null); setModGruppeModalOpen(true) }}
                            className="text-xs text-gray-500 hover:underline"
                          >
                            Bearbeiten
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (confirm(`Gruppe „${gruppe.name}" und alle Optionen löschen?`)) {
                                modGruppeLoeschen.mutate(gruppe.id)
                              }
                            }}
                            className="text-xs text-red-600 hover:underline"
                          >
                            Löschen
                          </button>
                        </div>
                      </div>

                      {/* Optionen */}
                      {gruppe.modifikatoren.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {gruppe.modifikatoren
                            .sort((a, b) => a.reihenfolge - b.reihenfolge)
                            .map((m) => (
                              <span
                                key={m.id}
                                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                                  m.aktiv
                                    ? 'border-gray-200 bg-gray-50 text-gray-700'
                                    : 'border-gray-100 bg-gray-50 text-gray-300'
                                }`}
                              >
                                {m.name}
                                {m.aufschlagCent !== 0 && (
                                  <span className={`font-mono ${m.aufschlagCent > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                                    {m.aufschlagCent > 0 ? '+' : ''}{(m.aufschlagCent / 100).toFixed(2)}
                                  </span>
                                )}
                                {/* Lagerstand pro Variante */}
                                <button
                                  type="button"
                                  title="Lagerstand setzen"
                                  onClick={() => setBestandModal({ modId: m.id, name: m.name, current: m.lagerstandMenge })}
                                  className={`rounded px-1 text-[10px] font-medium leading-none transition
                                    ${m.lagerstandMenge === null
                                      ? 'text-gray-300 hover:text-blue-500'
                                      : m.lagerstandMenge === 0
                                      ? 'bg-red-100 text-red-600 hover:bg-red-200'
                                      : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                                    }`}
                                >
                                  {m.lagerstandMenge === null ? '∞' : m.lagerstandMenge}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (confirm(`Option „${m.name}" löschen?`)) {
                                      modLoeschen.mutate(m.id)
                                    }
                                  }}
                                  className="text-gray-300 hover:text-red-500 ml-0.5"
                                >×</button>
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
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
          bonierdrucker={bonierdruckerQuery.data}
          lieferanten={lieferantenQuery.data}
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
          bonierdrucker={bonierdruckerQuery.data}
          onSubmit={handleKatSubmit}
          onCancel={() => { setKatModalOpen(false); setEditingKat(null); setKatError(null) }}
          loading={katCreate.isPending || katUpdate.isPending}
          fehler={katMutationError ?? undefined}
        />
      </Modal>

      {/* Modifikator-Gruppe Modal */}
      <Modal
        open={modGruppeModalOpen}
        onClose={() => { setModGruppeModalOpen(false); setEditingModGruppe(null); setModGruppeError(null) }}
        title={editingModGruppe ? 'Gruppe bearbeiten' : 'Neue Modifikator-Gruppe'}
      >
        <ModifikatorGruppeFormular
          initial={editingModGruppe}
          loading={modGruppeCreate.isPending || modGruppeUpdate.isPending}
          fehler={modGruppeError ?? undefined}
          onSubmit={(input) => {
            if (editingModGruppe) {
              modGruppeUpdate.mutate({ id: editingModGruppe.id, input })
            } else {
              modGruppeCreate.mutate(input)
            }
          }}
          onCancel={() => { setModGruppeModalOpen(false); setEditingModGruppe(null); setModGruppeError(null) }}
        />
      </Modal>

      {/* Modifikator (Option) Modal */}
      <Modal
        open={modModalOpen}
        onClose={() => { setModModalOpen(false); setModZielGruppeId(null); setModError(null) }}
        title="Neue Option"
      >
        <ModifikatorFormular
          loading={modCreate.isPending}
          fehler={modError ?? undefined}
          onSubmit={(input) => {
            if (modZielGruppeId) modCreate.mutate({ gruppeId: modZielGruppeId, input })
          }}
          onCancel={() => { setModModalOpen(false); setModZielGruppeId(null); setModError(null) }}
        />
      </Modal>

      {/* Excel-Import Modal */}
      <ArtikelImportModal
        open={importModalOpen}
        kategorien={katList.data ?? []}
        mandantId={identity.mandantId}
        onClose={() => { setImportModalOpen(false); invalidateArtikel() }}
      />

      {/* Artikel-Gruppen-Zuweisung Modal */}
      {zuweisungArtikelId && (
        <ArtikelGruppenZuweisungModal
          artikelId={zuweisungArtikelId}
          artikelName={list.data?.find(a => a.id === zuweisungArtikelId)?.bezeichnung ?? ''}
          alleGruppen={modGruppenQuery.data ?? []}
          onClose={() => setZuweisungArtikelId(null)}
        />
      )}

      {/* Lagerstand-Modal für Modifikator-Varianten */}
      {bestandModal && (
        <BestandSetzenModal
          modId={bestandModal.modId}
          name={bestandModal.name}
          current={bestandModal.current}
          loading={modBestandUpdate.isPending}
          onSubmit={(id, menge) => modBestandUpdate.mutate({ id, lagerstandMenge: menge })}
          onClose={() => setBestandModal(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modifikator-Gruppe Formular
// ---------------------------------------------------------------------------

function ModifikatorGruppeFormular({
  initial, loading, fehler, onSubmit, onCancel,
}: {
  initial?: ModifikatorGruppe | null
  loading:  boolean
  fehler?:  string | undefined
  onSubmit: (input: ModifikatorGruppeErstellen) => void
  onCancel: () => void
}) {
  const [name, setName]               = useState(initial?.name ?? '')
  const [typ, setTyp]                 = useState<'pflicht' | 'optional'>(initial?.typ ?? 'optional')
  const [maxAuswahl, setMaxAuswahl]   = useState<string>(
    initial?.maxAuswahl != null ? String(initial.maxAuswahl) : '',
  )

  useEffect(() => {
    setName(initial?.name ?? '')
    setTyp(initial?.typ ?? 'optional')
    setMaxAuswahl(initial?.maxAuswahl != null ? String(initial.maxAuswahl) : '')
  }, [initial])

  const submit = () => {
    if (!name.trim()) return
    const max = maxAuswahl.trim() ? parseInt(maxAuswahl, 10) : null
    onSubmit({ name: name.trim(), typ, maxAuswahl: max, reihenfolge: initial?.reihenfolge ?? 0 })
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Name</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="z. B. Größe, Sauce, Extras …"
          className="mt-1"
        />
      </label>

      <fieldset>
        <legend className="text-sm font-medium text-gray-700 mb-1.5">Typ</legend>
        <div className="flex gap-4">
          {(['optional', 'pflicht'] as const).map((t) => (
            <label key={t} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
              <input
                type="radio"
                value={t}
                checked={typ === t}
                onChange={() => setTyp(t)}
                className="text-brand-600 focus:ring-brand-500"
              />
              <span>{t === 'optional' ? 'Optional' : 'Pflicht (mind. 1)'}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Max. Auswahl</span>
        <Input
          inputMode="numeric"
          value={maxAuswahl}
          onChange={(e) => setMaxAuswahl(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="Leer = unbegrenzt"
          className="mt-1 w-40"
        />
        <p className="mt-0.5 text-xs text-gray-400">Leer = unbegrenzt viele Optionen wählbar</p>
      </label>

      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onCancel} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1" disabled={!name.trim()}>
          {initial ? 'Speichern' : 'Erstellen'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modifikator (Option) Formular
// ---------------------------------------------------------------------------

function ModifikatorFormular({
  loading, fehler, onSubmit, onCancel,
}: {
  loading:  boolean
  fehler?:  string | undefined
  onSubmit: (input: ModifikatorErstellen) => void
  onCancel: () => void
}) {
  const [name, setName]               = useState('')
  const [aufschlagStr, setAufschlag]  = useState('0')
  const [lsStr, setLsStr]             = useState('')   // leerstring = kein Countdown

  const submit = () => {
    if (!name.trim()) return
    const cents  = Math.round(parseFloat(aufschlagStr.replace(',', '.') || '0') * 100)
    const lsMenge = lsStr.trim() !== '' ? parseInt(lsStr.trim(), 10) : null
    onSubmit({
      name: name.trim(),
      aufschlagCent: isNaN(cents) ? 0 : cents,
      reihenfolge: 0,
      lagerstandMenge: lsMenge,
    })
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Bezeichnung</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="z. B. Groß, Ketchup, Medium …"
          className="mt-1"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Aufschlag (€)</span>
        <Input
          inputMode="decimal"
          value={aufschlagStr}
          onChange={(e) => setAufschlag(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="0.00"
          className="mt-1 w-32"
        />
        <p className="mt-0.5 text-xs text-gray-400">
          Positiv = Aufpreis, Negativ = Rabatt, 0 = gratis
        </p>
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Anfangsbestand</span>
        <Input
          type="number"
          min="0"
          step="1"
          value={lsStr}
          onChange={(e) => setLsStr(e.target.value)}
          placeholder="Leer = unbegrenzt"
          className="mt-1 w-36"
        />
        <p className="mt-0.5 text-xs text-gray-400">
          Leer = kein Countdown, eine Zahl aktiviert den Lagerstand für diese Variante
        </p>
      </label>

      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onCancel} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1" disabled={!name.trim()}>
          Hinzufügen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lagerstand-Modal für einzelne Modifikator-Varianten
// ---------------------------------------------------------------------------

function BestandSetzenModal({
  modId, name, current, loading, onSubmit, onClose,
}: {
  modId:    string
  name:     string
  current:  number | null
  loading:  boolean
  onSubmit: (id: string, menge: number | null) => void
  onClose:  () => void
}) {
  const [wertStr, setWertStr] = useState(current !== null ? String(current) : '')

  useEffect(() => {
    setWertStr(current !== null ? String(current) : '')
  }, [current])

  const submit = () => {
    const menge = wertStr.trim() === '' ? null : parseInt(wertStr.trim(), 10)
    if (menge !== null && (isNaN(menge) || menge < 0)) return
    onSubmit(modId, menge)
  }

  return (
    <Modal open onClose={onClose} title={`Lagerstand: ${name}`} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Bestand für diese Variante setzen. Bei Erreichen von&nbsp;0 wird sie
          im Bestelldialog gesperrt.
        </p>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Aktueller Bestand</span>
          <Input
            autoFocus
            type="number"
            min="0"
            step="1"
            value={wertStr}
            onChange={(e) => setWertStr(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Leer = kein Countdown"
            className="mt-1 w-36"
          />
          <p className="mt-0.5 text-xs text-gray-400">
            Leer = kein Countdown (unbegrenzt)
          </p>
        </label>
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button onClick={submit} loading={loading} className="flex-1">Speichern</Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Artikel-Gruppen-Zuweisung Modal
// ---------------------------------------------------------------------------

function ArtikelGruppenZuweisungModal({
  artikelId, artikelName, alleGruppen, onClose,
}: {
  artikelId:   string
  artikelName: string
  alleGruppen: ModifikatorGruppe[]
  onClose:     () => void
}) {
  const qc = useQueryClient()

  const zuweisungQuery = useQuery({
    queryKey: ['artikel-gruppen', artikelId],
    queryFn:  () => modifikatorApi.getGruppenFuerArtikel(artikelId),
  })

  const [gewählteIds, setGewählteIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (zuweisungQuery.data) {
      setGewählteIds(new Set(zuweisungQuery.data.map(g => g.id)))
    }
  }, [zuweisungQuery.data])

  const speichernMutation = useMutation({
    mutationFn: (gruppenIds: string[]) =>
      modifikatorApi.setzeGruppenFuerArtikel(artikelId, { gruppenIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artikel-gruppen', artikelId] })
      qc.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] })
      onClose()
    },
  })

  const aktiveGruppen = alleGruppen.filter(g => g.aktiv)

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Optionen für „${artikelName}"`}
      size="md"
    >
      {zuweisungQuery.isLoading ? (
        <p className="text-sm text-gray-500 py-4">Wird geladen…</p>
      ) : aktiveGruppen.length === 0 ? (
        <p className="text-sm text-gray-500 py-4">
          Noch keine Modifikator-Gruppen angelegt. Bitte zuerst im Panel oben Gruppen erstellen.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Wähle die Gruppen, die für diesen Artikel angeboten werden sollen:
          </p>
          <div className="space-y-2">
            {aktiveGruppen.map((gruppe) => {
              const ist = gewählteIds.has(gruppe.id)
              return (
                <label
                  key={gruppe.id}
                  className="flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-2.5 cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={ist}
                    onChange={() => {
                      setGewählteIds(prev => {
                        const next = new Set(prev)
                        if (ist) next.delete(gruppe.id)
                        else next.add(gruppe.id)
                        return next
                      })
                    }}
                    className="mt-0.5 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{gruppe.name}</span>
                      <span className={`text-xs px-1.5 rounded-full ${
                        gruppe.typ === 'pflicht' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {gruppe.typ === 'pflicht' ? 'Pflicht' : 'Optional'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {gruppe.modifikatoren.filter(m => m.aktiv).map(m => m.name).join(', ') || 'Keine Optionen'}
                    </p>
                  </div>
                </label>
              )
            })}
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
            <Button
              onClick={() => speichernMutation.mutate([...gewählteIds])}
              loading={speichernMutation.isPending}
              className="flex-1"
            >
              Speichern
            </Button>
          </div>
        </div>
      )}
    </Modal>
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
