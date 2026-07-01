/**
 * PosKonfigPage — POS-Konfiguration pro Kasse
 *
 * Tabs:
 *   1. Warengruppen  — Reihenfolge (Drag & Drop, global) + Sichtbarkeit pro Kasse
 *   2. Artikel       — Warengruppe wählen → Artikel-Reihenfolge (Drag & Drop, global)
 *   3. Favoriten     — Favoriten-Reihenfolge (Drag & Drop, global)
 *   4. Zahlungsarten — pro Kasse An/Aus
 */

import { useState, useCallback, useEffect } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
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
import type { Artikel, Kategorie, Startseite } from '@kassa/shared'
import { artikelApi, kategorieApi, posConfigApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'

type Tab = 'warengruppen' | 'artikel' | 'favoriten' | 'zahlungsarten'

const STARTSEITEN: { value: Startseite; label: string; beschreibung: string }[] = [
  { value: 'tische',          label: 'Tische',             beschreibung: 'Tischübersicht (Gastro)' },
  { value: 'kasse',           label: 'Kasse',              beschreibung: 'Artikel-Raster' },
  { value: 'kasse_favoriten', label: 'Kasse – Favoriten',  beschreibung: 'Favoriten-Tab direkt öffnen' },
  { value: 'dashboard',       label: 'Dashboard',          beschreibung: 'Tagesübersicht' },
]

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
  onMoveUp,
  onMoveDown,
  istErster,
  istLetzter,
}: {
  id: string
  children:   (handle: React.ReactNode) => React.ReactNode
  onMoveUp?:   () => void
  onMoveDown?: () => void
  istErster?:  boolean
  istLetzter?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex:  isDragging ? 10 : undefined,
  }

  // Bedien-Element: eindeutige ↑/↓-Tasten (immer sichtbar, auch Touch) +
  // Griff-Symbol als Hinweis, dass man die ganze Zeile auch ziehen kann.
  const pfeilKlasse = 'flex h-5 w-6 items-center justify-center rounded text-ink-muted hover:text-brand-600 hover:bg-panel-2 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-ink-muted'
  const handle = (
    <div className="flex items-center gap-0.5">
      {(onMoveUp || onMoveDown) && (
        <div className="flex flex-col">
          {/* onPointerDown stoppen, damit der Tastendruck keinen Drag startet */}
          <button type="button" aria-label="Nach oben" disabled={istErster}
            onPointerDown={e => e.stopPropagation()} onClick={onMoveUp} className={pfeilKlasse}>
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 5l5 7H5l5-7Z" /></svg>
          </button>
          <button type="button" aria-label="Nach unten" disabled={istLetzter}
            onPointerDown={e => e.stopPropagation()} onClick={onMoveDown} className={pfeilKlasse}>
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 15l-5-7h10l-5 7Z" /></svg>
          </button>
        </div>
      )}
      <span aria-hidden className="text-ink-subtle select-none">
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path d="M7 4a1.3 1.3 0 1 1 0 2.6A1.3 1.3 0 0 1 7 4Zm6 0a1.3 1.3 0 1 1 0 2.6A1.3 1.3 0 0 1 13 4ZM7 8.7a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm6 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6ZM7 13.4a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm6 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z" />
        </svg>
      </span>
    </div>
  )

  // Ganze Zeile ist zusätzlich der Drag-Handle (Aktivierungsschwelle an den Sensoren).
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="cursor-grab active:cursor-grabbing touch-none"
    >
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

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
        <p className="text-sm text-ink-muted">
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
            {items.map((k, i) => (
              <SortableItem key={k.id} id={k.id}
                onMoveUp={() => { setItems(prev => arrayMove(prev, i, i - 1)); setDirty(true) }}
                onMoveDown={() => { setItems(prev => arrayMove(prev, i, i + 1)); setDirty(true) }}
                istErster={i === 0} istLetzter={i === items.length - 1}>
                {(handle) => (
                  <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5 shadow-sm">
                    {handle}
                    <div
                      className="h-3 w-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: FARB_MAP[k.farbe] ?? '#9ca3af' }}
                    />
                    <span className="flex-1 text-sm font-medium text-ink">{k.name}</span>
                    {!k.aktiv && (
                      <span className="text-xs text-ink-subtle italic">inaktiv</span>
                    )}
                    {/* Toggle Sichtbarkeit pro Kasse */}
                    <button
                      onClick={() => toggleSichtbar(k.id)}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
                        sichtbar.has(k.id) ? 'bg-brand-500' : 'bg-panel-2'
                      }`}
                      title={sichtbar.has(k.id) ? 'In dieser Kasse sichtbar' : 'In dieser Kasse ausgeblendet'}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-panel shadow transition-transform ${
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

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
                : 'bg-panel-2 text-ink-muted hover:bg-panel-2'
            }`}
          >
            {k.name}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
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
        <div className="rounded-lg border-2 border-dashed border-line p-8 text-center text-sm text-ink-subtle">
          Keine Artikel in dieser Warengruppe.
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(a => a.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map((a, i) => (
              <SortableItem key={a.id} id={a.id}
                onMoveUp={() => { setItems(prev => arrayMove(prev, i, i - 1)); setDirty(true) }}
                onMoveDown={() => { setItems(prev => arrayMove(prev, i, i + 1)); setDirty(true) }}
                istErster={i === 0} istLetzter={i === items.length - 1}>
                {(handle) => (
                  <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5 shadow-sm">
                    {handle}
                    <span className="flex-1 text-sm font-medium text-ink">{a.bezeichnung}</span>
                    <span className="text-xs text-ink-subtle font-mono tabular-nums">
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const [items, setItems] = useState(() =>
    alleArtikel
      .filter(a => a.istFavorit && a.aktiv)
      .sort((a, b) => a.favoritenReihenfolge - b.favoritenReihenfolge)
  )
  const [dirty, setDirty] = useState(false)
  const [suche, setSuche] = useState('')

  // Externe Änderungen (neue/geänderte Artikel, anderswo gesetzte Favoriten)
  // übernehmen, sobald die Artikelliste neu geladen wurde — dabei die aktuelle
  // Bildschirm-Reihenfolge ERHALTEN (nur neue hinten anhängen, entfernte raus),
  // damit ein laufendes/ungespeichertes Umsortieren nicht zurückspringt.
  useEffect(() => {
    if (dirty) return
    const favs = alleArtikel.filter(a => a.istFavorit && a.aktiv)
    const favById = new Map(favs.map(a => [a.id, a]))
    setItems(prev => {
      const behalten = prev.filter(p => favById.has(p.id)).map(p => favById.get(p.id)!)
      const behaltenIds = new Set(behalten.map(k => k.id))
      const neue = favs
        .filter(a => !behaltenIds.has(a.id))
        .sort((a, b) => a.favoritenReihenfolge - b.favoritenReihenfolge)
      // Nur ersetzen, wenn sich der Bestand wirklich geändert hat (verhindert Render-Schleifen)
      if (behalten.length === prev.length && neue.length === 0) return prev
      return [...behalten, ...neue]
    })
  }, [alleArtikel, dirty])

  const preis = (c: number) => `€ ${(c / 100).toFixed(2).replace('.', ',')}`

  const reihenfolge = useMutation({
    mutationFn: (eintraege: { id: string; favoritenReihenfolge: number }[]) =>
      artikelApi.updateFavoritenReihenfolge(eintraege),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artikel'] }); setDirty(false) },
  })

  // Favorit setzen/entfernen (istFavorit-Flag am Artikel)
  const toggleFavorit = useMutation({
    mutationFn: (v: { id: string; istFavorit: boolean; favoritenReihenfolge?: number }) =>
      artikelApi.update(v.id, {
        istFavorit: v.istFavorit,
        ...(v.favoritenReihenfolge !== undefined && { favoritenReihenfolge: v.favoritenReihenfolge }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artikel'] }),
  })

  const hinzufuegen = (a: Artikel) => {
    if (items.some(i => i.id === a.id)) return
    const pos = items.length
    setItems(prev => [...prev, { ...a, istFavorit: true, favoritenReihenfolge: pos }])
    toggleFavorit.mutate({ id: a.id, istFavorit: true, favoritenReihenfolge: pos })
  }

  const entfernen = (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
    toggleFavorit.mutate({ id, istFavorit: false })
  }

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

  // Wählbare Artikel: aktiv und noch nicht Favorit, optional per Suche gefiltert
  const verfuegbar = alleArtikel
    .filter(a => a.aktiv && !items.some(i => i.id === a.id))
    .filter(a => a.bezeichnung.toLowerCase().includes(suche.trim().toLowerCase()))
    .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung))

  return (
    <div className="space-y-6">
      {/* Picker: Artikel zu Favoriten hinzufügen */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Artikel hinzufügen</h3>
        <input
          value={suche}
          onChange={e => setSuche(e.target.value)}
          placeholder="Artikel suchen…"
          className="w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {verfuegbar.length === 0 ? (
          <p className="text-xs text-ink-subtle py-2">
            {suche.trim() ? 'Kein passender Artikel.' : 'Alle aktiven Artikel sind bereits Favoriten.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto pr-1">
            {verfuegbar.map(a => (
              <button
                key={a.id}
                type="button"
                onClick={() => hinzufuegen(a)}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1.5 text-xs
                           text-ink hover:border-brand-400 hover:bg-brand-50 transition"
              >
                <span className="text-brand-500 font-bold">+</span>
                {a.bezeichnung}
                <span className="text-ink-subtle tabular-nums">{preis(a.preisBruttoCent)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Favoriten: Reihenfolge (Drag & Drop) + Entfernen */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">
            Favoriten <span className="font-normal text-ink-subtle">({items.length})</span>
          </h3>
          {dirty && (
            <Button
              onClick={() => reihenfolge.mutate(items.map((a, i) => ({ id: a.id, favoritenReihenfolge: i })))}
              loading={reihenfolge.isPending}>
              Reihenfolge speichern
            </Button>
          )}
        </div>

        {items.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-line p-8 text-center">
            <p className="text-sm text-ink-subtle">Noch keine Favoriten.</p>
            <p className="mt-1 text-xs text-ink-subtle">Oben Artikel auswählen, dann per Ziehen anordnen.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map(a => a.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {items.map((a, i) => (
                  <SortableItem key={a.id} id={a.id}
                    onMoveUp={() => { setItems(prev => arrayMove(prev, i, i - 1)); setDirty(true) }}
                    onMoveDown={() => { setItems(prev => arrayMove(prev, i, i + 1)); setDirty(true) }}
                    istErster={i === 0} istLetzter={i === items.length - 1}>
                    {(handle) => (
                      <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5 shadow-sm">
                        {handle}
                        <span className="text-amber-400">★</span>
                        <span className="flex-1 text-sm font-medium text-ink">{a.bezeichnung}</span>
                        <span className="text-xs text-ink-subtle font-mono tabular-nums">{preis(a.preisBruttoCent)}</span>
                        <button
                          type="button"
                          onClick={() => entfernen(a.id)}
                          title="Aus Favoriten entfernen"
                          className="text-ink-subtle hover:text-red-500 text-lg leading-none px-1"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
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
  const [artikelbilder, setArtikelbilder] = useState<boolean>(
    () => posQuery.data?.artikelbilderAktiv ?? true
  )
  const [startseite, setStartseite] = useState<Startseite>(
    () => posQuery.data?.startseite ?? 'tische'
  )

  // Sync wenn posQuery geladen (z.B. nach erstem Render)
  const posDataRef = posQuery.data
  useState(() => {
    if (posDataRef) {
      setErlaubte(new Set(posDataRef.erlaubteZahlungsarten))
      setArtikelbilder(posDataRef.artikelbilderAktiv)
      setStartseite(posDataRef.startseite)
    }
  })

  const zahlMut = useMutation({
    mutationFn: (arten: string[]) =>
      posConfigApi.update(kasseId, { erlaubteZahlungsarten: arten as ('bar' | 'karte' | 'sonstige')[] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  const bildMut = useMutation({
    mutationFn: (aktiv: boolean) =>
      posConfigApi.update(kasseId, { artikelbilderAktiv: aktiv }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  const startseiteMut = useMutation({
    mutationFn: (s: Startseite) =>
      posConfigApi.update(kasseId, { startseite: s }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  const toggleZahlung = (key: string) => {
    const next = new Set(erlaubte)
    if (next.has(key)) {
      if (next.size <= 1) return  // mindestens eine muss aktiv sein
      next.delete(key)
    } else {
      next.add(key)
    }
    setErlaubte(next)
    zahlMut.mutate([...next])
  }

  const toggleBilder = () => {
    const next = !artikelbilder
    setArtikelbilder(next)
    bildMut.mutate(next)
  }

  const handleStartseite = (s: Startseite) => {
    setStartseite(s)
    startseiteMut.mutate(s)
  }

  return (
    <div className="space-y-6 max-w-sm">
      {/* Zahlungsarten */}
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">
          Welche Zahlungsarten sind an dieser Kasse verfügbar?
          Mindestens eine muss aktiviert sein.
        </p>
        {ZAHLUNGSARTEN.map(({ key, label }) => (
          <label key={key} className="flex items-center gap-3 cursor-pointer rounded-xl border border-line bg-panel px-4 py-3 hover:bg-panel-2">
            <input
              type="checkbox"
              checked={erlaubte.has(key)}
              onChange={() => toggleZahlung(key)}
              className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm font-medium text-ink">{label}</span>
          </label>
        ))}
      </div>

      {/* Darstellung */}
      <div className="border-t border-line pt-5 space-y-3">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Darstellung</p>
        <label className="flex items-center gap-3 cursor-pointer rounded-xl border border-line bg-panel px-4 py-3 hover:bg-panel-2">
          <input
            type="checkbox"
            checked={artikelbilder}
            onChange={toggleBilder}
            className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
          />
          <div>
            <p className="text-sm font-medium text-ink">Artikelbilder anzeigen</p>
            <p className="text-xs text-ink-subtle mt-0.5">
              Fotos im Artikel-Raster einblenden. Deaktivieren für kompaktere Ansicht.
            </p>
          </div>
        </label>
      </div>

      {/* Startseite */}
      <div className="border-t border-line pt-5 space-y-3">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Startseite nach Login</p>
        <p className="text-sm text-ink-muted">
          Welche Seite wird nach dem Einloggen an dieser Kasse geöffnet?
        </p>
        {STARTSEITEN.map(({ value, label, beschreibung }) => (
          <label key={value} className="flex items-center gap-3 cursor-pointer rounded-xl border border-line bg-panel px-4 py-3 hover:bg-panel-2">
            <input
              type="radio"
              name="startseite"
              value={value}
              checked={startseite === value}
              onChange={() => handleStartseite(value)}
              className="h-4 w-4 border-line-strong text-brand-600 focus:ring-brand-500"
            />
            <div>
              <p className="text-sm font-medium text-ink">{label}</p>
              <p className="text-xs text-ink-subtle mt-0.5">{beschreibung}</p>
            </div>
          </label>
        ))}
      </div>
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
        <h1 className="text-2xl font-bold text-ink">POS-Konfiguration</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Sortierung und Darstellung im Kassensystem.
        </p>
      </div>

      {/* Tab-Navigation */}
      <div className="flex gap-1 rounded-xl bg-panel-2 p-1">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setAktuellerTab(t.key)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
              aktuellerTab === t.key
                ? 'bg-panel text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-subtle py-8 text-center">Laden…</div>
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
