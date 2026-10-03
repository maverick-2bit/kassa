/**
 * Allergen-Kennzeichnung nach österreichischer Allergeninformationsverordnung
 * (EU-Allergene, Buchstabencodes A–R wie auf Speisekarten üblich).
 *
 * Gespeichert wird ein kommagetrennter, sortierter String ohne Leerzeichen
 * ("A,C,G"); die Eingabe darf locker sein ("a, c g").
 */

export const ALLERGEN_LABELS = {
  A: 'Glutenhaltiges Getreide',
  B: 'Krebstiere',
  C: 'Eier',
  D: 'Fisch',
  E: 'Erdnüsse',
  F: 'Soja',
  G: 'Milch/Laktose',
  H: 'Schalenfrüchte (Nüsse)',
  L: 'Sellerie',
  M: 'Senf',
  N: 'Sesam',
  O: 'Sulfite',
  P: 'Lupinen',
  R: 'Weichtiere',
} as const

export type AllergenCode = keyof typeof ALLERGEN_LABELS

export const ALLERGEN_CODES = Object.keys(ALLERGEN_LABELS) as AllergenCode[]

export type AllergenParse =
  | { ok: true;  wert: string | null }
  | { ok: false; ungueltig: string[] }

/** Eingabe ("a, c g") → "A,C,G"; leer → null; unbekannte Buchstaben → Fehler mit Liste. */
export function parseAllergene(eingabe: string | null | undefined): AllergenParse {
  const teile = (eingabe ?? '')
    .split(/[,;\s]+/)
    .map(t => t.trim().toUpperCase())
    .filter(t => t !== '')
  const ungueltig = [...new Set(teile.filter(t => !(t in ALLERGEN_LABELS)))]
  if (ungueltig.length > 0) return { ok: false, ungueltig }
  const einmalig = [...new Set(teile)].sort()
  return { ok: true, wert: einmalig.length > 0 ? einmalig.join(',') : null }
}

/** Gespeicherten String ("A,C,G") für die Anzeige als Liste ("A, C, G"); null/leer → ''. */
export function allergeneAnzeige(wert: string | null | undefined): string {
  return (wert ?? '').split(',').map(t => t.trim()).filter(Boolean).join(', ')
}

/** Tooltip-Text: "A = Glutenhaltiges Getreide, G = Milch/Laktose" */
export function allergeneBeschreibung(wert: string | null | undefined): string {
  return (wert ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(c => `${c} = ${ALLERGEN_LABELS[c as AllergenCode] ?? c}`)
    .join(', ')
}
