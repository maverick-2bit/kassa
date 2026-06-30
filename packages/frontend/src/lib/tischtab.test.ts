import { describe, it, expect } from 'vitest'
import {
  positionsSummeCent,
  summeMitPosRabattenCent,
  zahlungCent,
  zahlerSubtotalCent,
  splitValidierung,
  rabattierterEinzelpreisCent,
  type TabPositionLike,
  type SplitZahlerLike,
} from './tischtab'

// Einfacher Cent→String-Formatter, nur für die Fehlertexte der Validierung.
const fmt = (c: number) => `${(c / 100).toFixed(2)} €`

const pos = (bezeichnung: string, menge: number, preisBruttoCent: number): TabPositionLike =>
  ({ bezeichnung, menge, preisBruttoCent })

describe('positionsSummeCent', () => {
  it('Σ preisBruttoCent × menge', () => {
    expect(positionsSummeCent([pos('Bier', 3, 450), pos('Schnitzel', 1, 1490)])).toBe(2840)
  })
  it('leer → 0', () => {
    expect(positionsSummeCent([])).toBe(0)
  })
})

describe('summeMitPosRabattenCent', () => {
  const p = [pos('Bier', 2, 500), pos('Wein', 1, 800)]
  it('ohne Rabatte = Bruttosumme', () => {
    expect(summeMitPosRabattenCent(p, {})).toBe(1800)
  })
  it('rabattierter Einzelpreis ersetzt den Brutto', () => {
    // Bier auf 400/Stk gesenkt: 400×2 + 800×1
    expect(summeMitPosRabattenCent(p, { 0: 400 })).toBe(1600)
  })
  it('Rabatt auf 0 wird respektiert (nicht als „kein Rabatt“ behandelt)', () => {
    expect(summeMitPosRabattenCent(p, { 1: 0 })).toBe(1000)
  })
})

describe('zahlungCent', () => {
  it('parst Ziffern, leer/ungültig → 0', () => {
    expect(zahlungCent('1500')).toBe(1500)
    expect(zahlungCent('')).toBe(0)
    expect(zahlungCent('abc')).toBe(0)
    expect(zahlungCent('0')).toBe(0)
  })
})

describe('zahlerSubtotalCent', () => {
  const p = [pos('Bier', 3, 450), pos('Schnitzel', 1, 1490)]
  it('Σ preis × zugewiesene Menge', () => {
    expect(zahlerSubtotalCent(p, { 0: 2 })).toBe(900)            // 2 Bier
    expect(zahlerSubtotalCent(p, { 0: 1, 1: 1 })).toBe(1940)     // 1 Bier + 1 Schnitzel
  })
  it('fehlende Indizes zählen als 0', () => {
    expect(zahlerSubtotalCent(p, {})).toBe(0)
  })
})

describe('splitValidierung', () => {
  const positionen = [pos('Bier', 2, 500), pos('Wein', 1, 800)]  // Summe 1800

  const zahler = (mengen: Record<number, number>, bar = '', karte = ''): SplitZahlerLike =>
    ({ mengen, barInput: bar, karte })

  it('saubere Aufteilung 1000/800, beide bar → kannSubmit', () => {
    const z = [
      zahler({ 0: 2, 1: 0 }, '1000'),  // 2 Bier = 1000
      zahler({ 0: 0, 1: 1 }, '800'),   // 1 Wein = 800
    ]
    const v = splitValidierung(positionen, z, fmt)
    expect(v.positionsfehler).toEqual([])
    expect(v.zahlungsfehler).toEqual([])
    expect(v.zahlerMitPositionen).toHaveLength(2)
    expect(v.kannSubmit).toBe(true)
  })

  it('unterverteilte Position meldet Positionsfehler', () => {
    const z = [zahler({ 0: 1, 1: 1 }, '1300'), zahler({ 0: 0, 1: 0 })]
    const v = splitValidierung(positionen, z, fmt)
    expect(v.positionsfehler).toEqual(['Bier: 1 von 2 zugewiesen'])
    expect(v.kannSubmit).toBe(false)
  })

  it('überverteilte Position meldet Positionsfehler', () => {
    const z = [zahler({ 0: 2 }, '1000'), zahler({ 0: 1, 1: 1 }, '1300')]
    const v = splitValidierung(positionen, z, fmt)
    expect(v.positionsfehler).toEqual(['Bier: 3 von 2 zugewiesen'])
    expect(v.kannSubmit).toBe(false)
  })

  it('falsche Zahlungssumme meldet Zahlungsfehler mit Original-Zahlernummer', () => {
    const z = [
      zahler({ 0: 2, 1: 0 }, '900'),   // soll 1000, hat 900
      zahler({ 0: 0, 1: 1 }, '800'),
    ]
    const v = splitValidierung(positionen, z, fmt)
    expect(v.zahlungsfehler).toEqual(['Zahler 1: 9.00 € statt 10.00 €'])
    expect(v.kannSubmit).toBe(false)
  })

  it('Bar + Karte gemischt zählt zusammen', () => {
    const z = [
      zahler({ 0: 2, 1: 0 }, '400', '600'),  // 400 bar + 600 karte = 1000 ✓
      zahler({ 0: 0, 1: 1 }, '0', '800'),
    ]
    const v = splitValidierung(positionen, z, fmt)
    expect(v.zahlungsfehler).toEqual([])
    expect(v.kannSubmit).toBe(true)
  })

  it('Zahler ohne Positionen werden ignoriert (zählen nicht für ≥2)', () => {
    const z = [
      zahler({ 0: 2, 1: 1 }, '1800'),  // einziger zahlender Zahler
      zahler({}),                       // leer
    ]
    const v = splitValidierung(positionen, z, fmt)
    expect(v.positionsfehler).toEqual([])
    expect(v.zahlungsfehler).toEqual([])
    expect(v.zahlerMitPositionen).toHaveLength(1)
    expect(v.kannSubmit).toBe(false)   // < 2 zahlende Zahler
  })

  it('Zahlernummer im Fehler bezieht sich auf die volle Zahlerliste, nicht die gefilterte', () => {
    const z = [
      zahler({}),                       // Zahler 1 (ohne Positionen, ignoriert)
      zahler({ 0: 2, 1: 0 }, '900'),    // Zahler 2 (falsch)
      zahler({ 0: 0, 1: 1 }, '800'),    // Zahler 3 (ok)
    ]
    const v = splitValidierung(positionen, z, fmt)
    expect(v.zahlungsfehler).toEqual(['Zahler 2: 9.00 € statt 10.00 €'])
  })
})

describe('rabattierterEinzelpreisCent', () => {
  it('Prozent-Rabatt, kaufmännisch gerundet', () => {
    expect(rabattierterEinzelpreisCent(1000, 'prozent', 20)).toBe(800)
    expect(rabattierterEinzelpreisCent(999, 'prozent', 10)).toBe(899)   // 999 - round(99.9)=100
  })
  it('Betrags-Rabatt', () => {
    expect(rabattierterEinzelpreisCent(1000, 'betrag', 250)).toBe(750)
  })
  it('nie unter 0', () => {
    expect(rabattierterEinzelpreisCent(500, 'betrag', 900)).toBe(0)
    expect(rabattierterEinzelpreisCent(100, 'prozent', 100)).toBe(0)
  })
  it('ungültige Eingabe → null', () => {
    expect(rabattierterEinzelpreisCent(1000, 'prozent', 0)).toBeNull()
    expect(rabattierterEinzelpreisCent(1000, 'prozent', 101)).toBeNull()
    expect(rabattierterEinzelpreisCent(1000, 'betrag', 0)).toBeNull()
    expect(rabattierterEinzelpreisCent(1000, 'betrag', -5)).toBeNull()
  })
})
