/**
 * Reine Rechenfunktionen für den Kassen-Warenkorb.
 *
 * Aus KassePage extrahiert, damit die geld-kritische Mathematik (Summen,
 * Modifikator-Aufschläge, Rabatte, Bar-/Karten-Aufteilung, Wechselgeld)
 * isoliert und ausgiebig testbar ist — ohne React/DOM.
 *
 * Verhalten ist 1:1 identisch zur bisherigen Inline-Logik der KassePage.
 * Alle Beträge in Cent (Integer), nie Float.
 */

import type { RabattInput } from '@kassa/shared'

/** Aufsummierter Aufschlag gewählter Modifikator-Optionen. */
export function modifikatorAufschlagCent(modifikatoren: { aufschlagCent: number }[]): number {
  return modifikatoren.reduce((s, m) => s + m.aufschlagCent, 0)
}

/** Effektiver Positionspreis = Artikel-Bruttopreis + Summe der Modifikator-Aufschläge. */
export function positionsPreisCent(
  artikelPreisBruttoCent: number,
  modifikatoren: { aufschlagCent: number }[],
): number {
  return artikelPreisBruttoCent + modifikatorAufschlagCent(modifikatoren)
}

/** Warenkorb-Zwischensumme: Σ (preisCent × menge). */
export function warenkorbSummeCent(positionen: { preisCent: number; menge: number }[]): number {
  return positionen.reduce((sum, p) => sum + p.preisCent * p.menge, 0)
}

/**
 * Rabattbetrag auf eine Basis. Prozent wird kaufmännisch gerundet, ein
 * fixer Betrag auf die Basis gedeckelt. 0 bei fehlendem Rabatt oder Basis 0.
 */
export function rabattBetragCent(basisCent: number, rabatt: RabattInput | null | undefined): number {
  // Auf Null oder eine negative Basis (Retoure/Pfand-Rückgabe) gibt es keinen Rabatt
  if (!rabatt || basisCent <= 0) return 0
  if (rabatt.typ === 'prozent') return Math.round(basisCent * rabatt.prozent / 100)
  return Math.min(rabatt.betragCent, basisCent)
}

/**
 * Gesamtrabatt wie ihn das Backend rechnet (beleg.service): Prozent je MwSt-Satz auf die
 * Satz-Summe, aber nur für Sätze mit positiver Summe (Pfand-Rückgabe wird nie „rabattiert");
 * fixer Betrag auf die Gesamtsumme gedeckelt, bei Summe ≤ 0 kein Rabatt.
 * Muss mit dem Backend übereinstimmen — sonst passt die Zahlungssumme nicht zum Beleg.
 */
export function gesamtRabattCent(
  positionen: { preisCent: number; menge: number; mwstSatz: string }[],
  rabatt: RabattInput | null | undefined,
): number {
  if (!rabatt) return 0
  if (rabatt.typ === 'betrag') return rabattBetragCent(warenkorbSummeCent(positionen), rabatt)
  const nachSatz = new Map<string, number>()
  for (const p of positionen) nachSatz.set(p.mwstSatz, (nachSatz.get(p.mwstSatz) ?? 0) + p.preisCent * p.menge)
  let summe = 0
  for (const s of nachSatz.values()) if (s > 0) summe += Math.round(s * rabatt.prozent / 100)
  return summe
}

/** Zwischensumme nach Gesamtrabatt. */
export function summeNachRabattCent(summeCent: number, rabatt: RabattInput | null | undefined): number {
  return summeCent - rabattBetragCent(summeCent, rabatt)
}

/** Positionspreis nach Anwendung eines Positionsrabatts (nie < 0). */
export function preisNachPositionsRabattCent(originalPreisCent: number, rabatt: RabattInput): number {
  // Negativpreise (Pfand-Rückgabe) bleiben, wie sie sind
  if (originalPreisCent <= 0) return originalPreisCent
  return Math.max(0, originalPreisCent - rabattBetragCent(originalPreisCent, rabatt))
}

/** Verbleibender Betrag nach Gutschein-Einlösung (nie < 0). */
export function summeNachGutscheinCent(summeNachRabattCent: number, gutscheinCent: number): number {
  // Ohne Gutschein bleibt auch eine negative Summe (Retoure) erhalten
  if (gutscheinCent <= 0) return summeNachRabattCent
  return Math.max(0, summeNachRabattCent - gutscheinCent)
}

/**
 * Bar-Eingabe (Euro-String mit Komma/Punkt) → Cent.
 * Ungültig oder negativ → 0. (Entspricht der bisherigen KassePage-Logik;
 * absichtlich toleranter/anders als parseEuroToCent in format.ts.)
 */
export function barEingabeCent(eingabe: string): number {
  const v = parseFloat(eingabe.replace(',', '.'))
  return isNaN(v) || v < 0 ? 0 : Math.round(v * 100)
}

export interface ZahlungsAufteilung {
  /** Bar-Anteil auf dem Beleg (max. der offene Betrag). */
  barCentBeleg:    number
  /** Karten-Anteil = Rest nach Bar. */
  karteCentBeleg:  number
  /** Wechselgeld — nur zur Anzeige, nicht auf dem Beleg. */
  wechselgeldCent: number
}

/**
 * Teilt den offenen Betrag in Bar/Karte auf und berechnet das Wechselgeld.
 * Bar wird auf den offenen Betrag gedeckelt; der Rest geht auf Karte; ein
 * Bar-Überschuss ist Wechselgeld.
 */
export function zahlungsAufteilung(offenerBetragCent: number, barEingabeCent: number): ZahlungsAufteilung {
  // Rückzahlung (negative Summe): alles bar zurück, kein Wechselgeld
  if (offenerBetragCent < 0) return { barCentBeleg: offenerBetragCent, karteCentBeleg: 0, wechselgeldCent: 0 }
  const barCentBeleg = Math.min(barEingabeCent, offenerBetragCent)
  return {
    barCentBeleg,
    karteCentBeleg:  offenerBetragCent - barCentBeleg,
    wechselgeldCent: Math.max(0, barEingabeCent - offenerBetragCent),
  }
}
