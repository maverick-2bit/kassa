/**
 * SichtbarkeitsHaken — Checkbox mit Halbzustand für die Sichtbarkeit einer Warengruppe an einer Kasse.
 *
 *   an        → angehakt
 *   teilweise → Indeterminate-Haken (nur einzelne Untergruppen sind an; die Gruppe bleibt als Zugang sichtbar)
 *   aus       → leer
 * Die Logik dahinter steht in lib/sichtbarkeit.ts (gemeinsam mit der POS-Konfiguration).
 */

import type { SichtbarkeitsZustand } from '../lib/sichtbarkeit'

interface Props {
  zustand:   SichtbarkeitsZustand
  onChange:  () => void
  disabled?: boolean
  /** Zugänglicher Name (Gruppe + Kasse) */
  label:     string
  title?:    string
}

export function SichtbarkeitsHaken({ zustand, onChange, disabled = false, label, title }: Props) {
  return (
    <input
      type="checkbox"
      // „indeterminate" ist nur als DOM-Eigenschaft setzbar, nicht als Attribut
      ref={(el) => { if (el) el.indeterminate = zustand === 'teilweise' }}
      checked={zustand === 'an'}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      data-zustand={zustand}
      {...(title ? { title } : {})}
      className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500 disabled:opacity-40 disabled:cursor-not-allowed"
    />
  )
}
