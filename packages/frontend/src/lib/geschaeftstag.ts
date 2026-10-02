/**
 * Geschäftstag im Frontend: „heute" und Standarddaten folgen dem Tagesbeginn des
 * Betriebs (z. B. 06:00 bis 06:00) — um 02:00 nachts ist „heute" dann noch der
 * Vortag. Gerechnet wird mit denselben Funktionen wie im Backend (@kassa/shared).
 *
 * Zwei getrennte Begriffe, bewusst verschieden benannt:
 *  - heuteGeschaeftstag()  der Tag der Auswertungen: Tagesabschluss, Berichte,
 *                          Kassenbuch, Kassensturz, Zeiterfassung, Exporte …
 *  - heuteKalendertag()    der reine Kalendertag (Wiener Zeit): Reservierungen,
 *                          Gutschein-Gültigkeit, RKSV-Begriffe …
 * Ohne eingestellten Tagesbeginn (Standard 00:00) liefern beide dasselbe.
 */

import { addTage, geschaeftstagVon, heuteGeschaeftstag as rechneGeschaeftstag, heuteKalendertagWien } from '@kassa/shared'
import { tagesRegel } from './auth'

export { addTage }

/** Der aktuelle Geschäftstag als YYYY-MM-DD. */
export function heuteGeschaeftstag(): string {
  return rechneGeschaeftstag(tagesRegel())
}

/** Der Geschäftstag davor. */
export function gesternGeschaeftstag(): string {
  return addTage(heuteGeschaeftstag(), -1)
}

/** Geschäftstag eines beliebigen Zeitpunkts (z. B. einer Schicht oder eines Belegs). */
export function geschaeftstagVonZeitpunkt(zeitpunkt: Date | string): string {
  return geschaeftstagVon(tagesRegel(), new Date(zeitpunkt))
}

/** Der Wiener KALENDERtag von heute — für alles, was kein Geschäftstag ist (Reservierung, Gültigkeitsdatum). */
export function heuteKalendertag(): string {
  return heuteKalendertagWien()
}

/** 'TT.MM.JJJJ' aus YYYY-MM-DD. */
export function datumKurz(datum: string): string {
  const [j, m, t] = datum.split('-')
  return `${t}.${m}.${j}`
}

/** 'TT.MM.' aus YYYY-MM-DD. */
export function tagMonat(datum: string): string {
  const [, m, t] = datum.split('-')
  return `${t}.${m}.`
}

/**
 * Montag der ISO-Woche zu einem Kalendertag (YYYY-MM-DD) — rein kalendarisch,
 * ohne Zeitzonen-Effekte (nicht über new Date(datum), das in UTC parst).
 */
export function montagDerWoche(datum: string): string {
  const [j, m, t] = datum.split('-').map(Number)
  const wochentag = new Date(Date.UTC(j!, m! - 1, t!)).getUTCDay() || 7   // Sonntag = 7
  return addTage(datum, -(wochentag - 1))
}

/** Letzter Tag des Monats von `datum` (YYYY-MM-DD). */
export function endeDesMonats(datum: string): string {
  const [j, m] = datum.split('-').map(Number)
  return new Date(Date.UTC(j!, m!, 0)).toISOString().slice(0, 10)
}
