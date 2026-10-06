/**
 * TeilbaumKnopf — kleiner Knopf „samt Untergruppen" neben dem Haken/Schalter einer Warengruppe mit Untergruppen.
 *
 * Ein Haken gilt immer NUR für seine Gruppe. Dieser Knopf ist der Komfort für den anderen Fall: die Gruppe und
 * alle ihre Untergruppen auf einmal ein- bzw. ausschalten (Logik: `toggleTeilbaum` in lib/sichtbarkeit).
 */

import { SICHTBARKEIT_TEXTE } from '../lib/sichtbarkeit'

interface Props {
  onClick:   () => void
  /** Zugänglicher Name (Gruppe + Kasse) */
  label:     string
  disabled?: boolean
  /** In ziehbaren Zeilen: den Zeiger-Druck nicht an den Drag-Sensor weitergeben */
  stopDrag?: boolean
}

export function TeilbaumKnopf({ onClick, label, disabled = false, stopDrag = false }: Props) {
  return (
    <button
      type="button"
      data-testid="teilbaum-knopf"
      aria-label={label}
      title={SICHTBARKEIT_TEXTE.teilbaumTitel}
      disabled={disabled}
      {...(stopDrag ? { onPointerDown: (e: React.PointerEvent) => e.stopPropagation() } : {})}
      onClick={onClick}
      className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-ink-subtle transition hover:bg-panel-2 hover:text-brand-700 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {/* Teilbaum: eine Gruppe mit zwei Untergruppen */}
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="7" y="2" width="6" height="4" rx="1" />
        <rect x="2" y="14" width="6" height="4" rx="1" />
        <rect x="12" y="14" width="6" height="4" rx="1" />
        <path d="M10 6v3M5 14v-3h10v3" />
      </svg>
    </button>
  )
}
