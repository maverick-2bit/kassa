/**
 * PosKonfigPage — POS-Konfiguration pro Kasse
 *
 * Tabs:
 *   1. Warengruppen  — Baum mit Reihenfolge UNTER GESCHWISTERN (Drag & Drop / ↑↓, global) + Sichtbarkeit pro Kasse
 *   2. Artikel       — Kachel-Anordnung je Kasse + Warengruppe (Raster in der Spaltenzahl der Kasse, Lücken,
 *                      Ausblenden) bzw. Standard-Layout für alle Kassen — components/ArtikelAnordnungTab
 *   3. Favoriten     — Favoritenliste je Kasse (Kachel-Editor mit Platzhaltern)
 *   4. Zahlungsarten — pro Kasse An/Aus
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  DndContext,
  closestCenter,
  type CollisionDetection,
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
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { farbeZuHex, type Artikel, type Kategorie, type Startseite, type KellnerTischwahl, type KellnerModus } from '@kassa/shared'
import { artikelApi, kategorieApi, posConfigApi, bonierdruckerApi, tischplanApi, kasseApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'
import { ArtikelAnordnungTab, UngespeichertHinweis } from '../components/ArtikelAnordnungTab'
import { baumFlach, erweitereSichtbarkeit, kategorieAnzeigeNamen, kategoriePfad } from '../lib/kategorie-baum'
import { alleAktiv, sichtbarkeitsZustaende, toggle as toggleSichtbarkeit, waehleNur, type SichtbarkeitsZustand } from '../lib/sichtbarkeit'
import {
  elternSchluessel, geschwisterIds, reihenfolgeEintraege, verschiebeUnterGeschwistern, ziehUnterGeschwistern,
} from '../lib/kategorie-reihenfolge'

type Tab = 'warengruppen' | 'artikel' | 'favoriten' | 'zahlungsarten' | 'kellner'

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
// Bedien-Element einer sortierbaren Zeile: ↑/↓-Tasten + Griff-Symbol
// ---------------------------------------------------------------------------

/**
 * Eindeutige ↑/↓-Tasten (immer sichtbar, auch Touch) + Griff-Symbol als Hinweis, dass man die
 * Zeile auch ziehen kann.
 */
function Griff({
  onMoveUp, onMoveDown, istErster, istLetzter,
}: {
  onMoveUp?: (() => void) | undefined; onMoveDown?: (() => void) | undefined
  istErster?: boolean | undefined; istLetzter?: boolean | undefined
}) {
  const pfeilKlasse = 'flex h-5 w-6 items-center justify-center rounded text-ink-muted hover:text-brand-600 hover:bg-panel-2 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-ink-muted'
  return (
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
}

// ---------------------------------------------------------------------------
// Tab 1: Warengruppen — Baum, Reihenfolge unter Geschwistern + Kassen-Sichtbarkeit
// ---------------------------------------------------------------------------

/** Kollisionen nur unter Geschwistern: gezogen wird innerhalb derselben Elterngruppe, nie über Elterngruppen hinweg. */
const nurGeschwister: CollisionDetection = (args) => {
  const container = args.active.data.current?.sortable?.containerId
  const kandidaten = args.droppableContainers.filter(c => c.data.current?.sortable?.containerId === container)
  return closestCenter({ ...args, droppableContainers: kandidaten })
}

/** Block einer Warengruppe im Baum: Zeile (hier wird gezogen) + ihre Untergruppen — der ganze Teilbaum wandert mit. */
function BaumBlock({
  id, zeile, kinder,
}: {
  id:     string
  zeile:  (griff: React.ReactNode) => React.ReactNode
  kinder: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex:  isDragging ? 10 : undefined,
  }
  return (
    <div ref={setNodeRef} style={style} data-testid="wg-block">
      <div ref={setActivatorNodeRef} {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing touch-none">
        {zeile(null)}
      </div>
      {kinder}
    </div>
  )
}

/** Schalter „an dieser Kasse sichtbar" mit Halbzustand (nur einzelne Untergruppen sichtbar). */
function SichtbarkeitsSchalter({
  zustand, onClick, label, title,
}: {
  zustand: SichtbarkeitsZustand
  onClick: () => void
  label:   string
  title:   string
}) {
  const an = zustand === 'an'
  const teilweise = zustand === 'teilweise'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={teilweise ? 'mixed' : an}
      aria-label={label}
      data-zustand={zustand}
      onPointerDown={e => e.stopPropagation()}
      onClick={onClick}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors ${
        an ? 'bg-brand-500' : teilweise ? 'bg-brand-300' : 'bg-panel-2'
      }`}
      title={title}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-panel shadow transition-transform ${
        an ? 'translate-x-4' : teilweise ? 'translate-x-2' : 'translate-x-0'
      }`} />
    </button>
  )
}

function TabWarengruppen({
  kategorien,
  kasseId,
}: {
  kategorien: Kategorie[]
  kasseId:    string
}) {
  const qc = useQueryClient()
  // Lokale Kopie mit noch nicht gespeicherten Reihenfolge-Änderungen. `reihenfolge` bleibt dabei IMMER die
  // Position unter Geschwistern — geschrieben wird nur für die veränderten Geschwistermengen.
  const [items, setItems] = useState<Kategorie[]>(kategorien)
  const [geaenderteEltern, setGeaenderteEltern] = useState<Set<string>>(() => new Set())
  const dirty = geaenderteEltern.size > 0
  // Neuen Serverstand übernehmen (neue/umbenannte Gruppen, nach dem Speichern) — nie über ungespeicherte Änderungen
  useEffect(() => { if (!dirty) setItems(kategorien) }, [kategorien]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sichtbarkeit aus POS-Config
  const posQuery = useQuery({
    queryKey: ['pos-config', kasseId],
    queryFn:  () => posConfigApi.get(kasseId),
  })
  const [sichtbar, setSichtbar] = useState<string[]>(() => posQuery.data?.sichtbareKategorieIds ?? [])
  // Serverstand übernehmen, sobald (oder wann immer) er eintrifft — der frühere
  // useState-Trick lief nur beim Mount und verpasste später geladene Daten.
  useEffect(() => {
    if (posQuery.data) setSichtbar(posQuery.data.sichtbareKategorieIds)
  }, [posQuery.data])
  const [hinweis, setHinweis] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const reihenfolge = useMutation({
    mutationFn: (eintraege: { id: string; reihenfolge: number }[]) =>
      kategorieApi.updateReihenfolge(eintraege),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kategorien'] }); setGeaenderteEltern(new Set()) },
  })

  const sichtbarkeitMut = useMutation({
    mutationFn: (ids: string[]) =>
      posConfigApi.update(kasseId, { sichtbareKategorieIds: ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  // Verschieben/Ziehen gilt nur INNERHALB der Geschwister (gleiche Elterngruppe)
  const aenderung = (neu: readonly Kategorie[], betroffeneId: string) => {
    if (neu === items) return
    setGeaenderteEltern(prev => new Set(prev).add(elternSchluessel(items, betroffeneId)))
    setItems([...neu])
  }
  const verschiebe = (id: string, delta: number) => aenderung(verschiebeUnterGeschwistern(items, id, delta), id)

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    aenderung(ziehUnterGeschwistern(items, String(active.id), String(over.id)), String(active.id))
  }

  const saveReihenfolge = () => {
    reihenfolge.mutate(reihenfolgeEintraege(items, geaenderteEltern))
  }

  // Server-Semantik: LEERE Liste = alle Warengruppen sichtbar (auch künftige) — dann stehen alle
  // Schalter auf „an". „Keine" ist darin nicht speicherbar (und null sichtbare Gruppen wären an
  // einer Kasse sinnlos) → keineModus ist ein reiner Auswahl-Neustart in der
  // Oberfläche: alles aus, gespeichert wird erst die erste wieder
  // eingeschaltete Gruppe. Abbruch/Kassenwechsel lässt den Serverstand unberührt.
  // Die Sichtbarkeitslogik (Teilbaum, Halbzustand, letzte Gruppe bleibt) steht in lib/sichtbarkeit —
  // gemeinsam mit der Matrix in den Einstellungen.
  const [keineModus, setKeineModus] = useState(false)
  const alleAktivJetzt = !keineModus && alleAktiv(sichtbar)
  const zustaende = useMemo(
    () => keineModus ? new Map<string, SichtbarkeitsZustand>(kategorien.map(k => [k.id, 'aus'] as const)) : sichtbarkeitsZustaende(kategorien, sichtbar),
    [kategorien, sichtbar, keineModus],
  )
  const zustandVon = (id: string): SichtbarkeitsZustand => zustaende.get(id) ?? 'aus'
  const istSichtbar = (id: string) => zustandVon(id) !== 'aus'
  const baum = useMemo(() => baumFlach(kategorien), [kategorien])
  const anzeigeName = useMemo(() => kategorieAnzeigeNamen(kategorien), [kategorien])

  const alleAktivieren = () => {
    setKeineModus(false)
    setHinweis(null)
    setSichtbar([])
    sichtbarkeitMut.mutate([])
  }

  const keineAktivieren = () => { setHinweis(null); setKeineModus(true) }

  // Start-Reiter der Artikelwahl (Kasse, Tisch, Kellner-App)
  const startMut = useMutation({
    mutationFn: (wert: { startFavoriten: boolean; startKategorieId: string | null }) =>
      posConfigApi.update(kasseId, wert),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })
  const startWert = !posQuery.data || posQuery.data.startFavoriten
    ? 'favoriten'
    : (posQuery.data.startKategorieId ?? 'erste')
  const startAendern = (wert: string) => startMut.mutate(
    wert === 'favoriten' ? { startFavoriten: true,  startKategorieId: null }
    : wert === 'erste'   ? { startFavoriten: false, startKategorieId: null }
    :                      { startFavoriten: false, startKategorieId: wert },
  )
  const startGruppeAusgeblendet = startWert !== 'favoriten' && startWert !== 'erste'
    && (!kategorien.some(k => k.id === startWert && k.aktiv) || !istSichtbar(startWert))

  const toggleSichtbar = (id: string) => {
    setHinweis(null)
    if (keineModus) {
      // Erste Gruppe nach dem Neustart → wird die neue (gespeicherte) Auswahl
      setKeineModus(false)
      const next = waehleNur(kategorien, id)
      setSichtbar(next)
      sichtbarkeitMut.mutate(next)
      return
    }
    const ergebnis = toggleSichtbarkeit(kategorien, sichtbar, id)
    if (ergebnis.blockiert === 'letzte') {
      setHinweis('Mindestens eine Warengruppe muss an dieser Kasse sichtbar bleiben.')
      return
    }
    setSichtbar(ergebnis.liste)
    sichtbarkeitMut.mutate(ergebnis.liste)
  }

  /** Geschwistermenge als sortierbare Liste; jeder Block trägt seine Untergruppen. */
  const geschwister = (eltern: string | null, tiefe: number): React.ReactNode => {
    const ids = eltern === null
      ? baum.filter(e => e.tiefe === 0).map(e => e.kategorie.id)
      : baum.filter(e => items.find(k => k.id === e.kategorie.id)?.parentId === eltern).map(e => e.kategorie.id)
    // Reihenfolge der Geschwister kommt aus den lokalen `items` (inkl. ungespeicherter Änderungen)
    const sortiert = ids
      .map(id => items.find(k => k.id === id)!)
      .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
    if (sortiert.length === 0) return null
    return (
      <SortableContext id={eltern ?? 'wurzel'} items={sortiert.map(k => k.id)} strategy={verticalListSortingStrategy}>
        <div className={tiefe === 0 ? 'space-y-2' : 'mt-2 ml-5 space-y-2 border-l border-line pl-3'}>
          {sortiert.map((k, i) => {
            const pfad = kategoriePfad(items, k.id)
            const zustand = zustandVon(k.id)
            return (
              <BaumBlock
                key={k.id}
                id={k.id}
                zeile={() => (
                  <div
                    data-testid="wg-zeile"
                    data-pfad={pfad}
                    data-tiefe={tiefe}
                    data-zustand={zustand}
                    title={pfad}
                    className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5 shadow-sm"
                  >
                    <Griff
                      onMoveUp={() => verschiebe(k.id, -1)}
                      onMoveDown={() => verschiebe(k.id, +1)}
                      istErster={i === 0}
                      istLetzter={i === sortiert.length - 1}
                    />
                    <div
                      className="h-3 w-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: farbeZuHex(k.farbe) ?? '#9ca3af' }}
                    />
                    <span className="flex-1 text-sm font-medium text-ink">{k.name}</span>
                    {!k.aktiv && (
                      <span className="text-xs text-ink-subtle italic">inaktiv</span>
                    )}
                    {/* Schalter Sichtbarkeit pro Kasse — gilt samt Untergruppen */}
                    <SichtbarkeitsSchalter
                      zustand={zustand}
                      onClick={() => toggleSichtbar(k.id)}
                      label={`${anzeigeName(k.id)} an dieser Kasse sichtbar`}
                      title={zustand === 'an' ? 'In dieser Kasse sichtbar (samt Untergruppen)'
                        : zustand === 'teilweise' ? 'Teilweise: nur einzelne Untergruppen sind sichtbar — diese Gruppe bleibt als Zugang sichtbar'
                        : 'In dieser Kasse ausgeblendet'}
                    />
                  </div>
                )}
                kinder={geschwister(k.id, tiefe + 1)}
              />
            )
          })}
        </div>
      </SortableContext>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          Reihenfolge per Drag&nbsp;&amp;&nbsp;Drop oder ↑/↓ anpassen — nur innerhalb derselben
          Elterngruppe (gilt für alle Kassen). Sichtbarkeit ist pro Kasse einstellbar: Ein Schalter
          gilt für die Gruppe <strong>samt Untergruppen</strong>; „teilweise" heißt, nur einzelne
          Untergruppen sind sichtbar (die Gruppe bleibt dann als Zugang sichtbar).
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={alleAktivieren}
            disabled={alleAktivJetzt || sichtbarkeitMut.isPending}
            title="Alle Warengruppen an dieser Kasse sichtbar machen — auch künftig angelegte"
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:border-brand-400 hover:text-brand-700 transition disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted"
          >
            {alleAktivJetzt ? '✓ Alle sichtbar' : 'Alle sichtbar'}
          </button>
          <button
            onClick={keineAktivieren}
            disabled={keineModus || sichtbarkeitMut.isPending}
            title="Auswahl neu beginnen: alles aus — die erste wieder eingeschaltete Warengruppe legt die neue Auswahl fest"
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:border-brand-400 hover:text-brand-700 transition disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted"
          >
            Keine
          </button>
          {dirty && (
            <Button onClick={saveReihenfolge} loading={reihenfolge.isPending}>
              Reihenfolge speichern
            </Button>
          )}
        </div>
      </div>

      {keineModus && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Noch nichts gespeichert — die erste Warengruppe, die du jetzt einschaltest, legt die
          neue Auswahl fest (mindestens eine muss sichtbar sein). Solange gilt die bisherige Auswahl weiter.
        </p>
      )}

      {hinweis && (
        <p role="status" data-testid="wg-hinweis" className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {hinweis}
        </p>
      )}

      <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 space-y-1">
        <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <span className="font-medium">Artikelwahl öffnet mit</span>
          <select
            value={startWert}
            onChange={e => startAendern(e.target.value)}
            disabled={!posQuery.data || startMut.isPending}
            aria-label="Artikelwahl öffnet mit"
            className="rounded-md border border-line-strong bg-panel px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="favoriten">⭐ Favoriten</option>
            <option value="erste">Erste Warengruppe</option>
            {baum.filter(e => e.kategorie.aktiv && istSichtbar(e.kategorie.id)).map(({ kategorie: k }) => (
              <option key={k.id} value={k.id}>{kategoriePfad(kategorien, k.id)}</option>
            ))}
            {startGruppeAusgeblendet && (
              <option value={startWert}>
                {kategoriePfad(kategorien, startWert) || 'Unbekannte Warengruppe'} (ausgeblendet)
              </option>
            )}
          </select>
        </label>
        <p className="text-xs text-ink-subtle">
          Gilt an dieser Kasse für Direktverkauf, Tische und die Kellner-App. Gibt es keine Favoriten
          (bzw. ist die Warengruppe ausgeblendet), öffnet die erste Warengruppe mit Artikeln.
          {startGruppeAusgeblendet && ' Die gewählte Warengruppe ist an dieser Kasse gerade ausgeblendet.'}
        </p>
      </div>

      <DndContext sensors={sensors} collisionDetection={nurGeschwister} onDragEnd={handleDragEnd}>
        {geschwister(null, 0)}
      </DndContext>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 3: Favoriten je Kasse — Kachel-Editor in der Kassen-Ansicht
// ---------------------------------------------------------------------------

/** Ein Eintrag im Favoriten-Editor; artikel null = Platzhalter (graue Kachel). */
type FavoritEintrag = { key: string; artikel: Artikel | null }

/** Sortierbare Raster-Kachel (ganze Kachel = Drag-Handle). */
function SortableKachel({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex:  isDragging ? 10 : undefined,
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}
      className="relative cursor-grab active:cursor-grabbing touch-none">
      {children}
    </div>
  )
}

function TabFavoriten({ alleArtikel, kategorien, kasseId }: {
  alleArtikel: Artikel[]
  kategorien:  Kategorie[]
  kasseId:     string
}) {
  const qc = useQueryClient()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const posQuery = useQuery({
    queryKey: ['pos-config', kasseId],
    queryFn:  () => posConfigApi.get(kasseId),
  })
  const favQuery = useQuery({
    queryKey: ['kasse-favoriten', kasseId],
    queryFn:  () => posConfigApi.favoriten(kasseId),
  })

  const artikelProZeile = posQuery.data?.artikelProZeile ?? 4
  // Wie an der Kasse: Untergruppen einer sichtbaren Gruppe sind sichtbar, Vorfahren einer sichtbaren Untergruppe auch
  const sichtbareKatIds = useMemo(
    () => erweitereSichtbarkeit(kategorien, posQuery.data?.sichtbareKategorieIds ?? []) ?? [],
    [kategorien, posQuery.data],
  )
  const artikelbilder   = posQuery.data?.artikelbilderAktiv ?? true
  const farbeProKategorie = useMemo(
    () => new Map(kategorien.map(k => [k.id, k.farbe] as const)),
    [kategorien],
  )

  // Nur Artikel aus Warengruppen, die an DIESER Kasse sichtbar sind (leer = alle)
  const kategorieSichtbar = (a: Artikel) =>
    sichtbareKatIds.length === 0 || (a.kategorieId !== null && sichtbareKatIds.includes(a.kategorieId))

  // Editor-Zustand: null = wartet noch auf Kassen-Liste + Konfiguration
  const [items, setItems] = useState<FavoritEintrag[] | null>(null)
  const [dirty, setDirty] = useState(false)
  const [suche, setSuche] = useState('')
  const phZaehler = useRef(0)

  // Initial befüllen, sobald beide Queries da sind: Kassen-Liste geht vor;
  // ohne eigene Liste die globalen ★-Favoriten als Startvorschlag.
  useEffect(() => {
    if (items !== null || !favQuery.data || !posQuery.data) return
    const katIds = erweitereSichtbarkeit(kategorien, posQuery.data.sichtbareKategorieIds) ?? []
    const sichtbar = (a: Artikel) =>
      katIds.length === 0 || (a.kategorieId !== null && katIds.includes(a.kategorieId))
    const byId = new Map(alleArtikel.map(a => [a.id, a] as const))
    const kassenListe: FavoritEintrag[] = []
    for (const e of favQuery.data.eintraege) {
      if (e.artikelId === null) {
        kassenListe.push({ key: `ph-${phZaehler.current++}`, artikel: null })
      } else {
        const a = byId.get(e.artikelId)
        if (a) kassenListe.push({ key: a.id, artikel: a })
      }
    }
    if (kassenListe.length > 0) { setItems(kassenListe); return }
    const global = alleArtikel
      .filter(a => a.istFavorit && a.aktiv && sichtbar(a))
      .sort((a, b) => a.favoritenReihenfolge - b.favoritenReihenfolge || a.bezeichnung.localeCompare(b.bezeichnung))
    setItems(global.map(a => ({ key: a.id, artikel: a })))
  }, [items, favQuery.data, posQuery.data, alleArtikel, kategorien])

  const preis = (c: number) => `€ ${(c / 100).toFixed(2).replace('.', ',')}`

  const speichern = useMutation({
    mutationFn: (eintraege: { artikelId: string | null }[]) =>
      posConfigApi.favoritenSpeichern(kasseId, eintraege),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kasse-favoriten', kasseId] })
      setDirty(false)
    },
  })

  // „Artikel je Zeile" — gemeinsame Raster-Einstellung für Kasse + Kellner-App
  const spalten = useMutation({
    mutationFn: (n: number) => posConfigApi.update(kasseId, { artikelProZeile: n }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  const hinzufuegen = (a: Artikel) => {
    setItems(prev => (prev ?? []).some(i => i.artikel?.id === a.id) ? prev : [...(prev ?? []), { key: a.id, artikel: a }])
    setDirty(true)
  }

  const platzhalterHinzufuegen = () => {
    setItems(prev => [...(prev ?? []), { key: `ph-${phZaehler.current++}`, artikel: null }])
    setDirty(true)
  }

  const entfernen = (key: string) => {
    setItems(prev => (prev ?? []).filter(i => i.key !== key))
    setDirty(true)
  }

  const verschieben = (idx: number, delta: number) => {
    setItems(prev => prev ? arrayMove(prev, idx, idx + delta) : prev)
    setDirty(true)
  }

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setItems(prev => {
      if (!prev) return prev
      const oldIdx = prev.findIndex(i => i.key === active.id)
      const newIdx = prev.findIndex(i => i.key === over.id)
      return arrayMove(prev, oldIdx, newIdx)
    })
    setDirty(true)
  }

  const liste = items ?? []

  // Wählbare Artikel: aktiv, an dieser Kasse sichtbar, noch nicht in der Liste
  const verfuegbar = alleArtikel
    .filter(a => a.aktiv && kategorieSichtbar(a) && !liste.some(i => i.artikel?.id === a.id))
    .filter(a => a.bezeichnung.toLowerCase().includes(suche.trim().toLowerCase()))
    .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung))

  if (items === null) {
    return <div className="text-sm text-ink-subtle py-8 text-center">Laden…</div>
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-ink-subtle">
        Diese Favoritenliste gilt nur für die oben gewählte Kasse und wird dort
        genau in dieser Anordnung angezeigt. Ohne gespeicherte Liste gelten die
        globalen ★-Favoriten aus der Artikelverwaltung.
      </p>

      {/* Artikel je Zeile — gemeinsame Einstellung für Kasse + Kellner-App */}
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-ink">Artikel je Zeile</h3>
        <div className="flex gap-1">
          {[2, 3, 4, 5, 6].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => spalten.mutate(n)}
              disabled={spalten.isPending}
              className={`w-9 h-9 rounded-lg text-sm font-semibold transition ${
                artikelProZeile === n
                  ? 'bg-brand-600 text-white'
                  : 'bg-panel-2 text-ink-muted hover:text-ink'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="text-xs text-ink-subtle">gilt für Kasse und Kellner-App gemeinsam</span>
      </div>

      {/* Picker: Artikel oder Platzhalter anhängen */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Hinzufügen</h3>
          <button
            type="button"
            onClick={platzhalterHinzufuegen}
            className="rounded-full border border-dashed border-line-strong px-3 py-1.5 text-xs text-ink-muted hover:border-brand-400 hover:text-ink transition"
          >
            + Platzhalter (leere Kachel)
          </button>
        </div>
        <input
          value={suche}
          onChange={e => setSuche(e.target.value)}
          placeholder="Artikel suchen…"
          className="w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {verfuegbar.length === 0 ? (
          <p className="text-xs text-ink-subtle py-2">
            {suche.trim() ? 'Kein passender Artikel.' : 'Alle an dieser Kasse sichtbaren Artikel sind bereits in der Liste.'}
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

      {/* Vorschau-Raster in Kassen-Optik: Ziehen zum Anordnen, ‹ › ✕ je Kachel */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">
            Favoriten dieser Kasse <span className="font-normal text-ink-subtle">({liste.filter(i => i.artikel !== null).length})</span>
          </h3>
          {dirty && (
            <Button
              onClick={() => speichern.mutate(liste.map(i => ({ artikelId: i.artikel?.id ?? null })))}
              loading={speichern.isPending}>
              Favoriten speichern
            </Button>
          )}
        </div>

        {liste.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-line p-8 text-center">
            <p className="text-sm text-ink-subtle">Noch keine Favoriten für diese Kasse.</p>
            <p className="mt-1 text-xs text-ink-subtle">Oben Artikel auswählen, dann per Ziehen anordnen.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={liste.map(i => i.key)} strategy={rectSortingStrategy}>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${artikelProZeile}, minmax(0, 1fr))` }}
              >
                {liste.map((eintrag, i) => {
                  const a = eintrag.artikel
                  const farbe    = a ? (a.farbe ?? (a.kategorieId ? farbeProKategorie.get(a.kategorieId) : undefined)) : undefined
                  const farbeHex = farbe ? farbeZuHex(farbe) : undefined
                  // Bedienleiste je Kachel; onPointerDown stoppen, damit kein Drag startet
                  const leiste = (
                    <div className="flex items-center justify-end gap-0.5 border-t border-line bg-panel-2/60 px-1 py-0.5">
                      <button type="button" aria-label="Nach vorne" disabled={i === 0}
                        onPointerDown={e => e.stopPropagation()} onClick={() => verschieben(i, -1)}
                        className="w-6 h-6 rounded text-ink-muted hover:text-brand-600 hover:bg-panel disabled:opacity-25 text-sm leading-none">‹</button>
                      <button type="button" aria-label="Nach hinten" disabled={i === liste.length - 1}
                        onPointerDown={e => e.stopPropagation()} onClick={() => verschieben(i, 1)}
                        className="w-6 h-6 rounded text-ink-muted hover:text-brand-600 hover:bg-panel disabled:opacity-25 text-sm leading-none">›</button>
                      <button type="button" aria-label="Entfernen"
                        onPointerDown={e => e.stopPropagation()} onClick={() => entfernen(eintrag.key)}
                        className="w-6 h-6 rounded text-ink-subtle hover:text-red-500 hover:bg-panel text-sm leading-none">✕</button>
                    </div>
                  )
                  return (
                    <SortableKachel key={eintrag.key} id={eintrag.key}>
                      {a === null ? (
                        // Platzhalter: graue, gesperrte Kachel — so sieht sie auch an der Kasse aus
                        <div className="rounded-lg border border-dashed border-line bg-panel-2/60 overflow-hidden flex flex-col">
                          <div className="flex-1 min-h-[3.5rem] flex items-center justify-center">
                            <span className="text-[10px] text-ink-subtle">Platzhalter</span>
                          </div>
                          {leiste}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-line bg-panel shadow-sm overflow-hidden flex flex-col">
                          {/* Farbiger Akzent oben wie an der Kasse */}
                          <div className="h-1.5 w-full" style={{ backgroundColor: farbeHex ?? 'var(--color-brand-500, #16a34a)' }} />
                          {artikelbilder && a.bild && (
                            <div className="w-full h-16 overflow-hidden bg-panel-2">
                              <img src={a.bild} alt="" className="w-full h-full object-cover" loading="lazy" />
                            </div>
                          )}
                          <div className="p-2 flex-1">
                            <p className="text-xs font-medium text-ink line-clamp-2 min-h-[2rem] leading-tight">
                              {a.bezeichnung}
                            </p>
                            <p className="mt-1 text-xs font-semibold text-brand-600">{preis(a.preisBruttoCent)}</p>
                          </div>
                          {leiste}
                        </div>
                      )}
                    </SortableKachel>
                  )
                })}
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

  // Serverstand übernehmen, sobald (oder wann immer) er eintrifft — der frühere
  // useState-Trick lief nur beim Mount und verpasste später geladene Daten.
  useEffect(() => {
    if (posQuery.data) {
      setErlaubte(new Set(posQuery.data.erlaubteZahlungsarten))
      setArtikelbilder(posQuery.data.artikelbilderAktiv)
      setStartseite(posQuery.data.startseite)
    }
  }, [posQuery.data])

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
// Tab 5: Kellner-App (mobile Kassen)
// ---------------------------------------------------------------------------

const KELLNER_MODI: { value: KellnerModus; label: string; beschreibung: string }[] = [
  { value: 'tische', label: 'Tische (Gastro)',        beschreibung: 'Tischliste + Tisch-Tabs — der Standard im Service' },
  { value: 'theke',  label: 'Theke / Direktverkauf',  beschreibung: 'Ohne Tische: anmelden → Artikel wählen → sofort kassieren (z. B. Bar-Tablet)' },
]

const TISCHWAHL_OPTIONEN: { value: KellnerTischwahl; label: string; beschreibung: string; brauchtPlan: boolean }[] = [
  { value: 'manuell', label: 'Manuelle Eingabe',       beschreibung: 'Tischnummer wird eingetippt (bisheriges Verhalten)', brauchtPlan: false },
  { value: 'liste',   label: 'Tischliste nach Bereich', beschreibung: 'Tische je Bereich aus dem Tischplan antippen',       brauchtPlan: true },
  { value: 'plan',    label: 'Grafischer Tischplan',    beschreibung: 'Mini-Tischplan wie an der Kassa',                    brauchtPlan: true },
]

function TabKellner({ kasseId }: { kasseId: string }) {
  const qc = useQueryClient()
  const posQuery = useQuery({
    queryKey: ['pos-config', kasseId],
    queryFn:  () => posConfigApi.get(kasseId),
  })
  const bereicheQuery = useQuery({
    queryKey: ['tischplan-bereiche', kasseId],
    queryFn:  () => tischplanApi.listeBereiche(kasseId),
  })
  const planVorhanden = (bereicheQuery.data ?? []).some(b => b.elemente.length > 0)

  const mut = useMutation({
    mutationFn: (input: { kellnerModus?: KellnerModus; kellnerTischwahl?: KellnerTischwahl; kellnerFavoritenAktiv?: boolean }) =>
      posConfigApi.update(kasseId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  if (!posQuery.data) {
    return <div className="text-sm text-ink-subtle py-8 text-center">Laden…</div>
  }
  const konfig = posQuery.data

  return (
    <div className="space-y-6 max-w-sm">
      {/* Betriebsart */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Betriebsart</p>
        {KELLNER_MODI.map(({ value, label, beschreibung }) => (
          <label key={value} className="flex items-center gap-3 cursor-pointer rounded-xl border border-line bg-panel px-4 py-3 hover:bg-panel-2">
            <input
              type="radio"
              name="kellnerModus"
              value={value}
              checked={konfig.kellnerModus === value}
              onChange={() => mut.mutate({ kellnerModus: value })}
              className="h-4 w-4 border-line-strong text-brand-600 focus:ring-brand-500"
            />
            <div>
              <p className="text-sm font-medium text-ink">{label}</p>
              <p className="text-xs text-ink-subtle mt-0.5">{beschreibung}</p>
            </div>
          </label>
        ))}
      </div>

      {/* Tischauswahl — im Theken-Modus gegenstandslos */}
      {konfig.kellnerModus === 'tische' && (
      <div className="border-t border-line pt-5 space-y-3">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Tischauswahl beim Öffnen</p>
        <p className="text-sm text-ink-muted">
          Wie wählen die Kellner am Handy einen Tisch? Die manuelle Eingabe bleibt
          in jedem Modus als Rückfallebene verfügbar.
        </p>
        {TISCHWAHL_OPTIONEN.map(({ value, label, beschreibung, brauchtPlan }) => {
          const gesperrt = brauchtPlan && !planVorhanden
          return (
            <label
              key={value}
              className={`flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 ${
                gesperrt ? 'opacity-50' : 'cursor-pointer hover:bg-panel-2'
              }`}
            >
              <input
                type="radio"
                name="kellnerTischwahl"
                value={value}
                disabled={gesperrt}
                checked={konfig.kellnerTischwahl === value}
                onChange={() => mut.mutate({ kellnerTischwahl: value })}
                className="h-4 w-4 border-line-strong text-brand-600 focus:ring-brand-500"
              />
              <div>
                <p className="text-sm font-medium text-ink">{label}</p>
                <p className="text-xs text-ink-subtle mt-0.5">{beschreibung}</p>
              </div>
            </label>
          )
        })}
        {!planVorhanden && !bereicheQuery.isLoading && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Noch kein Tischplan mit Tischen angelegt — unter Einstellungen → Tischplan
            Bereiche und Tische anlegen, dann werden Liste und Plan wählbar.
          </p>
        )}
      </div>
      )}

      {/* Favoriten */}
      <div className="border-t border-line pt-5 space-y-3">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Artikelwahl</p>
        <label className="flex items-center gap-3 cursor-pointer rounded-xl border border-line bg-panel px-4 py-3 hover:bg-panel-2">
          <input
            type="checkbox"
            checked={konfig.kellnerFavoritenAktiv}
            onChange={() => mut.mutate({ kellnerFavoritenAktiv: !konfig.kellnerFavoritenAktiv })}
            className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
          />
          <div>
            <p className="text-sm font-medium text-ink">Favoriten-Reiter anzeigen</p>
            <p className="text-xs text-ink-subtle mt-0.5">
              Die Favoriten (Reiter „Favoriten" hier in der POS-Konfiguration) erscheinen
              in der Kellner-App als erster Reiter der Artikelwahl.
            </p>
          </div>
        </label>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

// Farb-Punkte kommen aus der zentralen 20er-Hex-Palette (@kassa/shared).

// Stabile Leer-Werte: eine neue [] je Render würde die Abgleich-Effekte der Tabs in eine Schleife schicken
const KEINE_KATEGORIEN: Kategorie[] = []
const KEINE_ARTIKEL: Artikel[] = []

export function PosKonfigPage() {
  const identity = getKasseIdentity()!
  const [aktuellerTab, setAktuellerTab] = useState<Tab>('warengruppen')
  // Ungespeicherte Änderungen im Reiter „Artikel": Kassen- oder Reiterwechsel fragt nach, statt sie still zu verwerfen
  const [artikelGeaendert, setArtikelGeaendert] = useState(false)
  const [seitenWechsel, setSeitenWechsel] = useState<(() => void) | null>(null)
  const mitSchutz = (aktion: () => void) => {
    if (aktuellerTab === 'artikel' && artikelGeaendert) setSeitenWechsel(() => aktion)
    else aktion()
  }

  // Kassen-Auswahl: alle per-Kasse-Einstellungen (Sichtbarkeit, Zahlungsarten,
  // Kellner-App) lassen sich für JEDE Kasse pflegen, nicht nur die angemeldete —
  // z. B. das Bar-Tablet vom Büro-PC aus konfigurieren.
  const [gewaehlteKasseId, setGewaehlteKasseId] = useState(identity.kasseId)
  const kassenQuery = useQuery({
    queryKey: ['kassen'],
    queryFn:  () => kasseApi.liste(),
  })
  const aktiveKassen = (kassenQuery.data ?? []).filter(k => k.status === 'aktiv')

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
    { key: 'kellner',       label: 'Kellner-App' },
  ]

  const kategorien  = kategorienQuery.data ?? KEINE_KATEGORIEN
  const alleArtikel = artikelQuery.data    ?? KEINE_ARTIKEL
  const isLoading   = kategorienQuery.isLoading || artikelQuery.isLoading
  const gewaehlteKasse = aktiveKassen.find(k => k.id === gewaehlteKasseId)
  const kasseName = gewaehlteKasse ? (gewaehlteKasse.bezeichnung || gewaehlteKasse.kassenId) : 'diese Kasse'

  return (
    // Der Raster-Editor braucht Platz für bis zu 6 Spalten mit Bedienknöpfen
    <div className={`mx-auto px-4 py-8 space-y-6 ${aktuellerTab === 'artikel' ? 'max-w-5xl' : 'max-w-3xl'}`}>
      <div>
        <h1 className="text-2xl font-bold text-ink">POS-Konfiguration</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Sortierung und Darstellung im Kassensystem.
        </p>
      </div>

      {/* Kassen-Auswahl — nur wenn es mehr als eine aktive Kasse gibt */}
      {aktiveKassen.length > 1 && (
        <div className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            {aktiveKassen.map(k => (
              <button
                key={k.id}
                onClick={() => { if (k.id !== gewaehlteKasseId) mitSchutz(() => setGewaehlteKasseId(k.id)) }}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
                  gewaehlteKasseId === k.id
                    ? 'bg-brand-600 text-white'
                    : 'bg-panel-2 text-ink-muted hover:text-ink'
                }`}
              >
                {k.bezeichnung || k.kassenId}
                {k.id === identity.kasseId && <span className="opacity-70"> · diese</span>}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-subtle">
            Warengruppen-Sichtbarkeit, Artikel-Anordnung, Favoriten, Zahlungsarten und Kellner-App
            gelten je Kasse — hier die Kasse wählen, für die die Einstellungen gelten sollen.
            Die Reihenfolge der Warengruppen ist global.
          </p>
        </div>
      )}

      {/* Tab-Navigation */}
      <div className="flex gap-1 rounded-xl bg-panel-2 p-1">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => { if (t.key !== aktuellerTab) mitSchutz(() => setAktuellerTab(t.key)) }}
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

      {seitenWechsel && (
        <UngespeichertHinweis
          onVerwerfen={() => {
            const aktion = seitenWechsel
            setSeitenWechsel(null)
            setArtikelGeaendert(false)
            aktion()
          }}
          onBleiben={() => setSeitenWechsel(null)}
        />
      )}

      {isLoading ? (
        <div className="text-sm text-ink-subtle py-8 text-center">Laden…</div>
      ) : (
        <div>
          {aktuellerTab === 'warengruppen' && (
            <TabWarengruppen key={gewaehlteKasseId} kategorien={kategorien} kasseId={gewaehlteKasseId} />
          )}
          {aktuellerTab === 'artikel' && (
            <ArtikelAnordnungTab
              key={gewaehlteKasseId}
              kategorien={kategorien}
              alleArtikel={alleArtikel}
              kasseId={gewaehlteKasseId}
              kasseName={kasseName}
              onGeaendertChange={setArtikelGeaendert}
            />
          )}
          {aktuellerTab === 'favoriten' && (
            <TabFavoriten key={gewaehlteKasseId} alleArtikel={alleArtikel} kategorien={kategorien} kasseId={gewaehlteKasseId} />
          )}
          {aktuellerTab === 'zahlungsarten' && (
            <TabZahlungsarten key={gewaehlteKasseId} kasseId={gewaehlteKasseId} />
          )}
          {aktuellerTab === 'kellner' && (
            <TabKellner kasseId={gewaehlteKasseId} />
          )}
        </div>
      )}
    </div>
  )
}
