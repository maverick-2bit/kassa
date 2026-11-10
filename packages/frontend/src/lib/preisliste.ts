/**
 * preisliste.ts — Sonderpreise eines Kunden im Warenkorb der Kasse.
 *
 * Reine Funktionen. Regeln:
 *  - Hat der gewählte Kunde eine Preisliste mit Eintrag für den Artikel, gilt dieser Listenpreis als Basispreis.
 *    Er ERSETZT den Artikelpreis; zeitgesteuerte Aktionen (Happy Hour) kommen dann nicht zusätzlich dazu.
 *  - Artikel ohne Eintrag (und Negativpreise wie Pfand-Rückgabe) behalten ihren normalen Preis samt Aktion.
 *  - Aufschläge aus Optionen kommen zum Basispreis dazu — wie beim normalen Preis.
 *  - Beim Wechsel/Entfernen des Kunden werden bestehende Positionen neu bepreist; Positionen mit von Hand
 *    gegebenem Rabatt (Preis ≠ Originalpreis) bleiben unverändert, damit nichts still überschrieben wird.
 */

import type { PreislisteFuerKunde } from '@kassa/shared'
import { positionsPreisCent } from './warenkorb'

export type ListenPreise = ReadonlyMap<string, number>

/** Antwort der API → Nachschlage-Tabelle artikelId → Cent (null = keine Preisliste) */
export function listenPreise(antwort: PreislisteFuerKunde | undefined): ListenPreise | null {
  if (!antwort || antwort.preise.length === 0) return null
  return new Map(antwort.preise.map(p => [p.artikelId, p.preisBruttoCent] as const))
}

/** Listenpreis eines Artikels, sonst null. Negativpreise (Pfand-Rückgabe) werden nie überschrieben. */
export function listenPreisFuer(liste: ListenPreise | null, artikel: { id: string; preisBruttoCent: number }): number | null {
  if (!liste || artikel.preisBruttoCent < 0) return null
  return liste.get(artikel.id) ?? null
}

export interface BepreisbarePosition {
  typ:               'artikel'
  artikel:           { id: string; preisBruttoCent: number }
  modifikatoren:     { aufschlagCent: number }[]
  preisCent:         number
  originalPreisCent: number
  happyHourProzent:  number
}

/**
 * Bepreist die Artikel-Positionen des Warenkorbs neu. `aktionsBasis` liefert für einen Artikel ohne Listenpreis
 * den normalen Basispreis samt Happy-Hour-Prozent (so wie die Kasse ihn beim Hinzufügen berechnet).
 * Gibt dasselbe Array zurück, wenn sich nichts ändert (kein unnötiges Neuzeichnen).
 */
export function korbNeuBepreisen<T extends { typ: string }>(
  korb: T[],
  liste: ListenPreise | null,
  aktionsBasis: (artikel: { id: string; preisBruttoCent: number }) => { basisCent: number; happyHourProzent: number },
): T[] {
  let geaendert = false
  const neu = korb.map(p => {
    if (p.typ !== 'artikel') return p
    const pos = p as unknown as BepreisbarePosition
    if (pos.preisCent !== pos.originalPreisCent) return p            // Rabatt von Hand: nicht anfassen
    const listenCent = listenPreisFuer(liste, pos.artikel)
    const { basisCent, happyHourProzent } = listenCent !== null
      ? { basisCent: listenCent, happyHourProzent: 0 }
      : aktionsBasis(pos.artikel)
    const preisCent = positionsPreisCent(basisCent, pos.modifikatoren)
    if (preisCent === pos.preisCent && happyHourProzent === pos.happyHourProzent) return p
    geaendert = true
    return { ...p, preisCent, originalPreisCent: preisCent, happyHourProzent } as T
  })
  return geaendert ? neu : korb
}
