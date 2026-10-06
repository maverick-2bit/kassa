/**
 * SichtbarkeitsHaken — Checkbox mit Halbzustand für die Sichtbarkeit einer Warengruppe an einer Kasse.
 *
 *   an     → angehakt (die Gruppe ist gewählt: ihre eigenen Artikel erscheinen an der Kasse)
 *   zugang → Indeterminate-Haken (nicht selbst gewählt, aber eine Untergruppe ist gewählt: die Gruppe bleibt
 *            als reiner Zugang sichtbar, ohne eigene Artikel)
 *   aus    → leer
 * Ein Haken gilt immer nur für seine Gruppe — Untergruppen werden einzeln gewählt.
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
      ref={(el) => { if (el) el.indeterminate = zustand === 'zugang' }}
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
