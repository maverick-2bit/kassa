/**
 * Format-Hilfen für die deutsche/österreichische Anzeige.
 */

const formatter = new Intl.NumberFormat('de-AT', {
  style:    'currency',
  currency: 'EUR',
})

export function formatPreis(cent: number): string {
  return formatter.format(cent / 100)
}

/**
 * Parst eine Euro-Eingabe (mit Komma oder Punkt) in Cent.
 * Liefert null bei ungültiger Eingabe.
 */
export function parseEuroToCent(input: string): number | null {
  if (!input.trim()) return null
  const normalized = input.replace(/\s/g, '').replace(',', '.')
  const num = parseFloat(normalized)
  if (Number.isNaN(num) || !Number.isFinite(num)) return null
  return Math.round(num * 100)
}

/**
 * LOKALES Kalenderdatum als YYYY-MM-DD. NICHT über toISOString() lösen — das ist
 * UTC und liefert in UTC+1/+2 vor 1/2 Uhr früh den VORTAG (bzw. verschiebt lokale
 * Mitternachts-Dates um einen Tag; Sonntags-Bug im Dienstplan).
 */
export function lokalYMD(datum: Date): string {
  const j = datum.getFullYear()
  const m = String(datum.getMonth() + 1).padStart(2, '0')
  const t = String(datum.getDate()).padStart(2, '0')
  return `${j}-${m}-${t}`
}

/** Heutiges LOKALES Datum als YYYY-MM-DD. */
export function heuteLokalYMD(): string {
  return lokalYMD(new Date())
}

export function formatDatum(isoDate: string): string {
  return new Date(isoDate).toLocaleString('de-AT', {
    day:   '2-digit',
    month: '2-digit',
    year:  'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  })
}
