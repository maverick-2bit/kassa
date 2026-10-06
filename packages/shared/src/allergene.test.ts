import { describe, it, expect } from 'vitest'
import { parseAllergene, allergeneAnzeige, allergeneBeschreibung } from './allergene.js'

describe('parseAllergene', () => {
  it('bereinigt Groß-/Kleinschreibung, Trenner, Doppelte und Reihenfolge', () => {
    expect(parseAllergene('g, a;c  A')).toEqual({ ok: true, wert: 'A,C,G' })
  })
  it('leer/null/undefined → null (kein Allergen)', () => {
    expect(parseAllergene('')).toEqual({ ok: true, wert: null })
    expect(parseAllergene('  , ')).toEqual({ ok: true, wert: null })
    expect(parseAllergene(null)).toEqual({ ok: true, wert: null })
    expect(parseAllergene(undefined)).toEqual({ ok: true, wert: null })
  })
  it('unbekannte Codes (I, J, K, Q, S–Z, Ziffern) werden gemeldet', () => {
    expect(parseAllergene('A, I, x, 1')).toEqual({ ok: false, ungueltig: ['I', 'X', '1'] })
  })
})

describe('Anzeige', () => {
  it('Liste mit Komma + Leerzeichen', () => {
    expect(allergeneAnzeige('A,C,G')).toBe('A, C, G')
    expect(allergeneAnzeige(null)).toBe('')
  })
  it('Beschreibung für Tooltip', () => {
    expect(allergeneBeschreibung('A,G')).toBe('A = Glutenhaltiges Getreide, G = Milch/Laktose')
  })
})
