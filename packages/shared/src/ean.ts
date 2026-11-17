/**
 * EAN/GTIN als Artikelkennzeichnung.
 *
 * Zulässig sind die GS1-Längen EAN-8, UPC-A (12), EAN-13 und GTIN-14 — nur Ziffern, mit gültiger
 * Prüfziffer (Modulo 10, Gewichte 3/1 von rechts). Hausinterne Codes (Präfix 20–29) sind
 * normale EAN-13 und gehen ebenso.
 *
 * Vergleich und Eindeutigkeit laufen über den GTIN-14-Schlüssel (links mit Nullen auf 14
 * Stellen aufgefüllt): Ein Scanner liefert dieselbe UPC-A je nach Einstellung 12- oder
 * 13-stellig ("012345678905" bzw. "0012345678905") — beides ist derselbe Artikel. Die
 * Datenbank prüft dieselbe Regel (Index auf lpad(ean, 14, '0'), Migration 0085).
 */

export const EAN_LAENGEN = [8, 12, 13, 14] as const

/** Prüfziffer (letzte Stelle) einer GTIN beliebiger Länge berechnen — `ohnePruefziffer` nur Ziffern. */
export function eanPruefziffer(ohnePruefziffer: string): number {
  let summe = 0
  for (let i = 0; i < ohnePruefziffer.length; i++) {
    // Von rechts gezählt: die Stelle direkt vor der Prüfziffer hat Gewicht 3
    const ziffer = ohnePruefziffer.charCodeAt(ohnePruefziffer.length - 1 - i) - 48
    summe += ziffer * (i % 2 === 0 ? 3 : 1)
  }
  return (10 - (summe % 10)) % 10
}

/** Fehlertext für eine ungültige EAN, `null` = gültig. Erwartet schon getrimmten Text. */
export function eanFehler(ean: string): string | null {
  if (!/^\d+$/.test(ean)) return 'EAN darf nur Ziffern enthalten'
  if (!(EAN_LAENGEN as readonly number[]).includes(ean.length)) {
    return 'EAN muss 8, 12, 13 oder 14 Stellen haben'
  }
  if (eanPruefziffer(ean.slice(0, -1)) !== Number(ean.slice(-1))) {
    return 'EAN-Prüfziffer stimmt nicht — bitte die Nummer kontrollieren'
  }
  return null
}

export function istGueltigeEan(ean: string): boolean {
  return eanFehler(ean) === null
}

/** Vergleichsschlüssel: GTIN-14 (links mit Nullen aufgefüllt). Für Suche und Eindeutigkeit. */
export function eanSchluessel(ean: string): string {
  return ean.trim().padStart(14, '0')
}

