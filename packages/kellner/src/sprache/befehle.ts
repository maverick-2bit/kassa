/**
 * Sprachbestellung — Sprachbefehle zur Bestätigung (rein, ohne Browser-API).
 *
 * Nach dem Vorlesen antwortet der Kellner mit „ja" (in den Korb) oder „nein" (verwerfen). Erkannt wird
 * nur eine KURZE Äußerung, die ausschließlich aus Befehlswörtern besteht — alles andere ist eine weitere
 * Bestellung („und noch zwei Cola"), kein Befehl. Lieber einmal zu wenig erkannt als eine Bestellung
 * versehentlich bestätigt oder verworfen.
 */

export type SprachBefehl = 'bestaetigen' | 'verwerfen'

function normalisiere(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Füllwörter, die den Befehl nicht ändern („ja bitte", „das passt so"). */
const FUELLWOERTER = new Set(['bitte', 'danke', 'das', 'ist', 'so', 'alles', 'gut', 'dann', 'also', 'doch', 'mal'])

const JA = new Set(['ja', 'jawohl', 'passt', 'stimmt', 'richtig', 'korrekt', 'genau', 'ok', 'okay', 'bestaetigt', 'bestaetigen', 'abschicken', 'senden'])
const NEIN = new Set(['nein', 'falsch', 'abbrechen', 'stopp', 'stop', 'verwerfen', 'vergiss', 'nochmal', 'neu'])

const MAX_WOERTER = 3

export function erkenneBefehl(text: string): SprachBefehl | null {
  const woerter = normalisiere(text).filter(w => !FUELLWOERTER.has(w))
  if (woerter.length === 0 || woerter.length > MAX_WOERTER) return null

  const satz = woerter.join(' ')
  if (satz === 'in den korb' || satz === 'ab damit') return 'bestaetigen'

  if (woerter.every(w => JA.has(w))) return 'bestaetigen'
  if (woerter.every(w => NEIN.has(w))) return 'verwerfen'
  return null // gemischt („ja nein") oder keine Befehlswörter
}
