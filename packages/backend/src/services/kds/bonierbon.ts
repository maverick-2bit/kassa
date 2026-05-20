/**
 * Generator für Bonierbons im Asello-Klartextformat.
 *
 * Format (vom existierenden KDS in C:\kds geparst):
 *   ─────────────────────────────────────────
 *   Nummer          Bonierbon       <AsCode>
 *   <HH:MM:SS>                        <DD.MM.YYYY>
 *   Bereich: <Bereich> / T<Tisch>
 *   <Belegnummer 2-stellig>
 *   Benutzer: <Kellner>
 *   <Menge> <Bezeichnung>[ - <Details>]
 *   ...
 *   Bonierbon - Keine Rechnung!
 *   ─────────────────────────────────────────
 *
 * Der KDS-Parser sucht:
 *   - `[A-Z]{2,3}\d{6,}` als Bonnummer
 *   - `Bonierbon|Storno|Rechnung` als Typ-Marker
 *   - Zeilen mit `Bereich:`, `Benutzer:`, `Kellner:`
 *   - Positionen mit `^\d+\s+\S` (z. B. "2 Bier 0,5l")
 */

export interface BonierbonInput {
  bonNummer:   string
  belegnummer: number
  uhrzeit:     Date
  tisch:       string
  bereich?:    string | undefined
  kellner:     string
  positionen: Array<{
    menge:       number
    bezeichnung: string
    details?:    string | undefined
  }>
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatUhrzeit(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function formatDatum(d: Date): string {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`
}

export function baueBonierbon(input: BonierbonInput): string {
  const uhrzeit = formatUhrzeit(input.uhrzeit)
  const datum   = formatDatum(input.uhrzeit)

  // "Bereich: Innen / T5" oder nur "Bereich: T5" wenn kein bereich
  const bereichTeil = input.bereich
    ? `${input.bereich} / T${input.tisch}`
    : `T${input.tisch}`

  const lines: string[] = [
    // Asello-typische Ausrichtung mit Spaces
    `Nummer          Bonierbon       ${input.bonNummer}`,
    `${uhrzeit}                        ${datum}`,
    `Bereich: ${bereichTeil}`,
    pad2(input.belegnummer % 100),
    `Benutzer: ${input.kellner}`,
    ...input.positionen.map((p) =>
      p.details
        ? `${p.menge} ${p.bezeichnung} - ${p.details}`
        : `${p.menge} ${p.bezeichnung}`,
    ),
    'Bonierbon - Keine Rechnung!',
  ]

  return lines.join('\n') + '\n'
}

/**
 * Generiert eine Bonnummer im Asello-Format: "AE" + 9-stellige Zahl aus Zeit.
 * Stabil pro Bonierung (alle Stationen bekommen dieselbe Nummer).
 */
export function generiereBonNummer(prefix = 'AE'): string {
  const now = Date.now() % 10_000_000_000 // 10 stellig
  return `${prefix}${now.toString().padStart(10, '0').slice(-9)}`
}
