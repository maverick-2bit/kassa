import { describe, it, expect } from 'vitest'
import { koelnerPhonetik, levenshtein, normalisiere, tokenisiere, wortAehnlichkeit } from '../src/services/sprache/text.js'
import { zahlAlsWort, zahlwort } from '../src/services/sprache/zahlen.js'

describe('Sprachbestellung — Text', () => {
  it('normalisiert Umlaute, ß, Akzente und Satzzeichen', () => {
    expect(normalisiere('  Größe: Grüner Veltliner, 1/4 ')).toBe('groesse gruener veltliner, 1 4')
    expect(normalisiere('Café Crème')).toBe('cafe creme')
  })

  it('behandelt das Dezimalkomma nicht als Trenner', () => {
    expect(tokenisiere('Bier 0,5l, Cola')).toEqual(['bier', '05l', ',', 'cola'])
  })

  it('Levenshtein', () => {
    expect(levenshtein('seidl', 'seidl')).toBe(0)
    expect(levenshtein('seidl', 'seitel')).toBe(2)
    expect(levenshtein('', 'abc')).toBe(3)
  })

  it('Kölner Phonetik: bekannte Referenzwerte', () => {
    expect(koelnerPhonetik('mueller')).toBe('657')
    expect(koelnerPhonetik('wikipedia')).toBe('3412')
    expect(koelnerPhonetik('schmidt')).toBe('862')
    expect(koelnerPhonetik('meier')).toBe(koelnerPhonetik('mayr'))
  })

  it('Wortähnlichkeit: Verhörer sind ähnlich, Fremdes nicht', () => {
    expect(wortAehnlichkeit('bier', 'bier')).toBe(1)
    const klang = wortAehnlichkeit('seitel', 'seidl') // klingt gleich → ähnlich, aber nie „sicher"
    expect(klang).toBeGreaterThan(0.7)
    expect(klang).toBeLessThan(0.85)
    expect(wortAehnlichkeit('weisser', 'weiss')).toBeGreaterThanOrEqual(0.9) // Beugung
    expect(wortAehnlichkeit('bier', 'bar')).toBeLessThan(0.7)
    expect(wortAehnlichkeit('bier', 'pizza')).toBeLessThan(0.5)
    expect(wortAehnlichkeit('ab', 'ac')).toBe(0) // zu kurz für Unschärfe
  })

  it('Zusammensetzung („schnitzel" in „putenschnitzel") ist nie so sicher wie ein ganzes Wort', () => {
    const s = wortAehnlichkeit('schnitzel', 'putenschnitzel')
    expect(s).toBeGreaterThanOrEqual(0.7)
    expect(s).toBeLessThan(0.85)
  })
})

describe('Sprachbestellung — Zahlwörter', () => {
  it('erkennt Wörter, Ziffern und österreichische Formen', () => {
    expect(zahlwort('zwei')).toBe(2)
    expect(zahlwort('zwoa')).toBe(2)
    expect(zahlwort('a')).toBe(1)
    expect(zahlwort('einen')).toBe(1)
    expect(zahlwort('dreimal')).toBe(3)
    expect(zahlwort('zwoelf')).toBe(12)
    expect(zahlwort('7')).toBe(7)
    expect(zahlwort('3x')).toBe(3)
  })

  it('liefert null für Nicht-Zahlen und 0', () => {
    expect(zahlwort('bier')).toBeNull()
    expect(zahlwort('0')).toBeNull()
    expect(zahlwort('viertel')).toBeNull()
  })

  it('Zahl zum Vorlesen', () => {
    expect(zahlAlsWort(2)).toBe('zwei')
    expect(zahlAlsWort(12)).toBe('zwölf')
    expect(zahlAlsWort(15)).toBe('15')
  })
})
