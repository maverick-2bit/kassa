/**
 * ArtikelAnordnungEditor — Kachel-Raster einer Warengruppe zum Anordnen (POS-Konfiguration → Artikel).
 *
 * Zeigt das Raster so, wie die Kasse es zeigt: erst die Untergruppen als FESTE Kacheln, danach die
 * Artikel an ihren Slots (leere Felder gestrichelt), in der Spaltenzahl der Kasse. Bedienung:
 *  - Ziehen: Kachel auf eine freie Zelle (verschiebt) oder auf eine belegte (tauscht); auf die Ablage = ausblenden
 *  - Knöpfe je Kachel (auch für Tastatur/Touch/E2E): ← → um eine Zelle, ↑ ↓ um eine Zeile, ✕ ausblenden
 *  - Ablage „Ausgeblendet / noch nicht platziert": „Platzieren" setzt den Artikel in die erste freie Zelle
 * Am Ende des Rasters steht immer mindestens eine ganz leere Zeile (Ablageziel zum Anhängen).
 *
 * Der Zustand (Anordnung) gehört dem Aufrufer; die Logik steckt in lib/artikel-anordnung.ts. Alle Kacheln und
 * Zellen sind DIREKTE Kinder eines Grids und liegen per grid-row/-column auf ihrer Zelle: eine bewegte Kachel
 * bleibt dasselbe DOM-Element (der Fokus bleibt auf dem Knopf, auf dem man gerade ist).
 */

import { useState } from 'react'
import {
  closestCenter,
  DndContext,
  PointerSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { farbeZuHex, type Artikel, type Kategorie } from '@kassa/shared'
import { formatPreis } from '../lib/format'
import {
  anzahlSlotZellen,
  blendeAus,
  kannVersetzen,
  platziere,
  setzeAufSlot,
  slotVon,
  versetze,
  zellPosition,
  type Anordnung,
} from '../lib/artikel-anordnung'
import { BoxSymbol, schriftAuf } from './RasterBausteine'

interface Props {
  anordnung:         Anordnung
  onChange:          (neu: Anordnung) => void
  /** Alle Artikel des Editors, nach ID */
  artikel:           ReadonlyMap<string, Artikel>
  /** Feste Kacheln vor den Artikeln (Untergruppen, die die Kasse zeigt) */
  untergruppen:      readonly Kategorie[]
  spalten:           number
  /** Warengruppen-Farbe als Vorgabe für den Akzentstreifen (eigene Artikel-Farbe geht vor) */
  farbeProKategorie: ReadonlyMap<string, string>
  artikelbilder:     boolean
  /** Im Standard-Layout gibt es kein Ausblenden (dafür Artikel deaktivieren oder je Kasse ausblenden) */
  ausblendenErlaubt: boolean
  /** Nur ansehen (kein Administrator) oder Speichern läuft */
  gesperrt:          boolean
}

const ARTIKEL_ID = 'artikel:'
const SLOT_ID    = 'slot:'
const ABLAGE_ID  = 'ablage'

/**
 * Unter dem Mauszeiger (so trifft man auch die große Ablage-Fläche), sonst die nächste ZELLE — nie die Ablage:
 * ausgeblendet wird nur durch gezieltes Ablegen dort oder per ✕, nicht durch ein Loslassen neben dem Raster.
 */
const kollision: CollisionDetection = (args) => {
  const innen = pointerWithin(args)
  if (innen.length > 0) return innen
  return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(c => c.id !== ABLAGE_ID) })
}

export function ArtikelAnordnungEditor({
  anordnung, onChange, artikel, untergruppen, spalten, farbeProKategorie, artikelbilder, ausblendenErlaubt, gesperrt,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )
  // Über welcher Zelle schwebt gerade eine gezogene Kachel (Rückmeldung beim Tauschen/Ablegen)
  const [ueber, setUeber] = useState<string | null>(null)

  const vorn      = untergruppen.length
  const zellen    = anzahlSlotZellen(anordnung.slots.length, vorn, spalten)
  const aenderung = (neu: Anordnung) => { if (neu !== anordnung) onChange(neu) }

  const gezogenEnde = (e: DragEndEvent) => {
    setUeber(null)
    const aktiv = String(e.active.id)
    const ziel  = e.over ? String(e.over.id) : null
    if (!aktiv.startsWith(ARTIKEL_ID) || ziel === null) return
    const id = aktiv.slice(ARTIKEL_ID.length)
    if (ziel === ABLAGE_ID) {
      if (ausblendenErlaubt) aenderung(blendeAus(anordnung, id))
    } else if (ziel.startsWith(SLOT_ID)) {
      aenderung(setzeAufSlot(anordnung, id, Number(ziel.slice(SLOT_ID.length))))
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={kollision}
      onDragOver={(e: DragOverEvent) => setUeber(e.over ? String(e.over.id) : null)}
      onDragEnd={gezogenEnde}
      onDragCancel={() => setUeber(null)}
    >
      <div
        data-testid="anordnung-raster"
        data-spalten={spalten}
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${spalten}, minmax(0, 1fr))`, gridAutoRows: 'minmax(5.5rem, auto)' }}
      >
        {/* feste Kacheln der Untergruppen */}
        {untergruppen.map((g, i) => {
          const hex = farbeZuHex(g.farbe) ?? '#9ca3af'
          const { zeile, spalte } = zellPosition(i, spalten)
          return (
            <div
              key={`gruppe-${g.id}`}
              data-testid="anordnung-untergruppe"
              title="Untergruppe — feste Kachel, steht immer vor den Artikeln"
              className="flex flex-col items-start justify-between gap-1 overflow-hidden rounded-lg p-2 opacity-80"
              style={{ gridRow: zeile, gridColumn: spalte, backgroundColor: hex, color: schriftAuf(hex) }}
            >
              <BoxSymbol />
              <span className="line-clamp-2 text-xs font-semibold leading-tight">{g.name}</span>
            </div>
          )
        })}

        {/* Zellen (Ablageziele) — leer sichtbar, unter einer Kachel unsichtbar */}
        {Array.from({ length: zellen }, (_, i) => (
          <Zelle
            key={`zelle-${i + 1}`}
            slot={i + 1}
            index={vorn + i}
            spalten={spalten}
            belegt={anordnung.slots[i] != null}
            hervorgehoben={ueber === `${SLOT_ID}${i + 1}`}
            gesperrt={gesperrt}
          />
        ))}

        {/* Artikel-Kacheln an ihrem Slot */}
        {anordnung.slots.map((id, i) => {
          const a = id === null ? undefined : artikel.get(id)
          if (id === null || !a) return null
          return (
            <Kachel
              key={`${ARTIKEL_ID}${id}`}
              artikel={a}
              slot={i + 1}
              index={vorn + i}
              spalten={spalten}
              anordnung={anordnung}
              onChange={aenderung}
              farbeProKategorie={farbeProKategorie}
              artikelbilder={artikelbilder}
              ausblendenErlaubt={ausblendenErlaubt}
              gesperrt={gesperrt}
              ziel={ueber === `${SLOT_ID}${i + 1}`}
            />
          )
        })}
      </div>

      {(ausblendenErlaubt || anordnung.ausgeblendet.length > 0) && (
        <Ablage
          anordnung={anordnung}
          onChange={aenderung}
          artikel={artikel}
          ausblendenErlaubt={ausblendenErlaubt}
          gesperrt={gesperrt}
          hervorgehoben={ueber === ABLAGE_ID}
        />
      )}
    </DndContext>
  )
}

// ---------------------------------------------------------------------------
// Zelle (Ablageziel)
// ---------------------------------------------------------------------------

function Zelle({ slot, index, spalten, belegt, hervorgehoben, gesperrt }: {
  slot: number; index: number; spalten: number; belegt: boolean; hervorgehoben: boolean; gesperrt: boolean
}) {
  const { setNodeRef } = useDroppable({ id: `${SLOT_ID}${slot}`, disabled: gesperrt })
  const { zeile, spalte } = zellPosition(index, spalten)
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      data-testid={belegt ? 'anordnung-zelle' : 'anordnung-leer'}
      data-slot={slot}
      className={`rounded-lg border border-dashed ${
        belegt
          ? 'invisible border-line'
          : hervorgehoben ? 'border-brand-500 bg-brand-50' : 'border-line bg-panel-2/60'
      }`}
      style={{ gridRow: zeile, gridColumn: spalte }}
    >
      {!belegt && <span className="block p-1 text-[10px] leading-none text-ink-subtle">{slot}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Artikel-Kachel
// ---------------------------------------------------------------------------

function Knopf({ label, titel, disabled, gefahr = false, onClick, children }: {
  label: string; titel: string; disabled: boolean; gefahr?: boolean; onClick: () => void; children: React.ReactNode
}) {
  // onPointerDown/onTouchStart stoppen, damit der Tastendruck keinen Zieh-Vorgang startet
  return (
    <button
      type="button"
      aria-label={label}
      title={titel}
      disabled={disabled}
      onPointerDown={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
      onClick={onClick}
      className={`h-6 w-6 rounded text-sm leading-none hover:bg-panel disabled:opacity-25 disabled:hover:bg-transparent ${
        gefahr ? 'text-ink-subtle hover:text-red-500' : 'text-ink-muted hover:text-brand-600'
      }`}
    >
      {children}
    </button>
  )
}

function Kachel({
  artikel: a, slot, index, spalten, anordnung, onChange, farbeProKategorie, artikelbilder, ausblendenErlaubt, gesperrt, ziel,
}: {
  artikel: Artikel; slot: number; index: number; spalten: number
  anordnung: Anordnung; onChange: (neu: Anordnung) => void
  farbeProKategorie: ReadonlyMap<string, string>; artikelbilder: boolean
  ausblendenErlaubt: boolean; gesperrt: boolean
  /** Eine andere Kachel schwebt über dieser (Tauschen) */
  ziel: boolean
}) {
  // role=group statt der Vorgabe „button": die Kachel enthält Knöpfe — ein Knopf im Knopf
  // wäre für Screenreader und Tests doppelt auffindbar
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${ARTIKEL_ID}${a.id}`,
    disabled: gesperrt,
    attributes: { role: 'group', tabIndex: -1 },
  })
  const { zeile, spalte } = zellPosition(index, spalten)
  const farbe    = a.farbe ?? (a.kategorieId ? farbeProKategorie.get(a.kategorieId) : undefined)
  const farbeHex = farbe ? farbeZuHex(farbe) : undefined
  const bewege   = (delta: number) => onChange(versetze(anordnung, a.id, delta))

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={a.bezeichnung}
      data-testid="anordnung-artikel"
      data-artikel-id={a.id}
      data-slot={slot}
      className={`relative flex flex-col overflow-hidden rounded-lg border bg-panel shadow-sm ${
        gesperrt ? '' : 'cursor-grab active:cursor-grabbing'
      } ${isDragging ? 'opacity-80 shadow-lg' : ''} ${ziel ? 'border-brand-500 ring-2 ring-brand-500' : 'border-line'}`}
      style={{ gridRow: zeile, gridColumn: spalte, transform: CSS.Translate.toString(transform), zIndex: isDragging ? 30 : undefined }}
    >
      {/* Farbiger Akzent oben wie an der Kasse: Artikel-Farbe ?? Warengruppen-Farbe */}
      <div className="h-1.5 w-full shrink-0" style={{ backgroundColor: farbeHex ?? 'var(--color-brand-500, #16a34a)' }} />
      {artikelbilder && a.bild && (
        <div className="h-12 w-full shrink-0 overflow-hidden bg-panel-2">
          <img src={a.bild} alt="" className="h-full w-full object-cover" loading="lazy" />
        </div>
      )}
      <div className="min-w-0 flex-1 p-2">
        <p className="line-clamp-2 min-h-[2rem] text-xs font-medium leading-tight text-ink">{a.bezeichnung}</p>
        <p className="mt-1 text-xs font-semibold text-brand-600">{formatPreis(a.preisBruttoCent)}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-0.5 border-t border-line bg-panel-2/60 px-1 py-0.5">
        <Knopf label="Nach links" titel="Eine Zelle nach links (tauscht mit dem Nachbarn)"
          disabled={gesperrt || !kannVersetzen(anordnung, a.id, -1)} onClick={() => bewege(-1)}>←</Knopf>
        <Knopf label="Nach rechts" titel="Eine Zelle nach rechts (tauscht mit dem Nachbarn)"
          disabled={gesperrt || !kannVersetzen(anordnung, a.id, +1)} onClick={() => bewege(+1)}>→</Knopf>
        <Knopf label="Eine Zeile nach oben" titel="Eine Zeile nach oben"
          disabled={gesperrt || !kannVersetzen(anordnung, a.id, -spalten)} onClick={() => bewege(-spalten)}>↑</Knopf>
        <Knopf label="Eine Zeile nach unten" titel="Eine Zeile nach unten"
          disabled={gesperrt || !kannVersetzen(anordnung, a.id, +spalten)} onClick={() => bewege(+spalten)}>↓</Knopf>
        {ausblendenErlaubt && (
          <Knopf label="Ausblenden" titel="An dieser Kasse in dieser Warengruppe ausblenden" gefahr
            disabled={gesperrt} onClick={() => onChange(blendeAus(anordnung, a.id))}>✕</Knopf>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ablage „Ausgeblendet / noch nicht platziert"
// ---------------------------------------------------------------------------

function Ablage({ anordnung, onChange, artikel, ausblendenErlaubt, gesperrt, hervorgehoben }: {
  anordnung: Anordnung; onChange: (neu: Anordnung) => void; artikel: ReadonlyMap<string, Artikel>
  ausblendenErlaubt: boolean; gesperrt: boolean; hervorgehoben: boolean
}) {
  const { setNodeRef } = useDroppable({ id: ABLAGE_ID, disabled: gesperrt || !ausblendenErlaubt })
  const eintraege = anordnung.ausgeblendet.flatMap(id => { const a = artikel.get(id); return a ? [a] : [] })
  return (
    <section
      ref={setNodeRef}
      data-testid="anordnung-ablage"
      aria-label="Ausgeblendet / noch nicht platziert"
      className={`mt-4 rounded-lg border-2 border-dashed p-3 ${hervorgehoben ? 'border-brand-500 bg-brand-50' : 'border-line bg-panel-2/40'}`}
    >
      <h3 className="text-sm font-semibold text-ink">
        Ausgeblendet / noch nicht platziert <span className="font-normal text-ink-subtle">({eintraege.length})</span>
      </h3>
      {eintraege.length === 0 ? (
        <p className="mt-1 text-xs text-ink-subtle">
          Nichts ausgeblendet. Mit ✕ an einer Kachel (oder indem du sie hierher ziehst) verschwindet ein Artikel an dieser Kasse
          aus dieser Warengruppe — Suche und Favoriten finden ihn weiterhin.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {eintraege.map(a => (
            <AblageEintrag key={a.id} artikel={a} anordnung={anordnung} onChange={onChange} gesperrt={gesperrt} />
          ))}
        </div>
      )}
    </section>
  )
}

function AblageEintrag({ artikel: a, anordnung, onChange, gesperrt }: {
  artikel: Artikel; anordnung: Anordnung; onChange: (neu: Anordnung) => void; gesperrt: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${ARTIKEL_ID}${a.id}`,
    disabled: gesperrt,
    attributes: { role: 'group', tabIndex: -1 },
  })
  // Gibt es noch einen Platz? (Raster bis MAX_SLOT voll → Knopf gesperrt)
  const platzierbar = platziere(anordnung, a.id) !== anordnung
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={a.bezeichnung}
      data-testid="anordnung-ablage-artikel"
      data-artikel-id={a.id}
      className={`flex items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5 shadow-sm ${
        gesperrt ? '' : 'cursor-grab active:cursor-grabbing'
      } ${isDragging ? 'opacity-80 shadow-lg' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), zIndex: isDragging ? 30 : undefined, position: 'relative' }}
    >
      <span className="text-xs font-medium text-ink">{a.bezeichnung}</span>
      <span className="text-xs tabular-nums text-ink-subtle">{formatPreis(a.preisBruttoCent)}</span>
      <button
        type="button"
        aria-label={`${a.bezeichnung} platzieren`}
        title="In die erste freie Zelle setzen"
        disabled={gesperrt || !platzierbar || slotVon(anordnung, a.id) !== null}
        onPointerDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onClick={() => onChange(platziere(anordnung, a.id))}
        className="rounded-md border border-line-strong px-2 py-0.5 text-xs font-medium text-ink-muted hover:border-brand-400 hover:text-brand-700 disabled:opacity-40"
      >
        Platzieren
      </button>
    </div>
  )
}
