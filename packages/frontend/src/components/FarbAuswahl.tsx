/**
 * FarbAuswahl — Swatch-Raster über die 20-Farben-Palette (@kassa/shared).
 * Ersetzt die früheren 8-Einträge-Dropdowns; mit `mitAutomatisch` gibt es
 * zusätzlich ein „Automatisch"-Feld (null = Farbe der Warengruppe erben).
 * Zusätzlich ein Feld „Eigene Farbe" (Farbwähler) für beliebige Hex-Werte —
 * z. B. die exakten Farben der alten Kasse.
 */

import { KATEGORIE_FARBE_HEX, KATEGORIE_FARBE_LABELS, KategorieFarbeNameSchema, farbeZuHex, type KategorieFarbe } from '@kassa/shared'

interface Props {
  wert:      KategorieFarbe | null
  onChange:  (farbe: KategorieFarbe | null) => void
  /** Zeigt ein zusätzliches „Automatisch"-Feld (null) am Anfang. */
  mitAutomatisch?: boolean
  /** Hex der geerbten Farbe fürs „Automatisch"-Feld (halbtransparent dargestellt). */
  automatischHex?: string | undefined
}

export function FarbAuswahl({ wert, onChange, mitAutomatisch = false, automatischHex }: Props) {
  const wertHex = farbeZuHex(wert)
  // Eigene Farbe = gesetzter Wert, der keiner Palettenfarbe entspricht (Name oder gleicher Hex)
  const paletteHex = Object.values(KATEGORIE_FARBE_HEX)
  const istEigene = wert !== null && wertHex !== undefined && !(wert in KATEGORIE_FARBE_HEX) && !paletteHex.includes(wertHex)

  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
      {KategorieFarbeNameSchema.options.map(f => {
        const aktiv = wert === f || (wertHex !== undefined && wert !== null && !(wert in KATEGORIE_FARBE_HEX) && wertHex === KATEGORIE_FARBE_HEX[f])
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
      <label
        title="Eigene Farbe (beliebiger Farbton)"
        className={`relative inline-flex h-8 items-center gap-1.5 rounded-lg border-2 pl-1 pr-2 text-[11px] font-medium text-ink-muted cursor-pointer transition ${
          istEigene ? 'border-ink ring-2 ring-brand-500' : 'border-line hover:border-line-strong'
        }`}
      >
        <input
          type="color"
          aria-label="Eigene Farbe"
          value={wertHex ?? '#637685'}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
        />
        Eigene Farbe
      </label>
    </div>
  )
}
