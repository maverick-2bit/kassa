/**
 * Zeitangaben für die FinanzOnline-Schnittstelle (`xs:dateTime`).
 */

import { wienerUhr } from '../zeit.js'

/**
 * `xs:dateTime` in Wiener Ortszeit MIT Zeitzonenabstand, z. B. `2026-11-13T09:30:00+01:00`
 * (Sommerzeit: `+02:00`).
 *
 * Das Schema lässt `xs:dateTime` mit und ohne Abstand zu; die BMF-Beschreibung sagt zur Zeitzone nichts.
 * Mit Abstand ist die Angabe in JEDER Lesart dieselbe: ein Dienst, der den Abstand beachtet, rechnet richtig,
 * einer, der ihn ignoriert, liest die Wiener Wanduhr — und die stimmt hier ebenfalls. Dagegen wäre eine
 * Angabe ohne Abstand für einen Dienst in UTC oder Rechner in anderer Zone 1–2 Stunden daneben — bei
 * `beginn_ausfall`/`ende_ausfall` ein falscher Zeitpunkt in einer Meldung an das Finanzamt.
 *
 * Unabhängig von `TZ` des Prozesses (wie der QR-Code, siehe `zeit.ts`).
 */
export function xsdDateTimeWien(zeitpunkt: Date): string {
  const w = wienerUhr(zeitpunkt)
  // Abstand = Wanduhr (als UTC gelesen) − tatsächlicher Zeitpunkt (auf ganze Sekunden, wie die Wanduhr)
  const wanduhrAlsUtc = Date.UTC(Number(w.jahr), Number(w.monat) - 1, Number(w.tag), Number(w.stunde), Number(w.minute), Number(w.sekunde))
  const abstandMinuten = Math.round((wanduhrAlsUtc - Math.floor(zeitpunkt.getTime() / 1000) * 1000) / 60_000)
  const vorzeichen = abstandMinuten < 0 ? '-' : '+'
  const betrag = Math.abs(abstandMinuten)
  const stunden = String(Math.floor(betrag / 60)).padStart(2, '0')
  const minuten = String(betrag % 60).padStart(2, '0')
  return `${w.jahr}-${w.monat}-${w.tag}T${w.stunde}:${w.minute}:${w.sekunde}${vorzeichen}${stunden}:${minuten}`
}
