import { describe, it, expect } from 'vitest'
import type { RabattInput } from '@kassa/shared'
import {
  modifikatorAufschlagCent,
  positionsPreisCent,
  warenkorbSummeCent,
  rabattBetragCent,
  summeNachRabattCent,
  preisNachPositionsRabattCent,
  summeNachGutscheinCent,
  barEingabeCent,
  zahlungsAufteilung,
} from './warenkorb'

const prozent = (p: number): RabattInput => ({ typ: 'prozent', prozent: p })
const betrag  = (c: number): RabattInput => ({ typ: 'betrag', betragCent: c })

describe('modifikatorAufschlagCent / positionsPreisCent', () => {
  it('summiert Aufschläge', () => {
    expect(modifikatorAufschlagCent([{ aufschlagCent: 150 }, { aufschlagCent: 250 }])).toBe(400)
    expect(modifikatorAufschlagCent([])).toBe(0)
  })
  it('Positionspreis = Bruttopreis + Aufschläge', () => {
    expect(positionsPreisCent(990, [{ aufschlagCent: 150 }, { aufschlagCent: 50 }])).toBe(1190)
    expect(positionsPreisCent(990, [])).toBe(990)
  })
})

describe('warenkorbSummeCent', () => {
  it('Σ preis × menge', () => {
    expect(warenkorbSummeCent([{ preisCent: 500, menge: 2 }, { preisCent: 1490, menge: 1 }])).toBe(2490)
  })
  it('leerer Warenkorb → 0', () => {
    expect(warenkorbSummeCent([])).toBe(0)
  })
})

describe('rabattBetragCent', () => {
  it('Prozent wird kaufmännisch gerundet', () => {
    expect(rabattBetragCent(1000, prozent(10))).toBe(100)
    expect(rabattBetragCent(999, prozent(10))).toBe(100)   // 99,9 → 100
    expect(rabattBetragCent(994, prozent(10))).toBe(99)    // 99,4 → 99
  })
  it('fixer Betrag wird auf die Basis gedeckelt', () => {
    expect(rabattBetragCent(1000, betrag(300))).toBe(300)
    expect(rabattBetragCent(1000, betrag(1500))).toBe(1000) // mehr als Basis → Basis
  })
  it('kein Rabatt oder Basis 0 → 0', () => {
    expect(rabattBetragCent(1000, null)).toBe(0)
    expect(rabattBetragCent(1000, undefined)).toBe(0)
    expect(rabattBetragCent(0, prozent(50))).toBe(0)
    expect(rabattBetragCent(0, betrag(100))).toBe(0)
  })
})

describe('summeNachRabattCent', () => {
  it('zieht den Rabatt ab', () => {
    expect(summeNachRabattCent(2000, prozent(25))).toBe(1500)
    expect(summeNachRabattCent(2000, betrag(500))).toBe(1500)
    expect(summeNachRabattCent(2000, null)).toBe(2000)
  })
  it('100% Rabatt → 0', () => {
    expect(summeNachRabattCent(2000, prozent(100))).toBe(0)
  })
})

describe('preisNachPositionsRabattCent', () => {
  it('Prozent- und Betragsrabatt auf die Position', () => {
    expect(preisNachPositionsRabattCent(1000, prozent(20))).toBe(800)
    expect(preisNachPositionsRabattCent(1000, betrag(250))).toBe(750)
  })
  it('nie unter 0 (Betrag größer als Preis)', () => {
    expect(preisNachPositionsRabattCent(500, betrag(900))).toBe(0)
  })
  it('Preis 0 bleibt 0', () => {
    expect(preisNachPositionsRabattCent(0, prozent(50))).toBe(0)
  })
})

describe('summeNachGutscheinCent', () => {
  it('zieht den Gutschein ab, nie unter 0', () => {
    expect(summeNachGutscheinCent(2000, 500)).toBe(1500)
    expect(summeNachGutscheinCent(2000, 2500)).toBe(0)   // Gutschein > Summe
    expect(summeNachGutscheinCent(2000, 0)).toBe(2000)
  })
})

describe('barEingabeCent', () => {
  it('parst Komma und Punkt', () => {
    expect(barEingabeCent('12,50')).toBe(1250)
    expect(barEingabeCent('12.50')).toBe(1250)
    expect(barEingabeCent('20')).toBe(2000)
  })
  it('ungültige oder negative Eingabe → 0', () => {
    expect(barEingabeCent('')).toBe(0)
    expect(barEingabeCent('abc')).toBe(0)
    expect(barEingabeCent('-5')).toBe(0)
  })
})

describe('zahlungsAufteilung', () => {
  it('Bar < offen: Rest geht auf Karte, kein Wechselgeld', () => {
    expect(zahlungsAufteilung(2000, 500)).toEqual({ barCentBeleg: 500, karteCentBeleg: 1500, wechselgeldCent: 0 })
  })
  it('Bar == offen: alles bar, kein Karte/Wechselgeld', () => {
    expect(zahlungsAufteilung(2000, 2000)).toEqual({ barCentBeleg: 2000, karteCentBeleg: 0, wechselgeldCent: 0 })
  })
  it('Bar > offen: bar gedeckelt, Überschuss = Wechselgeld', () => {
    expect(zahlungsAufteilung(2000, 5000)).toEqual({ barCentBeleg: 2000, karteCentBeleg: 0, wechselgeldCent: 3000 })
  })
  it('keine Bar-Eingabe: alles auf Karte', () => {
    expect(zahlungsAufteilung(2000, 0)).toEqual({ barCentBeleg: 0, karteCentBeleg: 2000, wechselgeldCent: 0 })
  })
  it('Invariante: barCentBeleg + karteCentBeleg == offener Betrag', () => {
    for (const [offen, bar] of [[2490, 1000], [100, 100], [0, 500], [9999, 0]] as const) {
      const z = zahlungsAufteilung(offen, bar)
      expect(z.barCentBeleg + z.karteCentBeleg).toBe(offen)
    }
  })
})
