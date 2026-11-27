import { describe, it, expect } from 'vitest'
import { BestellvorschlagQuerySchema, berechneVorschlag } from './bestellvorschlag.js'

const basis = { bestand: 0, unterwegs: 0, mindestbestand: null, verbrauch: 0, tage: 14, reichweite: 14 }

describe('berechneVorschlag', () => {
  it('Verbrauch 28 in 14 Tagen, Reichweite 14, Bestand 10 → 18', () => {
    expect(berechneVorschlag({ ...basis, verbrauch: 28, bestand: 10 })).toEqual({ verbrauchProTag: 2, reichtTageBestand: 5, reichtTage: 5, bedarf: 28, vorschlag: 18 })
  })

  it('bestellte, noch nicht gelieferte Menge wird abgezogen', () => {
    expect(berechneVorschlag({ ...basis, verbrauch: 28, bestand: 10, unterwegs: 12 })).toMatchObject({ vorschlag: 6, reichtTageBestand: 5, reichtTage: 11 })
    expect(berechneVorschlag({ ...basis, verbrauch: 28, bestand: 10, unterwegs: 30 }).vorschlag).toBe(0)
  })

  it('der Mindestbestand bleibt als Sicherheitsbestand übrig', () => {
    expect(berechneVorschlag({ ...basis, verbrauch: 28, bestand: 10, mindestbestand: 5 }).vorschlag).toBe(23)
  })

  it('ohne Verbrauch: nur bis zum Mindestbestand auffüllen, Reichweite unbekannt', () => {
    expect(berechneVorschlag({ ...basis, bestand: 1, mindestbestand: 4 })).toEqual({ verbrauchProTag: 0, reichtTageBestand: null, reichtTage: null, bedarf: 0, vorschlag: 3 })
    expect(berechneVorschlag({ ...basis, bestand: 7, mindestbestand: 4 }).vorschlag).toBe(0)
  })

  it('andere Reichweite als Rückblick: 14 Tage Verbrauch, für 7 Tage bestellen', () => {
    expect(berechneVorschlag({ ...basis, verbrauch: 28, reichweite: 7 })).toMatchObject({ bedarf: 14, vorschlag: 14 })
  })

  it('Bedarf wird aufgerundet (10 Stück in 14 Tagen, für 7 Tage → 5)', () => {
    expect(berechneVorschlag({ ...basis, verbrauch: 10, reichweite: 7 }).bedarf).toBe(5)
    expect(berechneVorschlag({ ...basis, verbrauch: 11, reichweite: 7 }).bedarf).toBe(6)
  })

  it('mehr Stornos als Verkäufe ergeben keinen negativen Verbrauch', () => {
    expect(berechneVorschlag({ ...basis, verbrauch: -3, bestand: 0 })).toMatchObject({ verbrauchProTag: 0, vorschlag: 0 })
  })
})

describe('BestellvorschlagQuerySchema', () => {
  it('Standard 14 Tage, Zahlen aus der Adresszeile', () => {
    expect(BestellvorschlagQuerySchema.parse({})).toEqual({ tage: 14 })
    expect(BestellvorschlagQuerySchema.parse({ tage: '7', reichweite: '21' })).toEqual({ tage: 7, reichweite: 21 })
  })
  it('0 oder Unsinn wird abgewiesen', () => {
    expect(BestellvorschlagQuerySchema.safeParse({ tage: '0' }).success).toBe(false)
    expect(BestellvorschlagQuerySchema.safeParse({ reichweite: 'x' }).success).toBe(false)
  })
})
