/**
 * PosKonfigPage — POS-Konfiguration pro Kasse
 *
 * Tabs:
 *   1. Warengruppen  — Reihenfolge (Drag & Drop, global) + Sichtbarkeit pro Kasse
 *   2. Artikel       — Warengruppe wählen → Artikel-Reihenfolge (Drag & Drop, global)
 *   3. Favoriten     — Favoriten-Reihenfolge (Drag & Drop, global)
 *   4. Zahlungsarten — pro Kasse An/Aus
 */

import { useState, useCallback } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Artikel, Kategorie } from '@kassa/shared'
import { artikelApi, kategorieApi, posConfigApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'

type Tab = 'warengruppen' | 'artikel' | 'favoriten' | 'zahlungsarten'

const ZAHLUNGSARTEN = [
  { key: 'bar',      label: 'Barzahlung' },
  { key: 'karte',    label: 'Kartenzahlung' },
  { key: 'sonstige', label: 'Sonstige' },
] as const

// ---------------------------------------------------------------------------
// Sortierbare Zeile
// ---------------------------------------------------------------------------

function SortableItem({
  id,
  children,
}: {
  id: string
  children: (handle: React.ReactNode) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex:  isDragging ? 10 : undefined,
  }

  const handle = (
    <button
      {...attributes}
      {...listeners}
      className="cursor-grab active:cursor-grabbing p-1.5 text-gray-300 hover:text-gray-500 touch-none"
      aria-label="Verschieben"
    >
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM10 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM11.5 15.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0ZM4.5 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM4.5 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM6 15.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0ZM15.5 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM15.5 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM17 15.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" />
      </svg>
    </button>
  )

  return (
    <div ref={setNodeRef} style={style}>
      {children(handle)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 1: Warengruppen-Reihenfolge + Kassen-Sichtbarkeit
// ---------------------------------------------------------------------------

function TabWarengruppen({
  kategorien,
  kasseId,
}: {
  kategorien: Kategorie[]
  kasseId:    string
}) {
  const qc = useQueryClient()
  const [items, setItems] = useState(() =>
    [...kategorien].sort((a, b) => a.reihenfolge - b.reihenfolge)
  )
  const [dirty, setDirty] = useState(false)

  // Sichtbarkeit aus POS-Config
  const posQuery = useQuery({
    queryKey: ['pos-config', kasseId],
    queryFn:  () => posConfigApi.get(kasseId),
  })
  const [sichtbar, setSichtbar] = useState<Set<string>>(
    () => new Set(posQuery.data?.sichtbareKategorieIds ?? [])
  )
  // Sync wenn posQuery geladen
  useState(() => {
    if (posQuery.data) setSichtbar(new Set(posQuery.data.sichtbareKategorieIds))
  })

  const sensors = useSensors(useSensor(PointerSensor))

  const reihenfolge = useMutation({
    mutationFn: (eintraege: { id: string; reihenfolge: number }[]) =>
      kategorieApi.updateReihenfolge(eintraege),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kategorien'] }); setDirty(false) },
  })

  const sichtbarkeitMut = useMutation({
    mutationFn: (ids: string[]) =>
      posConfigApi.update(kasseId, { sichtbareKategorieIds: ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setItems(prev => {
      const oldIdx = prev.findIndex(i => i.id === active.id)
      const newIdx = prev.findIndex(i => i.id === over.id)
      return arrayMove(prev, oldIdx, newIdx)
    })
    setDirty(true)
  }

  const saveReihenfolge = () => {
    reihenfolge.mutate(items.map((k, i) => ({ id: k.id, reihenfolge: i })))
  }

  const toggleSichtbar = (id: string) => {
    const next = new Set(sichtbar)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSichtbar(next)
    sichtbarkeitMut.mutate([...next])
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Reihenfolge per Drag&nbsp;&amp;&nbsp;Drop anpassen (gilt für alle Kassen).
          Sichtbarkeit ist pro Kasse einstellbar.
        </p>
        {dirty && (
          <Button onClick={saveReihenfolge} loading={reihenfolge.isPending}>
            Reihenfolge speichern
          </Button>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(k => k.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map(k => (
              <SortableItem key={k.id} id={k.id}>
                {(handle) => (
                  <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
                    {handle}
                    <div
                      className="h-3 w-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: FARB_MAP[k.farbe] ?? '#9ca3af' }}
                    />
                    <span className="flex-1 text-sm font-medium text-gray-800">{k.name}</span>
                    {!k.aktiv && (
                      <span className="text-xs text-gray-400 italic">inaktiv</span>
                    )}
                    {/* Toggle Sichtbarkeit pro Kasse */}
                    <button
                      onClick={() => toggleSichtbar(k.id)}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
                        sichtbar.has(k.id) ? 'bg-brand-500' : 'bg-gray-200'
                      }`}
                      title={sichtbar.has(k.id) ? 'In dieser Kasse sichtbar' : 'In dieser Kasse ausgeblendet'}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                        sichtbar.has(k.id) ? 'translate-x-4' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                )}
              </SortableItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 2: Artikel-Reihenfolge pro Warengruppe
// ---------------------------------------------------------------------------

function TabArtikel({ kategorien, alleArtikel }: { kategorien: Kategorie[]; alleArtikel: Artikel[] }) {
  const qc = useQueryClient()
  const [gewaehlteKatId, setGewaehlteKatId] = useState(kategorien[0]?.id ?? '')
  const sensors = useSensors(useSensor(PointerSensor))

  const artikelDerKat = alleArtikel
    .filter(a => a.kategorieId === gewaehlteKatId)
    .sort((a, b) => a.reihenfolge - b.reihenfolge)

  const [items, setItems] = useState(artikelDerKat)
  const [dirty, setDirty] = useState(false)

  // Wenn Kategorie wechselt → neu sortieren
  const handleKatWechsel = useCallback((katId: string) => {
    setGewaehlteKatId(katId)
    setItems(
      alleArtikel
        .filter(a => a.kategorieId === katId)
        .sort((a, b) => a.reihenfolge - b.reihenfolge)
    )
    setDirty(false)
  }, [alleArtikel])

  const reihenfolge = useMutation({
    mutationFn: (eintraege: { id: string; reihenfolge: number }[]) =>
      artikelApi.updateReihenfolge(eintraege),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artikel'] }); setDirty(false) },
  })

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setItems(prev => {
      const oldIdx = prev.findIndex(i => i.id === active.id)
      const newIdx = prev.findIndex(i => i.id === over.id)
      return arrayMove(prev, oldIdx, newIdx)
    })
    setDirty(true)
  }

  return (
    <div className="space-y-4">
      {/* Kategorie-Auswahl */}
      <div className="flex gap-2 flex-wrap">
        {kategorien.filter(k => k.aktiv).sort((a, b) => a.reihenfolge - b.reihenfolge).map(k => (
          <button
            key={k.id}
            onClick={() => handleKatWechsel(k.id)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
              gewaehlteKatId === k.id
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {k.name}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {items.length} Artikel in dieser Warengruppe.
        </p>
        {dirty && (
          <Button onClick={() => reihenfolge.mutate(items.map((a, i) => ({ id: a.id, reihenfolge: i })))}
            loading={reihenfolge.isPending}>
            Reihenfolge speichern
          </Button>
        )}
      </div>

      {items.length === 0 && (
        <div className="rounded-lg border-2 border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
          Keine Artikel in dieser Warengruppe.
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(a => a.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map(a => (
              <SortableItem key={a.id} id={a.id}>
                {(handle) => (
                  <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
                    {handle}
                    <span className="flex-1 text-sm font-medium text-gray-800">{a.bezeichnung}</span>
                    <span className="text-xs text-gray-400 font-mono tabular-nums">
                      € {(a.preisBruttoCent / 100).toFixed(2).replace('.', ',')}
                    </span>
                    {a.istFavorit && (
                      <span className="text-amber-400" title="Favorit">★</span>
                    )}
                  </div>
                )}
              </SortableItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 3: Favoriten-Reihenfolge
// ---------------------------------------------------------------------------

function TabFavoriten({ alleArtikel }: { alleArtikel: Artikel[] }) {
  const qc = useQueryClient()
  const sensors = useSensors(useSensor(PointerSensor))

  const [items, setItems] = useState(() =>
    alleArtikel
      .filter(a => a.istFavorit && a.aktiv)
      .sort((a, b) => a.favoritenReihenfolge - b.favoritenReihenfolge)
  )
  const [dirty, setDirty] = useState(false)

  const reihenfolge = useMutation({
    mutationFn: (eintraege: { id: string; favoritenReihenfolge: number }[]) =>
      artikelApi.updateFavoritenReihenfolge(eintraege),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artikel'] }); setDirty(false) },
  })

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setItems(prev => {
      const oldIdx = prev.findIndex(i => i.id === active.id)
      const newIdx = prev.findIndex(i => i.id === over.id)
      return arrayMove(prev, oldIdx, newIdx)
    })
    setDirty(true)
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-200 p-12 text-center">
        <p className="text-sm text-gray-400">Noch keine Favoriten markiert.</p>
        <p className="mt-1 text-xs text-gray-300">
          Aktiviere das Favoriten-Flag bei Artikeln in der Artikel-Verwaltung.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{items.length} Favoriten.</p>
        {dirty && (
          <Button
            onClick={() => reihenfolge.mutate(items.map((a, i) => ({ id: a.id, favoritenReihenfolge: i })))}
            loading={reihenfolge.isPending}>
            Reihenfolge speichern
          </Button>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(a => a.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map(a => (
              <SortableItem key={a.id} id={a.id}>
                {(handle) => (
                  <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
                    {handle}
                    <span className="text-amber-400">★</span>
                    <span className="flex-1 text-sm font-medium text-gray-800">{a.bezeichnung}</span>
                    <span className="text-xs text-gray-400 font-mono tabular-nums">
                      € {(a.preisBruttoCent / 100).toFixed(2).replace('.', ',')}
                    </span>
                  </div>
                )}
              </SortableItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 4: Zahlungsarten
// ---------------------------------------------------------------------------

function TabZahlungsarten({ kasseId }: { kasseId: string }) {
  const qc = useQueryClient()
  const posQuery = useQuery({
    queryKey: ['pos-config', kasseId],
    queryFn:  () => posConfigApi.get(kasseId),
  })

  const [erlaubte, setErlaubte] = useState<Set<string>>(
    () => new Set(posQuery.data?.erlaubteZahlungsarten ?? ['bar', 'karte', 'sonstige'])
  )

  const mut = useMutation({
    mutationFn: (arten: string[]) =>
      posConfigApi.update(kasseId, { erlaubteZahlungsarten: arten as ('bar' | 'karte' | 'sonstige')[] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  const toggle = (key: string) => {
    const next = new Set(erlaubte)
    if (next.has(key)) {
      if (next.size <= 1) return  // mindestens eine muss aktiv sein
      next.delete(key)
    } else {
      next.add(key)
    }
    setErlaubte(next)
    mut.mutate([...next])
  }

  return (
    <div className="space-y-3 max-w-sm">
      <p className="text-sm text-gray-500 mb-4">
        Welche Zahlungsarten sind an dieser Kasse verfügbar?
        Mindestens eine muss aktiviert sein.
      </p>
      {ZAHLUNGSARTEN.map(({ key, label }) => (
        <label key={key} className="flex items-center gap-3 cursor-pointer rounded-xl border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50">
          <input
            type="checkbox"
            checked={erlaubte.has(key)}
            onChange={() => toggle(key)}
            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-gray-800">{label}</span>
        </label>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

const FARB_MAP: Record<string, string> = {
  grau:   '#9ca3af',
  rot:    '#ef4444',
  orange: '#f97316',
  gelb:   '#eab308',
  gruen:  '#22c55e',
  blau:   '#3b82f6',
  lila:   '#a855f7',
  pink:   '#ec4899',
}

export function PosKonfigPage() {
  const identity = getKasseIdentity()!
  const [aktuellerTab, setAktuellerTab] = useState<Tab>('warengruppen')

  const kategorienQuery = useQuery({
    queryKey: ['kategorien'],
    queryFn:  () => kategorieApi.list(false),
  })

  const artikelQuery = useQuery({
    queryKey: ['artikel', identity.mandantId, false],
    queryFn:  () => artikelApi.list(identity.mandantId, false),
  })

  const tabs: { key: Tab; label: string }[] = [
    { key: 'warengruppen',  label: 'Warengruppen' },
    { key: 'artikel',       label: 'Artikel' },
    { key: 'favoriten',     label: 'Favoriten' },
    { key: 'zahlungsarten', label: 'Zahlungsarten' },
  ]

  const kategorien  = kategorienQuery.data ?? []
  const alleArtikel = artikelQuery.data    ?? []
  const isLoading   = kategorienQuery.isLoading || artikelQuery.isLoading

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">POS-Konfiguration</h1>
        <p className="mt-1 text-sm text-gray-500">
          Sortierung und Darstellung im Kassensystem.
        </p>
      </div>

      {/* Tab-Navigation */}
      <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setAktuellerTab(t.key)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
              aktuellerTab === t.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Laden…</div>
      ) : (
        <div>
          {aktuellerTab === 'warengruppen' && (
            <TabWarengruppen kategorien={kategorien} kasseId={identity.kasseId} />
          )}
          {aktuellerTab === 'artikel' && (
            <TabArtikel kategorien={kategorien} alleArtikel={alleArtikel} />
          )}
          {aktuellerTab === 'favoriten' && (
            <TabFavoriten alleArtikel={alleArtikel} />
          )}
          {aktuellerTab === 'zahlungsarten' && (
            <TabZahlungsarten kasseId={identity.kasseId} />
          )}
        </div>
      )}
    </div>
  )
}
