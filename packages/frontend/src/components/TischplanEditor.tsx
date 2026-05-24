/**
 * TischplanEditor — Admin-seitiger Drag-&-Drop-Editor für den Tischplan.
 *
 * Bereiche: anlegen, umbenennen, löschen (mit Cascade auf Elemente)
 * Elemente: hinzufügen, per Pointer-Drag verschieben, Eigenschaften im
 *           Seitenpanel ändern, löschen.
 *
 * Positionen/Größen werden als Prozent der Canvas-Fläche gespeichert.
 */

import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  TischplanBereich,
  TischplanElement,
  TischplanFarbe,
  TischplanForm,
} from '@kassa/shared'
import { TISCHPLAN_FARBE_LABELS, TISCHPLAN_FORM_LABELS } from '@kassa/shared'
import { tischplanApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

// ---------------------------------------------------------------------------
// Farb-Mapping für Editor-Darstellung
// ---------------------------------------------------------------------------

const FARBE_BG: Record<TischplanFarbe, string> = {
  grau:   'bg-gray-200 border-gray-400',
  rot:    'bg-red-200 border-red-500',
  orange: 'bg-orange-200 border-orange-500',
  gelb:   'bg-yellow-200 border-yellow-500',
  gruen:  'bg-green-200 border-green-500',
  blau:   'bg-blue-200 border-blue-500',
  lila:   'bg-purple-200 border-purple-500',
  pink:   'bg-pink-200 border-pink-500',
}

const ALLE_FARBEN: TischplanFarbe[] = ['grau','rot','orange','gelb','gruen','blau','lila','pink']

// ---------------------------------------------------------------------------
// Hauptkomponente
// ---------------------------------------------------------------------------

export function TischplanEditor() {
  const identity = getKasseIdentity()!
  const qc       = useQueryClient()

  const [aktiverBereichId, setAktiverBereichId] = useState<string | null>(null)
  const [selectedElId,     setSelectedElId]     = useState<string | null>(null)
  const [neuerBereichName, setNeuerBereichName] = useState('')
  const [fehler,           setFehler]           = useState<string | null>(null)

  const { data: bereiche = [], isLoading } = useQuery({
    queryKey: ['tischplan', identity.kasseId],
    queryFn:  () => tischplanApi.listeBereiche(identity.kasseId),
  })

  const aktiveBereich = bereiche.find((b) => b.id === aktiverBereichId) ?? bereiche[0] ?? null
  const selectedEl    = aktiveBereich?.elemente.find((e) => e.id === selectedElId) ?? null

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tischplan', identity.kasseId] })

  // Bereich anlegen
  const erstelleBereichMut = useMutation({
    mutationFn: (name: string) =>
      tischplanApi.erstelleBereich({ kasseId: identity.kasseId, name }),
    onSuccess: (b) => { invalidate(); setAktiverBereichId(b.id); setNeuerBereichName('') },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // Bereich löschen
  const loescheBereichMut = useMutation({
    mutationFn: (id: string) => tischplanApi.loescheBereich(id),
    onSuccess: () => { invalidate(); setAktiverBereichId(null); setSelectedElId(null) },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // Bereich umbenennen
  const umbenenneBereichMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      tischplanApi.aktualisiereBereich(id, { name }),
    onSuccess: invalidate,
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // Element anlegen
  const erstelleElMut = useMutation({
    mutationFn: () =>
      tischplanApi.erstelleElement({
        kasseId:     identity.kasseId,
        bereichId:   aktiveBereich!.id,
        bezeichnung: `T${(aktiveBereich!.elemente.length + 1)}`,
        form:        'rechteck',
        farbe:       'grau',
        x:           5,
        y:           5,
        breite:      12,
        hoehe:       10,
      }),
    onSuccess: (el) => { invalidate(); setSelectedElId(el.id) },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // Element aktualisieren (Position, Eigenschaften)
  const aktualisiereElMut = useMutation({
    mutationFn: ({ id, ...input }: Partial<TischplanElement> & { id: string }) =>
      tischplanApi.aktualisiereElement(id, input),
    onSuccess: invalidate,
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // Element löschen
  const loescheElMut = useMutation({
    mutationFn: (id: string) => tischplanApi.loescheElement(id),
    onSuccess: () => { invalidate(); setSelectedElId(null) },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  if (isLoading) return <p className="text-sm text-gray-500">Wird geladen…</p>

  return (
    <div className="space-y-4">
      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}

      {/* Bereich-Tabs + Neu-Button */}
      <div className="flex flex-wrap items-center gap-2">
        {bereiche.map((b) => (
          <BereichTab
            key={b.id}
            bereich={b}
            aktiv={b.id === (aktiveBereich?.id ?? null)}
            onClick={() => { setAktiverBereichId(b.id); setSelectedElId(null) }}
            onRename={(name) => umbenenneBereichMut.mutate({ id: b.id, name })}
            onDelete={() => {
              if (confirm(`Bereich „${b.name}" und alle darin enthaltenen Tische löschen?`)) {
                loescheBereichMut.mutate(b.id)
              }
            }}
          />
        ))}
        <div className="flex gap-1">
          <Input
            placeholder="Neuer Bereich …"
            value={neuerBereichName}
            onChange={(e) => setNeuerBereichName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && neuerBereichName.trim()) {
                erstelleBereichMut.mutate(neuerBereichName.trim())
              }
            }}
            className="w-36 h-8 text-xs"
          />
          <Button
            onClick={() => neuerBereichName.trim() && erstelleBereichMut.mutate(neuerBereichName.trim())}
            loading={erstelleBereichMut.isPending}
            className="h-8 px-3 text-xs"
          >
            +
          </Button>
        </div>
      </div>

      {aktiveBereich ? (
        <div className="flex gap-4 items-start">
          {/* Canvas */}
          <div className="flex-1 min-w-0">
            <PlanCanvas
              bereich={aktiveBereich}
              selectedElId={selectedElId}
              onSelect={setSelectedElId}
              onMove={(id, x, y) => aktualisiereElMut.mutate({ id, x, y })}
            />
            <div className="mt-2 flex justify-end">
              <Button
                onClick={() => erstelleElMut.mutate()}
                loading={erstelleElMut.isPending}
                className="text-sm"
              >
                + Tisch hinzufügen
              </Button>
            </div>
          </div>

          {/* Eigenschaften-Panel */}
          {selectedEl && (
            <ElementPanel
              el={selectedEl}
              onUpdate={(patch) => aktualisiereElMut.mutate({ id: selectedEl.id, ...patch })}
              onDelete={() => {
                if (confirm(`Tisch „${selectedEl.bezeichnung}" löschen?`)) {
                  loescheElMut.mutate(selectedEl.id)
                }
              }}
            />
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-400">Bereich auswählen oder neu anlegen.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bereich-Tab mit Inline-Umbenennen
// ---------------------------------------------------------------------------

function BereichTab({
  bereich, aktiv, onClick, onRename, onDelete,
}: {
  bereich:  TischplanBereich
  aktiv:    boolean
  onClick:  () => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [editMode, setEditMode] = useState(false)
  const [name,     setName]     = useState(bereich.name)

  const commit = () => {
    setEditMode(false)
    if (name.trim() && name !== bereich.name) onRename(name.trim())
    else setName(bereich.name)
  }

  if (editMode) {
    return (
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className="h-8 w-32 text-xs"
      />
    )
  }

  return (
    <div className={`flex items-center rounded-full border px-3 h-8 text-sm font-medium gap-1 ${
      aktiv ? 'bg-brand-600 text-white border-brand-700' : 'bg-gray-100 text-gray-700 border-gray-300'
    }`}>
      <button type="button" onClick={onClick}>{bereich.name}</button>
      {aktiv && (
        <>
          <button type="button" onClick={() => setEditMode(true)} className="opacity-60 hover:opacity-100 text-xs pl-1">✏</button>
          <button type="button" onClick={onDelete} className="opacity-60 hover:opacity-100 text-xs">✕</button>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plan-Canvas mit Drag-&-Drop
// ---------------------------------------------------------------------------

function PlanCanvas({
  bereich, selectedElId, onSelect, onMove,
}: {
  bereich:      TischplanBereich
  selectedElId: string | null
  onSelect:     (id: string) => void
  onMove:       (id: string, x: number, y: number) => void
}) {
  const canvasRef  = useRef<HTMLDivElement>(null)
  const dragRef    = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null)

  // Lokale Positions-Überschreibung während des Drags (für flüssige Animation)
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent, el: TischplanElement) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(el.id)
    dragRef.current = { id: el.id, startX: e.clientX, startY: e.clientY, origX: el.x, origY: el.y }
    setDragging({ id: el.id, x: el.x, y: el.y })
  }, [onSelect])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const dx = ((e.clientX - dragRef.current.startX) / rect.width)  * 100
    const dy = ((e.clientY - dragRef.current.startY) / rect.height) * 100
    const newX = Math.max(0, Math.min(95, dragRef.current.origX + dx))
    const newY = Math.max(0, Math.min(95, dragRef.current.origY + dy))
    setDragging({ id: dragRef.current.id, x: newX, y: newY })
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragRef.current || !dragging) return
    onMove(dragRef.current.id, dragging.x, dragging.y)
    dragRef.current = null
    setDragging(null)
  }, [dragging, onMove])

  return (
    <div
      ref={canvasRef}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      className="relative w-full aspect-[4/3] bg-gray-50 rounded-xl border-2 border-dashed border-gray-300 overflow-hidden select-none"
    >
      {bereich.elemente.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-gray-400">Klicke auf „+ Tisch hinzufügen"</p>
        </div>
      )}

      {bereich.elemente.map((el) => {
        const isDragging = dragging?.id === el.id
        const x = isDragging ? dragging.x : el.x
        const y = isDragging ? dragging.y : el.y
        const isSelected = el.id === selectedElId

        return (
          <div
            key={el.id}
            onPointerDown={(e) => onPointerDown(e, el)}
            style={{
              position: 'absolute',
              left:   `${x}%`,
              top:    `${y}%`,
              width:  `${el.breite}%`,
              height: `${el.hoehe}%`,
              cursor: isDragging ? 'grabbing' : 'grab',
              zIndex: isSelected ? 10 : 1,
            }}
            className={`
              flex items-center justify-center border-2 text-center overflow-hidden
              transition-shadow
              ${el.form === 'rund' ? 'rounded-full' : 'rounded-lg'}
              ${FARBE_BG[el.farbe as TischplanFarbe] ?? FARBE_BG.grau}
              ${isSelected ? 'ring-2 ring-brand-500 shadow-lg' : 'hover:shadow-md'}
            `}
          >
            <span className="text-[clamp(0.5rem,1.2cqw,0.875rem)] font-semibold leading-tight px-1 truncate w-full text-center">
              {el.bezeichnung}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Eigenschaften-Panel (rechts neben dem Canvas)
// ---------------------------------------------------------------------------

function ElementPanel({
  el, onUpdate, onDelete,
}: {
  el:       TischplanElement
  onUpdate: (patch: Partial<TischplanElement>) => void
  onDelete: () => void
}) {
  return (
    <div className="w-48 shrink-0 space-y-3 bg-white rounded-lg border border-gray-200 p-3">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tisch</p>

      <label className="block">
        <span className="text-xs font-medium text-gray-600">Bezeichnung</span>
        <Input
          value={el.bezeichnung}
          onChange={(e) => onUpdate({ bezeichnung: e.target.value })}
          onBlur={(e)  => onUpdate({ bezeichnung: e.target.value.trim() || el.bezeichnung })}
          className="mt-0.5 h-8 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-gray-600">Form</span>
        <select
          value={el.form}
          onChange={(e) => onUpdate({ form: e.target.value as TischplanForm })}
          className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
          {(Object.keys(TISCHPLAN_FORM_LABELS) as TischplanForm[]).map((f) => (
            <option key={f} value={f}>{TISCHPLAN_FORM_LABELS[f]}</option>
          ))}
        </select>
      </label>

      <div>
        <span className="text-xs font-medium text-gray-600">Farbe</span>
        <div className="mt-1 grid grid-cols-4 gap-1">
          {ALLE_FARBEN.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onUpdate({ farbe: f })}
              title={TISCHPLAN_FARBE_LABELS[f]}
              className={`h-6 w-full rounded border-2 transition ${FARBE_BG[f]} ${
                el.farbe === f ? 'ring-2 ring-brand-500' : ''
              }`}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Breite %</span>
          <Input
            type="number" min="4" max="40"
            value={Math.round(el.breite)}
            onChange={(e) => onUpdate({ breite: Number(e.target.value) })}
            className="mt-0.5 h-8 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Höhe %</span>
          <Input
            type="number" min="4" max="40"
            value={Math.round(el.hoehe)}
            onChange={(e) => onUpdate({ hoehe: Number(e.target.value) })}
            className="mt-0.5 h-8 text-sm"
          />
        </label>
      </div>

      <Button
        variant="secondary"
        onClick={onDelete}
        className="w-full text-xs text-red-600 border-red-200 hover:bg-red-50"
      >
        Tisch löschen
      </Button>
    </div>
  )
}
