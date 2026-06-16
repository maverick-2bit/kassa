import { describe, it, expect } from 'vitest'
import { formatPreis, parseEuroToCent } from './format'

describe('parseEuroToCent', () => {
  it('parst deutsche Komma-Eingaben', () => {
    expect(parseEuroToCent('12,50')).toBe(1250)
    expect(parseEuroToCent('0,99')).toBe(99)
    expect(parseEuroToCent('19,99')).toBe(1999)
  })

  it('akzeptiert auch Punkt als Dezimaltrenner', () => {
    expect(parseEuroToCent('12.50')).toBe(1250)
    expect(parseEuroToCent('0.05')).toBe(5)
  })

  it('parst ganze Euro-Betraege', () => {
    expect(parseEuroToCent('12')).toBe(1200)
    expect(parseEuroToCent('0')).toBe(0)
    expect(parseEuroToCent('100')).toBe(10000)
  })

  it('ignoriert umgebende Leerzeichen', () => {
    expect(parseEuroToCent('  12,50  ')).toBe(1250)
    expect(parseEuroToCent('12 ,5 0')).toBe(1250)
  })

  it('rundet auf den Cent (robuste, nicht-grenzwertige Werte)', () => {
    expect(parseEuroToCent('12,506')).toBe(1251)
    expect(parseEuroToCent('12,503')).toBe(1250)
  })

  it('liefert null bei leerer oder ungueltiger Eingabe', () => {
    expect(parseEuroToCent('')).toBeNull()
    expect(parseEuroToCent('   ')).toBeNull()
    expect(parseEuroToCent('abc')).toBeNull()
    expect(parseEuroToCent('€')).toBeNull()
  })

  it('verarbeitet negative Betraege (z. B. Korrekturen)', () => {
    expect(parseEuroToCent('-5')).toBe(-500)
    expect(parseEuroToCent('-0,01')).toBe(-1)
  })
})

describe('formatPreis', () => {
  it('formatiert Cent als de-AT-Euro-Betrag', () => {
    const s = formatPreis(1250)
    expect(s).toContain('12,50')
    expect(s).toContain('€')
  })

  it('zeigt immer zwei Nachkommastellen', () => {
    expect(formatPreis(0)).toContain('0,00')
    expect(formatPreis(500)).toContain('5,00')
    expect(formatPreis(9)).toContain('0,09')
  })

  it('formatiert negative Betraege mit Minus', () => {
    const s = formatPreis(-500)
    expect(s).toContain('5,00')
    expect(s).toMatch(/-|−/) // ASCII- oder Unicode-Minus
  })

  it('ist invers zu parseEuroToCent fuer gueltige Betraege', () => {
    for (const cent of [0, 99, 1250, 10000, 19999]) {
      const euroStr = (cent / 100).toFixed(2).replace('.', ',')
      expect(parseEuroToCent(euroStr)).toBe(cent)
    }
  })
})
