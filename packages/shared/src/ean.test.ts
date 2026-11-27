import { describe, it, expect } from 'vitest'
import { eanFehler, eanPruefziffer, eanSchluessel, istGueltigeEan } from './ean.js'
import { ArtikelInputSchema, ArtikelUpdateSchema } from './schemas/artikel.js'

describe('EAN/GTIN-Prüfung', () => {
  it('nimmt gültige EAN-8, UPC-A, EAN-13 und GTIN-14 an (auch Hauscodes 20–29)', () => {
    for (const ean of ['96385074', '012345678905', '4006381333931', '9002490100070', '00012345600012', '2000000000015']) {
      expect(eanFehler(ean), ean).toBeNull()
    }
  })

  it('berechnet die Prüfziffer (Gewichte 3/1 von rechts)', () => {
    expect(eanPruefziffer('400638133393')).toBe(1)
    expect(eanPruefziffer('9638507')).toBe(4)
    expect(eanPruefziffer('01234567890')).toBe(5)
  })

  it('lehnt falsche Prüfziffer, falsche Länge und Nicht-Ziffern mit lesbarer Meldung ab', () => {
    expect(eanFehler('4006381333932')).toMatch(/Prüfziffer/)
    expect(eanFehler('9001')).toMatch(/8, 12, 13 oder 14/)
    expect(eanFehler('40063813339310')).toMatch(/Prüfziffer/)
    expect(eanFehler('400638133393X')).toMatch(/nur Ziffern/)
    expect(eanFehler('4006381 333931')).toMatch(/nur Ziffern/)
    expect(istGueltigeEan('')).toBe(false)
  })

  it('Vergleichsschlüssel: UPC-A 12- und 13-stellig ergeben denselben GTIN-14-Schlüssel', () => {
    expect(eanSchluessel('012345678905')).toBe('00012345678905')
    expect(eanSchluessel('0012345678905')).toBe(eanSchluessel('012345678905'))
    expect(eanSchluessel('96385074')).toBe('00000096385074')
  })

  it('Schemas: Artikel-Eingabe trimmt und prüft die EAN, null leert sie', () => {
    const basis = { mandantId: '00000000-0000-4000-8000-000000000001', bezeichnung: 'Milch', preisBruttoCent: 129, mwstSatz: 'ermaessigt1' }
    expect(ArtikelInputSchema.parse({ ...basis, ean: ' 9002490100070 ' }).ean).toBe('9002490100070')
    expect(ArtikelInputSchema.safeParse({ ...basis, ean: '9002490100071' }).success).toBe(false)
    expect(ArtikelInputSchema.safeParse({ ...basis, ean: '' }).success).toBe(false)
    expect(ArtikelUpdateSchema.parse({ ean: null }).ean).toBeNull()
    expect(ArtikelUpdateSchema.safeParse({ ean: '123' }).success).toBe(false)
  })
})
