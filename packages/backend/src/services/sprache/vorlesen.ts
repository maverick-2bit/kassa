/**
 * Sprachbestellung — Rückmeldetext zum Vorlesen (rein, ohne DB/IO).
 *
 * Der Kellner hört im Headset, was verstanden wurde, und bestätigt mit „ja" oder korrigiert.
 * Der Text ist bewusst kurz und enthält nur, was für die Kontrolle nötig ist.
 */

import type { ParseErgebnis, Vorschlag } from './parser.js'
import { zahlAlsWort } from './zahlen.js'

function positionText(v: Vorschlag): string {
  if (!v.artikel) return `unklar: ${v.text}`
  const teile = [`${zahlAlsWort(v.menge)} ${v.artikel.bezeichnung}`]
  for (const m of v.modifikatoren) teile.push(m.name)
  for (const h of v.hinweise) teile.push(h)
  if (v.status === 'pruefen' && v.alternativen.length > 0 && v.hinweise.length === 0) {
    teile.push(`oder ${v.alternativen[0]!.bezeichnung}?`)
  }
  return teile.join(' ')
}

export function leseVor(e: ParseErgebnis): string {
  if (e.vorschlaege.length === 0) return 'Nichts verstanden.'
  const kopf = e.tisch ? `Tisch ${e.tisch}${e.platz ? `, Platz ${e.platz}` : ''}: ` : ''
  const liste = e.vorschlaege.map(positionText).join(', ')
  const unklar = e.vorschlaege.some(v => v.status !== 'sicher')
  return `${kopf}${liste}. ${unklar ? 'Bitte prüfen.' : 'Richtig?'}`
}
