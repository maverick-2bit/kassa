/**
 * Volle Breite als Vorgabe für Eingabefelder — aber nur, solange der Aufrufer
 * keine eigene Breite mitgibt.
 *
 * Bloßes Anhängen reicht nicht: Bei zwei Tailwind-Klassen für dieselbe
 * Eigenschaft entscheidet die Reihenfolge im erzeugten CSS, nicht die im
 * class-Attribut — und dort steht `.w-full` hinter `.w-20`/`.w-32`/`.w-40`,
 * gewann also immer. Präfixierte Breiten (`sm:w-40`, `hover:w-60`) stehen im CSS
 * hinter allen unpräfixierten Klassen; sie ergänzen die Vorgabe, statt sie zu
 * ersetzen.
 */
export function vorgabeBreite(className: string): string {
  return /(?:^|\s)!?(?:w|size)-/.test(className) ? '' : 'w-full'
}
