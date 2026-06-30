/**
 * Reine Rechenfunktionen für TischTab-Summen und das Aufteilen (Splitten)
 * einer Rechnung auf mehrere Zahler.
 *
 * Aus TischTabPage extrahiert, damit die geld-kritische Mathematik isoliert
 * und ausgiebig testbar ist — ohne React/DOM. Die Gesamtsumme/Rabatt- und
 * Warenkorb-Logik liegt bereits in `warenkorb.ts`; dieses Modul ergänzt die
 * TischTab-spezifischen Teile: Tab-Summen mit Positions-Rabatten, die
 * Split-Validierung (Mengenverteilung + Bar/Karte je Zahler) und die
 * Rabatt-Einzelpreis-Berechnung des Artikel-Rabatt-Dialogs.
 *
 * Verhalten ist 1:1 identisch zur bisherigen Inline-Logik der TischTabPage.
 * Alle Beträge in Cent (Integer), nie Float.
 */

/** Minimale Form einer Tab-Position für die Rechen-Funktionen. */
export interface TabPositionLike {
  bezeichnung:     string
  menge:           number
  preisBruttoCent: number
}

/** Minimale Form eines Zahlers im Split-Dialog. */
export interface SplitZahlerLike {
  /** positionsIndex → zugewiesene Menge */
  mengen:   Record<number, number>
  barInput: string
  karte:    string
}

/** Tab-Summe ohne Rabatte: Σ (preisBruttoCent × menge). */
export function positionsSummeCent(positionen: { preisBruttoCent: number; menge: number }[]): number {
  return positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)
}

/**
 * Tab-Summe inklusive Positions-Rabatten: je Position der rabattierte
 * Einzelpreis (`posRabatte[i]`, falls gesetzt) × menge, sonst der Bruttopreis.
 */
export function summeMitPosRabattenCent(
  positionen: { preisBruttoCent: number; menge: number }[],
  posRabatte: Record<number, number>,
): number {
  return positionen.reduce((s, p, i) => s + (posRabatte[i] ?? p.preisBruttoCent) * p.menge, 0)
}

/** Cent-Eingabe aus reinem Ziffern-String. Leer oder ungültig → 0. */
export function zahlungCent(input: string): number {
  return parseInt(input || '0', 10) || 0
}

/** Subtotal eines Zahlers: Σ (preisBruttoCent × zugewiesene Menge). */
export function zahlerSubtotalCent(
  positionen: { preisBruttoCent: number }[],
  mengen: Record<number, number>,
): number {
  return positionen.reduce((s, p, i) => s + p.preisBruttoCent * (mengen[i] ?? 0), 0)
}

export interface SplitValidierung {
  /** Positionen, deren zugewiesene Gesamtmenge nicht der Soll-Menge entspricht. */
  positionsfehler: string[]
  /** Zahler, deren Bar+Karte nicht dem eigenen Subtotal entsprechen. */
  zahlungsfehler:  string[]
  /** Zahler mit mindestens einer zugewiesenen Position (alle anderen werden ignoriert). */
  zahlerMitPositionen: SplitZahlerLike[]
  /** true, wenn alle Positionen verteilt sind, alle Zahlungen stimmen und ≥ 2 Zahler zahlen. */
  kannSubmit: boolean
}

/**
 * Validiert eine Rechnungsaufteilung. Prüft, dass jede Position vollständig
 * (nicht über-/unterverteilt) auf die Zahler aufgeteilt ist und dass für jeden
 * zahlenden Zahler Bar + Karte exakt seinem Subtotal entspricht. Ein Split ist
 * nur abschickbar, wenn beides stimmt und mindestens zwei Zahler beteiligt sind.
 *
 * `formatPreis` wird nur für die menschenlesbaren Fehlertexte verwendet.
 */
export function splitValidierung(
  positionen: TabPositionLike[],
  zahler: SplitZahlerLike[],
  formatPreis: (cent: number) => string,
): SplitValidierung {
  const positionsfehler: string[] = []
  for (const [posIdx, p] of positionen.entries()) {
    const zugewiesen = zahler.reduce((s, z) => s + (z.mengen[posIdx] ?? 0), 0)
    if (zugewiesen !== p.menge) {
      positionsfehler.push(`${p.bezeichnung}: ${zugewiesen} von ${p.menge} zugewiesen`)
    }
  }

  const zahlerMitPositionen = zahler.filter(z =>
    positionen.some((_, i) => (z.mengen[i] ?? 0) > 0),
  )

  const zahlungsfehler: string[] = []
  for (const z of zahlerMitPositionen) {
    const subtotal = zahlerSubtotalCent(positionen, z.mengen)
    const summe    = zahlungCent(z.barInput) + zahlungCent(z.karte)
    if (summe !== subtotal) {
      zahlungsfehler.push(`Zahler ${zahler.indexOf(z) + 1}: ${formatPreis(summe)} statt ${formatPreis(subtotal)}`)
    }
  }

  const kannSubmit =
    positionsfehler.length === 0 &&
    zahlungsfehler.length === 0 &&
    zahlerMitPositionen.length >= 2

  return { positionsfehler, zahlungsfehler, zahlerMitPositionen, kannSubmit }
}

/**
 * Neuer absoluter Einzelpreis nach einem Positions-Rabatt (in Cent, nie < 0).
 * Gibt `null` zurück, wenn die Eingabe ungültig ist — Prozent ≤ 0 oder > 100,
 * bzw. fixer Betrag ≤ 0 — damit der Aufrufer den Rabatt verwirft.
 */
export function rabattierterEinzelpreisCent(
  basisCent: number,
  typ: 'prozent' | 'betrag',
  wert: number,
): number | null {
  if (typ === 'prozent') {
    if (wert <= 0 || wert > 100) return null
    return Math.max(0, basisCent - Math.round(basisCent * wert / 100))
  }
  if (wert <= 0) return null
  return Math.max(0, basisCent - wert)
}
