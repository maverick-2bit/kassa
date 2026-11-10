import { describe, it, expect } from 'vitest'
import type { EinkaufBestellung } from '@kassa/shared'
import { erzeugeBestellungPdf, formatDatum, formatEuro } from '../src/services/einkauf-bestellung-pdf.service.js'

describe('formatEuro', () => {
  it.each([
    [0, '0,00 €'], [5, '0,05 €'], [150, '1,50 €'], [4500, '45,00 €'], [123456, '1.234,56 €'], [100000000, '1.000.000,00 €'], [-250, '-2,50 €'],
  ])('%i Cent → %s', (cent, soll) => { expect(formatEuro(cent)).toBe(soll) })
})

describe('formatDatum', () => {
  it('Kalendertag ohne Zeitzonenverschiebung', () => { expect(formatDatum('2026-12-31')).toBe('31.12.2026') })
  it('Zeitpunkt nach Wiener Zeit (Silvester 23:30 UTC ist schon Neujahr)', () => {
    expect(formatDatum('2026-12-31T23:30:00.000Z')).toBe('01.01.2027')
    expect(formatDatum('2026-06-15T10:00:00.000Z')).toBe('15.06.2026')
  })
})

describe('erzeugeBestellungPdf', () => {
  const bestellung = (anzahl: number): EinkaufBestellung => ({
    id: '11111111-1111-4111-8111-111111111111', mandantId: '22222222-2222-4222-8222-222222222222',
    nummer: 'B2026001', lieferantId: '33333333-3333-4333-8333-333333333333', lieferantName: 'Kosatec', status: 'entwurf',
    bemerkung: 'Bitte liefern bis Freitag — Umlaute äöüß und €', liefertermin: '2026-12-31', gesendetAm: null, gesendetAn: null,
    positionen: Array.from({ length: anzahl }, (_, i) => ({
      id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`, position: i + 1, artikelId: null,
      bezeichnung: `Artikel ${i + 1} mit einer eher langen Bezeichnung zum Umbrechen im Dokument`,
      lieferantenArtikelnummer: `ART-${i + 1}`, menge: i + 1, einkaufspreisCent: 100 + i, gelieferteMenge: 0,
    })),
    summeNettoCent: 12345, summeUnvollstaendig: false,
    createdAt: '2026-11-10T08:00:00.000Z', updatedAt: '2026-11-10T08:00:00.000Z',
  })
  const seiten = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length

  it('erzeugt ein gültiges PDF mit einer Seite bei wenigen Positionen', async () => {
    const pdf = await erzeugeBestellungPdf(bestellung(3), { firmenname: 'Meine Firma e.U.', uid: 'ATU12345678' }, { name: 'Kosatec', ort: 'Braunschweig' })
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(seiten(pdf)).toBe(1)
  })
  it('bricht lange Bestellungen auf mehrere Seiten um', async () => {
    const pdf = await erzeugeBestellungPdf(bestellung(80), { firmenname: 'Meine Firma e.U.', fusstext: 'Fußtext' }, { name: 'Kosatec', land: 'DE', zahlungsbedingung: '14 Tage netto' })
    expect(seiten(pdf)).toBeGreaterThanOrEqual(3)
  })
  it('kommt mit minimalen Angaben aus (keine Adresse, keine Positionen mit Preis)', async () => {
    const b = bestellung(1)
    b.positionen[0]!.einkaufspreisCent = null
    b.summeUnvollstaendig = true; b.summeNettoCent = 0; b.bemerkung = null; b.liefertermin = null
    const pdf = await erzeugeBestellungPdf(b, { firmenname: 'F' }, { name: 'L' })
    expect(seiten(pdf)).toBe(1)
  })
})
