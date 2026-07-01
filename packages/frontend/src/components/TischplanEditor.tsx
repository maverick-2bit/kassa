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
  grau:   'bg-panel-2 border-line-strong',
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

  if (isLoading) return <p className="text-sm text-ink-muted">Wird geladen…</p>

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
              onMove={(id, x, y)           => aktualisiereElMut.mutate({ id, x, y })}
              onResize={(id, breite, hoehe) => aktualisiereElMut.mutate({ id, breite, hoehe })}
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
        <p className="text-sm text-ink-subtle">Bereich auswählen oder neu anlegen.</p>
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
      aktiv ? 'bg-brand-600 text-white border-brand-700' : 'bg-panel-2 text-ink border-line-strong'
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
  bereich, selectedElId, onSelect, onMove, onResize,
}: {
  bereich:      TischplanBereich
  selectedElId: string | null
  onSelect:     (id: string) => void
  onMove:       (id: string, x: number, y: number) => void
  onResize:     (id: string, breite: number, hoehe: number) => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)

  const dragRef   = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ id: string; startX: number; startY: number; origB: number; origH: number } | null>(null)

  type LocalState = { x?: number; y?: number; breite?: number; hoehe?: number }
  const [local, setLocal] = useState<Map<string, LocalState>>(new Map())

  const getRect = () => canvasRef.current?.getBoundingClientRect()

  // ── Drag (Verschieben) ──────────────────────────────────────────────────────
  const onElPointerDown = useCallback((e: React.PointerEvent, el: TischplanElement) => {
    if ((e.target as HTMLElement).dataset.resize) return  // Resize-Handle → nicht drag
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(el.id)
    dragRef.current = { id: el.id, startX: e.clientX, startY: e.clientY, origX: el.x, origY: el.y }
    setLocal(prev => { const m = new Map(prev); m.set(el.id, { x: el.x, y: el.y }); return m })
  }, [onSelect])

  // ── Resize-Handle ────────────────────────────────────────────────────────────
  const onResizePointerDown = useCallback((e: React.PointerEvent, el: TischplanElement) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(el.id)
    resizeRef.current = { id: el.id, startX: e.clientX, startY: e.clientY, origB: el.breite, origH: el.hoehe }
    setLocal(prev => { const m = new Map(prev); m.set(el.id, { breite: el.breite, hoehe: el.hoehe }); return m })
  }, [onSelect])

  // ── Pointer Move (Canvas-Level) ──────────────────────────────────────────────
  const onCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    const rect = getRect()
    if (!rect) return

    if (dragRef.current) {
      const d = dragRef.current
      const dx = ((e.clientX - d.startX) / rect.width)  * 100
      const dy = ((e.clientY - d.startY) / rect.height) * 100
      const nx = Math.max(0, Math.min(95, d.origX + dx))
      const ny = Math.max(0, Math.min(95, d.origY + dy))
      setLocal(prev => { const m = new Map(prev); m.set(d.id, { x: nx, y: ny }); return m })
    }

    if (resizeRef.current) {
      const r = resizeRef.current
      const dx = ((e.clientX - r.startX) / rect.width)  * 100
      const dy = ((e.clientY - r.startY) / rect.height) * 100
      const nb = Math.max(4, Math.min(40, r.origB + dx))
      const nh = Math.max(4, Math.min(40, r.origH + dy))
      setLocal(prev => { const m = new Map(prev); m.set(r.id, { breite: nb, hoehe: nh }); return m })
    }
  }, [])

  const onCanvasPointerUp = useCallback(() => {
    if (dragRef.current) {
      const d = dragRef.current
      const l = local.get(d.id)
      if (l?.x !== undefined && l?.y !== undefined) onMove(d.id, l.x, l.y)
      dragRef.current = null
      setLocal(prev => { const m = new Map(prev); m.delete(d.id); return m })
    }
    if (resizeRef.current) {
      const r = resizeRef.current
      const l = local.get(r.id)
      if (l?.breite !== undefined && l?.hoehe !== undefined) onResize(r.id, l.breite, l.hoehe)
      resizeRef.current = null
      setLocal(prev => { const m = new Map(prev); m.delete(r.id); return m })
    }
  }, [local, onMove, onResize])

  return (
    <div
      ref={canvasRef}
      onPointerMove={onCanvasPointerMove}
      onPointerUp={onCanvasPointerUp}
      onPointerLeave={onCanvasPointerUp}
      className="relative w-full aspect-[4/3] bg-panel-2 rounded-xl border-2 border-dashed border-line-strong overflow-hidden select-none"
    >
      {bereich.elemente.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-ink-subtle">Klicke auf „+ Tisch hinzufügen"</p>
        </div>
      )}

      {bereich.elemente.map((el) => {
        const l          = local.get(el.id) ?? {}
        const x          = l.x      ?? el.x
        const y          = l.y      ?? el.y
        const breite     = l.breite ?? el.breite
        const hoehe      = l.hoehe  ?? el.hoehe
        const isSelected = el.id === selectedElId
        const isDragging = dragRef.current?.id === el.id
        const isResizing = resizeRef.current?.id === el.id

        return (
          <div
            key={el.id}
            onPointerDown={(e) => onElPointerDown(e, el)}
            style={{
              position: 'absolute',
              left:     `${x}%`,
              top:      `${y}%`,
              width:    `${breite}%`,
              height:   `${hoehe}%`,
              cursor:   isDragging ? 'grabbing' : 'grab',
              zIndex:   isSelected ? 10 : 1,
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

            {/* Resize-Handle (rechts unten) — nur wenn selektiert */}
            {isSelected && (
              <div
                data-resize="1"
                onPointerDown={(e) => onResizePointerDown(e, el)}
                style={{ cursor: isResizing ? 'se-resize' : 'se-resize' }}
                className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-sm bg-brand-500 opacity-80 hover:opacity-100 transition-opacity"
                title="Größe ändern"
              />
            )}
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
    <div className="w-48 shrink-0 space-y-3 bg-panel rounded-lg border border-line p-3">
      <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Tisch</p>

      <label className="block">
        <span className="text-xs font-medium text-ink-muted">Bezeichnung</span>
        <Input
          value={el.bezeichnung}
          onChange={(e) => onUpdate({ bezeichnung: e.target.value })}
          onBlur={(e)  => onUpdate({ bezeichnung: e.target.value.trim() || el.bezeichnung })}
          className="mt-0.5 h-8 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-ink-muted">Form</span>
        <select
          value={el.form}
          onChange={(e) => onUpdate({ form: e.target.value as TischplanForm })}
          className="mt-0.5 w-full rounded-md border border-line-strong px-2 py-1 text-sm"
        >
          {(Object.keys(TISCHPLAN_FORM_LABELS) as TischplanForm[]).map((f) => (
            <option key={f} value={f}>{TISCHPLAN_FORM_LABELS[f]}</option>
          ))}
        </select>
      </label>

      <div>
        <span className="text-xs font-medium text-ink-muted">Farbe</span>
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
          <span className="text-xs font-medium text-ink-muted">Breite %</span>
          <Input
            type="number" min="4" max="40"
            value={Math.round(el.breite)}
            onChange={(e) => onUpdate({ breite: Number(e.target.value) })}
            className="mt-0.5 h-8 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-muted">Höhe %</span>
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
