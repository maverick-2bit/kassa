/**
 * ModifikatorenPage — Verwaltung aller Modifikator-Gruppen und Optionen.
 *
 * Funktionen:
 *  - Gruppen anlegen / bearbeiten / deaktivieren
 *  - Optionen (Modifikatoren) pro Gruppe anlegen / bearbeiten / deaktivieren
 *  - Artikel-Zuweisung: welche Artikel haben welche Gruppen
 *  - Lagerstand pro Option setzen
 */

import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Artikel,
  Modifikator,
  ModifikatorAktualisieren,
  ModifikatorErstellen,
  ModifikatorGruppe,
  ModifikatorGruppeAktualisieren,
  ModifikatorGruppeErstellen,
} from '@kassa/shared'
import { artikelApi, modifikatorApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function aufschlagLabel(cent: number): string {
  if (cent === 0) return 'Kein Aufschlag'
  const prefix = cent > 0 ? '+' : ''
  return `${prefix}${formatPreis(cent)}`
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function ModifikatorenPage() {
  const identity   = getKasseIdentity()!
  const qc         = useQueryClient()

  // ── State ─────────────────────────────────────────────────────────────────
  const [gewählteGruppeId,   setGewählteGruppeId]   = useState<string | null>(null)
  const [gruppeModalOpen,    setGruppeModalOpen]    = useState(false)
  const [editingGruppe,      setEditingGruppe]      = useState<ModifikatorGruppe | null>(null)
  const [modModalOpen,       setModModalOpen]       = useState(false)
  const [editingMod,         setEditingMod]         = useState<Modifikator | null>(null)
  const [bestandModal,       setBestandModal]       = useState<{ mod: Modifikator } | null>(null)
  const [zuweisungModal,     setZuweisungModal]     = useState<{ gruppe: ModifikatorGruppe } | null>(null)
  const [fehler,             setFehler]             = useState<string | null>(null)

  // ── Queries ───────────────────────────────────────────────────────────────
  const gruppenQuery = useQuery({
    queryKey: ['modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeGruppen(),
  })

  const artikel = useQuery({
    queryKey: ['artikel', identity.mandantId, false],
    queryFn:  () => artikelApi.list(identity.mandantId, false),
  })

  const zuweisungenQuery = useQuery({
    queryKey: ['artikel-modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeArtikelZuweisungen(),
  })

  // Gewählte Gruppe automatisch auswählen (erste, wenn keine gewählt)
  const gruppen = gruppenQuery.data ?? []
  useEffect(() => {
    if (!gewählteGruppeId && gruppen.length > 0) {
      setGewählteGruppeId(gruppen[0]?.id ?? null)
    }
  }, [gruppen, gewählteGruppeId])

  const gewählteGruppe = gruppen.find(g => g.id === gewählteGruppeId) ?? null

  // Anzahl Artikel pro Gruppe
  const artikelAnzahlProGruppe = (gruppeId: string) =>
    (zuweisungenQuery.data ?? []).filter(z => z.gruppeId === gruppeId).length

  // ── Gruppen-Mutationen ────────────────────────────────────────────────────
  const erstelleGruppe = useMutation({
    mutationFn: (input: ModifikatorGruppeErstellen) =>
      modifikatorApi.erstelleGruppe(input),
    onSuccess: (neue) => {
      qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] })
      setGruppeModalOpen(false)
      setGewählteGruppeId(neue.id)
    },
    onError: (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  const aktualisiereGruppe = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ModifikatorGruppeAktualisieren }) =>
      modifikatorApi.aktualisiereGruppe(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] })
      setGruppeModalOpen(false)
      setEditingGruppe(null)
    },
    onError: (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  const loescheGruppe = useMutation({
    mutationFn: (id: string) => modifikatorApi.loescheGruppe(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] })
      if (gewählteGruppeId === id) setGewählteGruppeId(null)
    },
    onError: (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  // ── Modifikator-Mutationen ────────────────────────────────────────────────
  const erstelleMod = useMutation({
    mutationFn: ({ gruppeId, input }: { gruppeId: string; input: ModifikatorErstellen }) =>
      modifikatorApi.erstelleModifikator(gruppeId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] })
      setModModalOpen(false)
      setEditingMod(null)
    },
    onError: (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  const aktualisiereMod = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ModifikatorAktualisieren }) =>
      modifikatorApi.aktualisiereModifikator(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] })
      setModModalOpen(false)
      setBestandModal(null)
      setEditingMod(null)
    },
    onError: (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  const loescheMod = useMutation({
    mutationFn: (id: string) => modifikatorApi.loescheModifikator(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] }),
    onError: (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white shrink-0">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Artikel-Optionen</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Varianten, Beilagen und Extras — z. B. Größe, Sauce, Garstufe
          </p>
        </div>
        <Button
          onClick={() => { setEditingGruppe(null); setGruppeModalOpen(true) }}
        >
          + Neue Gruppe
        </Button>
      </div>

      {fehler && (
        <div className="mx-6 mt-3 px-4 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm flex items-center justify-between">
          {fehler}
          <button onClick={() => setFehler(null)} className="ml-2 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {gruppenQuery.isLoading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Wird geladen…</div>
      ) : gruppen.length === 0 ? (
        <LeereZustand onNeu={() => setGruppeModalOpen(true)} />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Linke Spalte: Gruppen-Liste */}
          <div className="w-64 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto flex flex-col">
            <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Gruppen
            </div>
            {gruppen.map(gruppe => {
              const aktiv    = gruppe.id === gewählteGruppeId
              const anzahlMods = gruppe.modifikatoren.filter(m => m.aktiv).length
              const anzahlArtikel = artikelAnzahlProGruppe(gruppe.id)
              return (
                <button
                  key={gruppe.id}
                  onClick={() => setGewählteGruppeId(gruppe.id)}
                  className={`w-full text-left px-3 py-2.5 flex items-start gap-2 border-l-2 transition-colors ${
                    aktiv
                      ? 'border-brand-500 bg-white text-brand-700'
                      : 'border-transparent hover:bg-white hover:border-gray-300 text-gray-700'
                  } ${!gruppe.aktiv ? 'opacity-50' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{gruppe.name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        gruppe.typ === 'pflicht'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-200 text-gray-600'
                      }`}>
                        {gruppe.typ === 'pflicht' ? 'Pflicht' : 'Optional'}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {anzahlMods} Option{anzahlMods !== 1 ? 'en' : ''}
                      </span>
                    </div>
                    {anzahlArtikel > 0 && (
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        {anzahlArtikel} Artikel zugewiesen
                      </div>
                    )}
                  </div>
                  {!gruppe.aktiv && (
                    <span className="text-[10px] text-gray-400 shrink-0 mt-0.5">inaktiv</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Rechte Spalte: Detail der gewählten Gruppe */}
          <div className="flex-1 overflow-y-auto p-6">
            {!gewählteGruppe ? (
              <p className="text-gray-400 text-sm">Keine Gruppe gewählt.</p>
            ) : (
              <GruppeDetail
                gruppe={gewählteGruppe}
                alleArtikel={artikel.data ?? []}
                zuweisungen={zuweisungenQuery.data ?? []}
                onGruppeBearbeiten={() => { setEditingGruppe(gewählteGruppe); setGruppeModalOpen(true) }}
                onGruppeDeaktivieren={() => {
                  if (confirm(`Gruppe „${gewählteGruppe.name}" ${gewählteGruppe.aktiv ? 'deaktivieren' : 'aktivieren'}?`)) {
                    aktualisiereGruppe.mutate({ id: gewählteGruppe.id, input: { aktiv: !gewählteGruppe.aktiv } })
                  }
                }}
                onGruppeLoeschen={() => {
                  if (confirm(`Gruppe „${gewählteGruppe.name}" wirklich löschen? Alle Optionen werden gelöscht.`)) {
                    loescheGruppe.mutate(gewählteGruppe.id)
                  }
                }}
                onNeueMod={() => { setEditingMod(null); setModModalOpen(true) }}
                onModBearbeiten={(mod) => { setEditingMod(mod); setModModalOpen(true) }}
                onModDeaktivieren={(mod) => aktualisiereMod.mutate({ id: mod.id, input: { aktiv: !mod.aktiv } })}
                onModLoeschen={(mod) => {
                  if (confirm(`Option „${mod.name}" wirklich löschen?`)) loescheMod.mutate(mod.id)
                }}
                onBestandSetzen={(mod) => setBestandModal({ mod })}
                onZuweisungOeffnen={() => setZuweisungModal({ gruppe: gewählteGruppe })}
              />
            )}
          </div>
        </div>
      )}

      {/* Gruppen-Modal */}
      <GruppeFormModal
        open={gruppeModalOpen}
        editing={editingGruppe}
        onClose={() => { setGruppeModalOpen(false); setEditingGruppe(null) }}
        onSave={(input) => {
          if (editingGruppe) {
            aktualisiereGruppe.mutate({ id: editingGruppe.id, input })
          } else {
            erstelleGruppe.mutate(input as ModifikatorGruppeErstellen)
          }
        }}
        loading={erstelleGruppe.isPending || aktualisiereGruppe.isPending}
      />

      {/* Modifikator-Modal */}
      {gewählteGruppe && (
        <ModifikatorFormModal
          open={modModalOpen}
          editing={editingMod}
          gruppeName={gewählteGruppe.name}
          onClose={() => { setModModalOpen(false); setEditingMod(null) }}
          onSave={(input) => {
            if (editingMod) {
              aktualisiereMod.mutate({ id: editingMod.id, input })
            } else {
              erstelleMod.mutate({ gruppeId: gewählteGruppe.id, input: input as ModifikatorErstellen })
            }
          }}
          loading={erstelleMod.isPending || aktualisiereMod.isPending}
        />
      )}

      {/* Lagerstand-Modal */}
      {bestandModal && (
        <LagerstandModal
          mod={bestandModal.mod}
          onClose={() => setBestandModal(null)}
          onSave={(menge) => aktualisiereMod.mutate({
            id: bestandModal.mod.id,
            input: { lagerstandMenge: menge },
          })}
          loading={aktualisiereMod.isPending}
        />
      )}

      {/* Zuweisung-Modal */}
      {zuweisungModal && (
        <ArtikelZuweisungModal
          gruppe={zuweisungModal.gruppe}
          alleArtikel={artikel.data ?? []}
          zuweisungen={zuweisungenQuery.data ?? []}
          onClose={() => { setZuweisungModal(null); qc.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] }) }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gruppen-Detail (rechte Spalte)
// ---------------------------------------------------------------------------

function GruppeDetail({
  gruppe, alleArtikel, zuweisungen,
  onGruppeBearbeiten, onGruppeDeaktivieren, onGruppeLoeschen,
  onNeueMod, onModBearbeiten, onModDeaktivieren, onModLoeschen,
  onBestandSetzen, onZuweisungOeffnen,
}: {
  gruppe:               ModifikatorGruppe
  alleArtikel:          Artikel[]
  zuweisungen:          { artikelId: string; gruppeId: string }[]
  onGruppeBearbeiten:   () => void
  onGruppeDeaktivieren: () => void
  onGruppeLoeschen:     () => void
  onNeueMod:            () => void
  onModBearbeiten:      (m: Modifikator) => void
  onModDeaktivieren:    (m: Modifikator) => void
  onModLoeschen:        (m: Modifikator) => void
  onBestandSetzen:      (m: Modifikator) => void
  onZuweisungOeffnen:   () => void
}) {
  const zugewieseneArtikelIds = new Set(
    zuweisungen.filter(z => z.gruppeId === gruppe.id).map(z => z.artikelId)
  )
  const zugewieseneArtikel = alleArtikel.filter(a => zugewieseneArtikelIds.has(a.id))

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Gruppen-Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-gray-900">{gruppe.name}</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              gruppe.typ === 'pflicht' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
            }`}>
              {gruppe.typ === 'pflicht' ? 'Pflicht' : 'Optional'}
            </span>
            {!gruppe.aktiv && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-500">Inaktiv</span>
            )}
          </div>
          {gruppe.maxAuswahl && (
            <p className="text-sm text-gray-500 mt-1">Maximal {gruppe.maxAuswahl} Auswahl</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" onClick={onGruppeBearbeiten}>Bearbeiten</Button>
          <Button
            variant="secondary"
            onClick={onGruppeDeaktivieren}
          >
            {gruppe.aktiv ? 'Deaktivieren' : 'Aktivieren'}
          </Button>
          <button
            onClick={onGruppeLoeschen}
            className="text-sm text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors"
          >
            Löschen
          </button>
        </div>
      </div>

      {/* Optionen */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Optionen</h3>
          <Button onClick={onNeueMod}>+ Option hinzufügen</Button>
        </div>

        {gruppe.modifikatoren.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 py-8 text-center">
            <p className="text-sm text-gray-400">Noch keine Optionen. Füge die erste Option hinzu.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 overflow-hidden divide-y divide-gray-100">
            {gruppe.modifikatoren.map((mod, idx) => (
              <ModifikatorZeile
                key={mod.id}
                mod={mod}
                index={idx}
                onBearbeiten={() => onModBearbeiten(mod)}
                onDeaktivieren={() => onModDeaktivieren(mod)}
                onLoeschen={() => onModLoeschen(mod)}
                onBestandSetzen={() => onBestandSetzen(mod)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Artikel-Zuweisung */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">
            Zugewiesene Artikel
            <span className="ml-2 text-gray-400 font-normal">({zugewieseneArtikel.length})</span>
          </h3>
          <Button variant="secondary" onClick={onZuweisungOeffnen}>Zuweisung bearbeiten</Button>
        </div>

        {zugewieseneArtikel.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 py-6 text-center">
            <p className="text-sm text-gray-400">
              Noch keinem Artikel zugewiesen.
            </p>
            <button
              onClick={onZuweisungOeffnen}
              className="mt-2 text-sm text-brand-600 hover:text-brand-700"
            >
              Artikel zuweisen →
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {zugewieseneArtikel.map(a => (
              <span
                key={a.id}
                className="inline-flex items-center rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-700"
              >
                {a.bezeichnung}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modifikator-Zeile
// ---------------------------------------------------------------------------

function ModifikatorZeile({
  mod, index,
  onBearbeiten, onDeaktivieren, onLoeschen, onBestandSetzen,
}: {
  mod:             Modifikator
  index:           number
  onBearbeiten:    () => void
  onDeaktivieren:  () => void
  onLoeschen:      () => void
  onBestandSetzen: () => void
}) {
  const istAusverkauft  = mod.lagerstandMenge === 0
  const hatLagerstand   = mod.lagerstandMenge !== null

  return (
    <div className={`flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50 transition-colors ${!mod.aktiv ? 'opacity-50' : ''}`}>
      <span className="text-xs text-gray-300 w-4 text-right shrink-0">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900">{mod.name}</span>
          {!mod.aktiv && <span className="text-[10px] text-gray-400">(inaktiv)</span>}
          {istAusverkauft && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">Ausverkauft</span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className={`text-xs font-mono ${
            mod.aufschlagCent > 0 ? 'text-orange-600' :
            mod.aufschlagCent < 0 ? 'text-green-600' : 'text-gray-400'
          }`}>
            {aufschlagLabel(mod.aufschlagCent)}
          </span>
          {hatLagerstand && (
            <button
              onClick={onBestandSetzen}
              className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
            >
              Bestand: {mod.lagerstandMenge === 0 ? '0 (ausverkauft)' : mod.lagerstandMenge}
            </button>
          )}
          {!hatLagerstand && (
            <button
              onClick={onBestandSetzen}
              className="text-xs text-gray-300 hover:text-gray-500 transition-colors"
            >
              + Lagerstand
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onBearbeiten}
          className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors text-xs"
          title="Bearbeiten"
        >
          ✏️
        </button>
        <button
          onClick={onDeaktivieren}
          className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors text-xs"
          title={mod.aktiv ? 'Deaktivieren' : 'Aktivieren'}
        >
          {mod.aktiv ? '👁️' : '🚫'}
        </button>
        <button
          onClick={onLoeschen}
          className="p-1.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors text-xs"
          title="Löschen"
        >
          🗑️
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gruppen-Formular-Modal
// ---------------------------------------------------------------------------

function GruppeFormModal({
  open, editing, onClose, onSave, loading,
}: {
  open:    boolean
  editing: ModifikatorGruppe | null
  onClose: () => void
  onSave:  (input: ModifikatorGruppeErstellen | ModifikatorGruppeAktualisieren) => void
  loading: boolean
}) {
  const [name,       setName]       = useState('')
  const [typ,        setTyp]        = useState<'pflicht' | 'optional'>('optional')
  const [maxAuswahl, setMaxAuswahl] = useState<string>('')

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setTyp(editing?.typ ?? 'optional')
      setMaxAuswahl(editing?.maxAuswahl?.toString() ?? '')
    }
  }, [open, editing])

  const handleSave = () => {
    if (!name.trim()) return
    const max = maxAuswahl.trim() === '' ? null : parseInt(maxAuswahl, 10)
    onSave({
      name: name.trim(),
      typ,
      maxAuswahl: max && max > 0 ? max : null,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Gruppe bearbeiten: ${editing.name}` : 'Neue Gruppe'}
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="z. B. Größe, Sauce, Garstufe, Extras…"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Typ</label>
          <div className="grid grid-cols-2 gap-2">
            {(['optional', 'pflicht'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTyp(t)}
                className={`py-2.5 px-3 rounded-lg border-2 text-sm font-medium transition-colors ${
                  typ === t
                    ? t === 'pflicht'
                      ? 'border-red-500 bg-red-50 text-red-700'
                      : 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {t === 'pflicht' ? '✱ Pflicht' : '○ Optional'}
                <div className="text-[10px] font-normal mt-0.5 opacity-70">
                  {t === 'pflicht' ? 'Muss ausgewählt werden' : 'Kann übersprungen werden'}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Max. Auswahl <span className="text-gray-400 font-normal">(leer = unbegrenzt)</span>
          </label>
          <Input
            type="number"
            min={1}
            value={maxAuswahl}
            onChange={e => setMaxAuswahl(e.target.value)}
            placeholder="z. B. 1 für Radio-Buttons"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button onClick={handleSave} disabled={!name.trim()} loading={loading} className="flex-1">
            {editing ? 'Speichern' : 'Gruppe erstellen'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Modifikator-Formular-Modal
// ---------------------------------------------------------------------------

function ModifikatorFormModal({
  open, editing, gruppeName, onClose, onSave, loading,
}: {
  open:       boolean
  editing:    Modifikator | null
  gruppeName: string
  onClose:    () => void
  onSave:     (input: ModifikatorErstellen | ModifikatorAktualisieren) => void
  loading:    boolean
}) {
  const [name,          setName]          = useState('')
  const [aufschlagStr,  setAufschlagStr]  = useState('0.00')
  const [lagerstandStr, setLagerstandStr] = useState('')

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setAufschlagStr(editing ? (editing.aufschlagCent / 100).toFixed(2) : '0.00')
      setLagerstandStr(editing?.lagerstandMenge?.toString() ?? '')
    }
  }, [open, editing])

  const handleSave = () => {
    if (!name.trim()) return
    const aufschlagCent   = Math.round(parseFloat(aufschlagStr.replace(',', '.') || '0') * 100)
    const lagerstandMenge = lagerstandStr.trim() === '' ? null : parseInt(lagerstandStr, 10)
    onSave({
      name: name.trim(),
      aufschlagCent,
      lagerstandMenge,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Option bearbeiten` : `Option zu „${gruppeName}"`}
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Bezeichnung</label>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="z. B. Groß, Extra scharf, Ohne Zwiebeln…"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Preisaufschlag <span className="text-gray-400 font-normal">(0 = kostenlos, negativ = Rabatt)</span>
          </label>
          <div className="relative">
            <Input
              type="number"
              step="0.10"
              value={aufschlagStr}
              onChange={e => setAufschlagStr(e.target.value)}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">€</span>
          </div>
          {aufschlagStr && parseFloat(aufschlagStr.replace(',', '.')) !== 0 && (
            <p className="text-xs text-gray-500 mt-1">
              → {parseFloat(aufschlagStr.replace(',', '.')) > 0 ? '+' : ''}
              {aufschlagLabel(Math.round(parseFloat(aufschlagStr.replace(',', '.') || '0') * 100))}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Lagerstand <span className="text-gray-400 font-normal">(leer = kein Countdown)</span>
          </label>
          <Input
            type="number"
            min={0}
            value={lagerstandStr}
            onChange={e => setLagerstandStr(e.target.value)}
            placeholder="z. B. 20"
          />
          <p className="text-xs text-gray-400 mt-1">
            Bei 0 wird die Option als „Ausverkauft" angezeigt und kann nicht gewählt werden.
          </p>
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button onClick={handleSave} disabled={!name.trim()} loading={loading} className="flex-1">
            {editing ? 'Speichern' : 'Option hinzufügen'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Lagerstand-Modal (schnelles Setzen)
// ---------------------------------------------------------------------------

function LagerstandModal({
  mod, onClose, onSave, loading,
}: {
  mod:     Modifikator
  onClose: () => void
  onSave:  (menge: number | null) => void
  loading: boolean
}) {
  const [wert, setWert] = useState(mod.lagerstandMenge?.toString() ?? '')

  return (
    <Modal open={true} onClose={onClose} title={`Lagerstand: ${mod.name}`} size="sm">
      <div className="space-y-4">
        <Input
          type="number"
          min={0}
          value={wert}
          onChange={e => setWert(e.target.value)}
          placeholder="Menge eingeben…"
          autoFocus
        />
        <p className="text-xs text-gray-400">Leer lassen um den Lagerstand-Countdown zu deaktivieren.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button
            onClick={() => onSave(wert.trim() === '' ? null : parseInt(wert, 10))}
            loading={loading}
            className="flex-1"
          >
            Speichern
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Artikel-Zuweisung-Modal
// ---------------------------------------------------------------------------

function ArtikelZuweisungModal({
  gruppe, alleArtikel, zuweisungen, onClose,
}: {
  gruppe:      ModifikatorGruppe
  alleArtikel: Artikel[]
  zuweisungen: { artikelId: string; gruppeId: string }[]
  onClose:     () => void
}) {
  const qc = useQueryClient()
  const [suche, setSuche] = useState('')

  // Für jede Artikel: ist die Gruppe bereits zugewiesen?
  const [auswahl, setAuswahl] = useState<Set<string>>(() => {
    return new Set(
      zuweisungen.filter(z => z.gruppeId === gruppe.id).map(z => z.artikelId)
    )
  })

  const speichernMutation = useMutation({
    mutationFn: async () => {
      // Für jeden Artikel: setze seine Gruppen (add/remove diese Gruppe)
      // Effizienter: wir rufen für jeden geänderten Artikel die API auf.
      const vorher = new Set(
        zuweisungen.filter(z => z.gruppeId === gruppe.id).map(z => z.artikelId)
      )
      const zuFügen   = [...auswahl].filter(id => !vorher.has(id))
      const zuEntfernen = [...vorher].filter(id => !auswahl.has(id))

      const aufgaben = [
        ...zuFügen.map(async (artikelId) => {
          const aktuelleGruppen = await modifikatorApi.getGruppenFuerArtikel(artikelId)
          const aktuelleIds = aktuelleGruppen.map(g => g.id)
          if (!aktuelleIds.includes(gruppe.id)) {
            await modifikatorApi.setzeGruppenFuerArtikel(artikelId, {
              gruppenIds: [...aktuelleIds, gruppe.id],
            })
          }
        }),
        ...zuEntfernen.map(async (artikelId) => {
          const aktuelleGruppen = await modifikatorApi.getGruppenFuerArtikel(artikelId)
          const neueIds = aktuelleGruppen.map(g => g.id).filter(id => id !== gruppe.id)
          await modifikatorApi.setzeGruppenFuerArtikel(artikelId, { gruppenIds: neueIds })
        }),
      ]
      await Promise.all(aufgaben)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] })
      onClose()
    },
  })

  const aktiveArtikel = alleArtikel
    .filter(a => a.aktiv)
    .filter(a => !suche || a.bezeichnung.toLowerCase().includes(suche.toLowerCase()))

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Artikel für „${gruppe.name}"`}
      size="lg"
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Wähle die Artikel, bei denen diese Optionsgruppe angeboten werden soll.
        </p>

        <Input
          value={suche}
          onChange={e => setSuche(e.target.value)}
          placeholder="Artikel suchen…"
        />

        <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
          {aktiveArtikel.length === 0 ? (
            <p className="text-sm text-gray-400 p-4 text-center">Keine Artikel gefunden.</p>
          ) : (
            aktiveArtikel.map(a => {
              const ist = auswahl.has(a.id)
              return (
                <label
                  key={a.id}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={ist}
                    onChange={() => {
                      setAuswahl(prev => {
                        const next = new Set(prev)
                        ist ? next.delete(a.id) : next.add(a.id)
                        return next
                      })
                    }}
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-sm text-gray-800">{a.bezeichnung}</span>
                  <span className="ml-auto text-xs text-gray-400 font-mono">
                    {formatPreis(a.preisBruttoCent)}
                  </span>
                </label>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-sm text-gray-500">{auswahl.size} Artikel gewählt</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Abbrechen</Button>
            <Button onClick={() => speichernMutation.mutate()} loading={speichernMutation.isPending}>
              Speichern
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Leerer Zustand
// ---------------------------------------------------------------------------

function LeereZustand({ onNeu }: { onNeu: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
      <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center text-3xl">
        ⚙️
      </div>
      <div>
        <h2 className="text-base font-semibold text-gray-800">Noch keine Optionen-Gruppen</h2>
        <p className="text-sm text-gray-500 mt-1 max-w-sm">
          Erstelle Gruppen wie „Größe", „Sauce" oder „Extras" und weise sie Artikeln zu.
          Der Gast sieht sie dann beim Hinzufügen zum Bon.
        </p>
      </div>
      <Button onClick={onNeu}>Erste Gruppe erstellen</Button>
    </div>
  )
}
