/**
 * FarbAuswahl — Swatch-Raster über die 20-Farben-Palette (@kassa/shared).
 * Ersetzt die früheren 8-Einträge-Dropdowns; mit `mitAutomatisch` gibt es
 * zusätzlich ein „Automatisch"-Feld (null = Farbe der Warengruppe erben).
 */

import { KATEGORIE_FARBE_HEX, KATEGORIE_FARBE_LABELS, KategorieFarbeSchema, type KategorieFarbe } from '@kassa/shared'

interface Props {
  wert:      KategorieFarbe | null
  onChange:  (farbe: KategorieFarbe | null) => void
  /** Zeigt ein zusätzliches „Automatisch"-Feld (null) am Anfang. */
  mitAutomatisch?: boolean
  /** Hex der geerbten Farbe fürs „Automatisch"-Feld (halbtransparent dargestellt). */
  automatischHex?: string | undefined
}

export function FarbAuswahl({ wert, onChange, mitAutomatisch = false, automatischHex }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {mitAutomatisch && (
        <button
          type="button"
          onClick={() => onChange(null)}
          title={`Automatisch — Farbe der Warengruppe${automatischHex ? '' : ' (keine gesetzt)'}`}
          className={`h-8 w-8 rounded-lg border-2 text-[10px] font-bold leading-none flex items-center justify-center transition ${
            wert === null ? 'border-ink ring-2 ring-brand-500' : 'border-line hover:border-line-strong'
          }`}
          style={automatischHex ? { backgroundColor: `${automatischHex}55` } : {}}
        >
          A
        </button>
      )}
      {KategorieFarbeSchema.options.map(f => {
        const aktiv = wert === f
        return (
          <button
            key={f}
            type="button"
            onClick={() => onChange(f)}
            title={KATEGORIE_FARBE_LABELS[f]}
            className={`h-8 w-8 rounded-lg border-2 transition hover:scale-110 ${
              aktiv ? 'border-ink ring-2 ring-brand-500' : 'border-transparent'
            }`}
            style={{ backgroundColor: KATEGORIE_FARBE_HEX[f] }}
          >
            {aktiv && <span className="text-white text-xs font-black drop-shadow">✓</span>}
          </button>
        )
      })}
    </div>
  )
}
