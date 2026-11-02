/**
 * Wiener Ortszeit — unabhängig von der Zeitzone des Prozesses.
 *
 * Die RKSV verlangt für „Beleg-Datum-Uhrzeit" österreichische Lokalzeit
 * (Anlage 1 Z 4: ISO 8601 ohne Zeitzone, „es wird immer von österreichischer
 * Lokalzeit ausgegangen"). `Date.getHours()` & Co. liefern aber die Zeit der
 * ZEITZONE DES PROZESSES: Ein Docker-Container ohne `TZ` läuft in UTC, und
 * Uhrzeit und Tag im QR-Code und auf dem Bon wären 1 bis 2 Stunden daneben.
 *
 * Deshalb wird hier ausschließlich über `Intl` mit fester Zone gerechnet; das
 * Ergebnis hängt nur vom Zeitpunkt ab, nie von `TZ`, nie von der Maschine.
 */

const WIEN = 'Europe/Vienna'

/**
 * EIN wiederverwendeter Formatter — ein neuer je Aufruf wäre um Größenordnungen
 * langsamer. `hourCycle: 'h23'` (nicht `hour12: false`): Mitternacht heißt 00,
 * nicht 24.
 */
const WIEN_TEILE = new Intl.DateTimeFormat('en-CA', {
  timeZone:  WIEN,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** Die Wiener Wanduhr eines Zeitpunkts, jedes Feld zweistellig (Jahr vierstellig). */
export interface WienerUhr {
  jahr:    string
  monat:   string
  tag:     string
  stunde:  string
  minute:  string
  sekunde: string
}

/**
 * Wiener Wanduhr eines Zeitpunkts (Sekunden abgeschnitten, nicht gerundet — wie
 * die Wanduhr selbst). Wirft bei einem ungültigen Datum (`RangeError`), statt
 * „NaN-NaN-…" in einen signierten Beleg zu schreiben.
 */
export function wienerUhr(zeitpunkt: Date): WienerUhr {
  const t: Record<string, string> = {}
  for (const teil of WIEN_TEILE.formatToParts(zeitpunkt)) {
    if (teil.type !== 'literal') t[teil.type] = teil.value
  }
  return {
    jahr:    t['year']!,
    monat:   t['month']!,
    tag:     t['day']!,
    stunde:  t['hour']!,
    minute:  t['minute']!,
    sekunde: t['second']!,
  }
}

/**
 * Beleg-Datum-Uhrzeit für den maschinenlesbaren Code: `JJJJ-MM-TT'T'hh:mm:ss`
 * in Wiener Ortszeit, ohne Zeitzonenangabe (z. B. 2015-07-21T14:23:34).
 */
export function formatBelegDatumUhrzeit(zeitpunkt: Date): string {
  const w = wienerUhr(zeitpunkt)
  return `${w.jahr}-${w.monat}-${w.tag}T${w.stunde}:${w.minute}:${w.sekunde}`
}

/** `TT.MM.JJJJ` in Wiener Ortszeit (Bon, Beleganzeige). */
export function formatWienerDatum(zeitpunkt: Date): string {
  const w = wienerUhr(zeitpunkt)
  return `${w.tag}.${w.monat}.${w.jahr}`
}

/** `TT.MM.JJJJ hh:mm` in Wiener Ortszeit (Kopf-/Fußzeile eines Bons). */
export function formatWienerDatumUhrzeit(zeitpunkt: Date): string {
  const w = wienerUhr(zeitpunkt)
  return `${w.tag}.${w.monat}.${w.jahr} ${w.stunde}:${w.minute}`
}

/** `hh:mm:ss` in Wiener Ortszeit (Bonierbon). */
export function formatWienerUhrzeitSekunden(zeitpunkt: Date): string {
  const w = wienerUhr(zeitpunkt)
  return `${w.stunde}:${w.minute}:${w.sekunde}`
}

/** `hh:mm` in Wiener Ortszeit. */
export function formatWienerUhrzeit(zeitpunkt: Date): string {
  const w = wienerUhr(zeitpunkt)
  return `${w.stunde}:${w.minute}`
}
