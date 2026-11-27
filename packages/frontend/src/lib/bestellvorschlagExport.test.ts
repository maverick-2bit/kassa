import { describe, it, expect } from 'vitest'
import { alsCsv, bestellvorschlagTabelle, reichweiteTabelle, type ExportZeile } from './bestellvorschlagExport'

const zeile = (z: Partial<ExportZeile>): ExportZeile => ({
  artikelId: 'a', bezeichnung: 'Bier', artikelnummer: null, lieferantId: 'l1', lieferantenArtikelnummer: 'B-1',
  einkaufspreisCent: 125, bestand: 10, unterwegs: 0, mindestbestand: 5, verbrauch: 28, verbrauchProTag: 2,
  reichtTageBestand: 5, reichtTage: 5, bedarf: 28, vorschlag: 23, bestellmenge: 24, ...z,
})
const namen = (id: string | null) => (id === 'l1' ? 'Getränke Huber' : id === 'l2' ? 'Bäckerei Alt' : 'Ohne Lieferant')

describe('bestellvorschlagTabelle', () => {
  it('Kopf und Zeile mit deutschen Zahlen, Bestellmenge und EK gesamt', () => {
    const [kopf, z] = bestellvorschlagTabelle([zeile({ verbrauchProTag: 1.57 })], namen, 14)
    expect(kopf).toContain('Verbrauch 14 T')
    expect(z).toEqual(['Getränke Huber', 'B-1', 'Bier', '10', '0', '28', '1,57', '5', '5', '23', '24', '1,25', '30,00'])
  })

  it('sortiert nach Lieferant, dann Artikel; fehlende Werte als – bzw. leer', () => {
    const t = bestellvorschlagTabelle([
      zeile({ bezeichnung: 'Wein' }),
      zeile({ bezeichnung: 'Semmel', lieferantId: 'l2', reichtTage: null, mindestbestand: null, einkaufspreisCent: null }),
      zeile({ bezeichnung: 'Apfelsaft' }),
    ], namen, 14)
    expect(t.slice(1).map(z => z[2])).toEqual(['Semmel', 'Apfelsaft', 'Wein'])
    expect(t[1]!.slice(7, 9)).toEqual(['–', '–'])
    expect(t[1]!.slice(11)).toEqual(['', ''])
  })
})

describe('reichweiteTabelle', () => {
  it('Lagerstand, Verbrauch, Reichweite ohne und mit Bestellung', () => {
    const t = reichweiteTabelle([
      zeile({ artikelnummer: '4711', reichtTageBestand: 5, unterwegs: 12, reichtTage: 11 }),
      zeile({ bezeichnung: 'Ladenhüter', verbrauch: 0, verbrauchProTag: 0, reichtTageBestand: null, reichtTage: null }),
    ], 14)
    expect(t[0]).toEqual(['Artikel', 'Art.-Nr.', 'Lagerstand', 'Mindest', 'Verbrauch 14 T', 'Ø/Tag', 'Reicht (Tage)', 'Unterwegs', 'Reicht mit Bestellung'])
    expect(t[1]).toEqual(['Bier', '4711', '10', '5', '28', '2', '5', '12', '11'])
    expect(t[2]!.slice(6)).toEqual(['–', '0', '–'])
  })
})

describe('alsCsv', () => {
  it('BOM, Semikolon, CRLF; Felder mit ; oder " werden gequotet', () => {
    expect(alsCsv([['a', 'b;c'], ['Sag "hi"', 'x']])).toBe('﻿a;"b;c"\r\n"Sag ""hi""";x\r\n')
  })
})
