import { describe, it, expect } from 'vitest'
import {
  EINKAUF_BESTELLSTATUS,
  EINKAUF_BESTELLSTATUS_LABELS,
  EINKAUF_BESTELLSTATUS_UEBERGAENGE,
  EinkaufBestellungInputSchema,
  EinkaufBestellungUpdateSchema,
  summeBestellung,
} from './einkaufsbestellung.js'

const ID = '11111111-1111-4111-8111-111111111111'

describe('summeBestellung', () => {
  it('summiert Menge × Einkaufspreis', () => {
    expect(summeBestellung([{ menge: 2, einkaufspreisCent: 4500 }, { menge: 10, einkaufspreisCent: 150 }]))
      .toEqual({ summeNettoCent: 10500, summeUnvollstaendig: false })
  })
  it('Positionen ohne Preis zählen nicht und machen die Summe unvollständig', () => {
    expect(summeBestellung([{ menge: 1, einkaufspreisCent: 1000 }, { menge: 5, einkaufspreisCent: null }]))
      .toEqual({ summeNettoCent: 1000, summeUnvollstaendig: true })
  })
  it('Preis 0 ist ein bekannter Preis (z. B. Gratis-Beigabe), keine Lücke', () => {
    expect(summeBestellung([{ menge: 3, einkaufspreisCent: 0 }])).toEqual({ summeNettoCent: 0, summeUnvollstaendig: false })
  })
  it('leere Bestellung', () => {
    expect(summeBestellung([])).toEqual({ summeNettoCent: 0, summeUnvollstaendig: false })
  })
})

describe('Statusübergänge', () => {
  it('jeder Status hat Label und Übergangsliste', () => {
    for (const s of EINKAUF_BESTELLSTATUS) {
      expect(EINKAUF_BESTELLSTATUS_LABELS[s]).toBeTruthy()
      expect(EINKAUF_BESTELLSTATUS_UEBERGAENGE[s]).toBeDefined()
    }
  })
  it('erledigt und storniert sind endgültig', () => {
    expect(EINKAUF_BESTELLSTATUS_UEBERGAENGE.erledigt).toEqual([])
    expect(EINKAUF_BESTELLSTATUS_UEBERGAENGE.storniert).toEqual([])
  })
  it('ein Entwurf wird nie direkt „erledigt" oder „teilgeliefert"', () => {
    expect(EINKAUF_BESTELLSTATUS_UEBERGAENGE.entwurf).not.toContain('erledigt')
    expect(EINKAUF_BESTELLSTATUS_UEBERGAENGE.entwurf).not.toContain('teilgeliefert')
  })
  it('es gibt keinen Weg zurück in den Entwurf', () => {
    for (const s of EINKAUF_BESTELLSTATUS) expect(EINKAUF_BESTELLSTATUS_UEBERGAENGE[s]).not.toContain('entwurf')
  })
})

describe('Eingabe-Schemas', () => {
  const pos = { bezeichnung: 'Toner', menge: 2 }
  it('akzeptiert eine gültige Bestellung', () => {
    expect(EinkaufBestellungInputSchema.safeParse({ lieferantId: ID, liefertermin: '2026-12-31', positionen: [pos] }).success).toBe(true)
  })
  it.each([
    ['ohne Position', { lieferantId: ID, positionen: [] }],
    ['Menge 0', { lieferantId: ID, positionen: [{ ...pos, menge: 0 }] }],
    ['Menge mit Nachkommastelle', { lieferantId: ID, positionen: [{ ...pos, menge: 1.5 }] }],
    ['negativer Preis', { lieferantId: ID, positionen: [{ ...pos, einkaufspreisCent: -1 }] }],
    ['leere Bezeichnung', { lieferantId: ID, positionen: [{ ...pos, bezeichnung: '  ' }] }],
    ['Termin im falschen Format', { lieferantId: ID, liefertermin: '31.12.2026', positionen: [pos] }],
    ['Lieferant keine UUID', { lieferantId: 'x', positionen: [pos] }],
  ])('lehnt ab: %s', (_n, body) => {
    expect(EinkaufBestellungInputSchema.safeParse(body).success).toBe(false)
  })
  it('Update: alles optional, aber Positionen dürfen nicht leer sein', () => {
    expect(EinkaufBestellungUpdateSchema.safeParse({}).success).toBe(true)
    expect(EinkaufBestellungUpdateSchema.safeParse({ bemerkung: null, liefertermin: null }).success).toBe(true)
    expect(EinkaufBestellungUpdateSchema.safeParse({ positionen: [] }).success).toBe(false)
  })
})
