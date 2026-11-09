import { describe, expect, it } from 'vitest'
import { ArtikelInputSchema, KundeInputSchema, LieferantInputSchema } from '@kassa/shared'
import {
  landCode, mwstAusProzent, parseArtikel, parseKunden, parseLieferanten, text, zahl,
} from './selectline-import'

describe('Spaltenzugriff', () => {
  it('findet Überschriften unabhängig von Groß-/Kleinschreibung, ß und Sonderzeichen', () => {
    expect(text({ 'Straße': ' Hauptstr. 1 ' }, 'strasse')).toBe('Hauptstr. 1')
    expect(text({ 'E-Mail': 'a@b.at' }, 'email')).toBe('a@b.at')
    expect(text({ A: null, a: 'x' }, 'a')).toBe('x')
  })
  it('liest Zahlen mit Komma und Punkt', () => {
    expect(zahl({ P: '12,50' }, 'p')).toBe(12.5)
    expect(zahl({ P: 12.5 }, 'p')).toBe(12.5)
    expect(zahl({ P: 'abc' }, 'p')).toBeNull()
    expect(zahl({ P: '' }, 'p')).toBeNull()
  })
  it('Länderkennzeichen → ISO', () => {
    expect(landCode('D')).toBe('DE')
    expect(landCode('A')).toBe('AT')
    expect(landCode('')).toBe('AT')
    expect(landCode('CH')).toBe('CH')
    expect(landCode('xyz')).toBe('AT')
  })
})

describe('Lieferanten', () => {
  const zeilen = [
    { Nummer: '70001', Firma: 'Kosatec Computer GmbH', 'Straße': 'Carl-Miele Straße 3', PLZ: '38112', Ort: 'Braunschweig', Land: 'D',
      Telefon: '+49 531 23544 3000', 'E-Mail': 'info@kosatec.de', UID: 'DE 123 456 789', 'Zahlungsbed.': '3', Notiz: 'Vorkasse' },
    { Nummer: '70002', Firma: '', Vorname: '', Name: '' },
    { Nummer: '70003', Firma: 'Alt GmbH', Inaktiv: 'ja' },
    { Nummer: '70004', Name: 'Huber', Vorname: 'Franz', 'E-Mail': 'kaputt', 'Zahlungsbed.': '14 Tage netto' },
  ]
  const r = parseLieferanten(zeilen)

  it('übernimmt Adresse, UID, Land und merkt sich die SelectLine-Nr. in der Notiz', () => {
    const k = r.eintraege[0]!
    expect(k.input).toMatchObject({
      name: 'Kosatec Computer GmbH', strasse: 'Carl-Miele Straße 3', plz: '38112', ort: 'Braunschweig', land: 'DE',
      uid: 'DE123456789', email: 'info@kosatec.de',
    })
    expect(k.input.notiz).toBe('SelectLine-Nr. 70001\nVorkasse')
  })
  it('überspringt leere und inaktive, verwirft ungültige E-Mail, ignoriert reine Zahlen als Zahlungsbedingung', () => {
    expect(r.eintraege.map(e => e.nummer)).toEqual(['70001', '70004'])
    expect(r.uebersprungen).toHaveLength(2)
    expect(r.eintraege[0]!.input.zahlungsbedingung).toBeNull()
    expect(r.eintraege[1]!.input.email).toBeNull()
    expect(r.eintraege[1]!.input.name).toBe('Franz Huber')
    expect(r.eintraege[1]!.input.zahlungsbedingung).toBe('14 Tage netto')
  })
  it('jedes Ergebnis besteht die API-Validierung', () => {
    for (const e of r.eintraege) expect(LieferantInputSchema.safeParse(e.input).success, e.nummer).toBe(true)
  })
})

describe('Kunden', () => {
  const r = parseKunden([
    { Nummer: '5053', Firma: 'API Österreich GmbH', 'Straße': 'Wienerstraße 111', PLZ: '2700', Ort: 'Wiener Neustadt', Land: 'A', Telefon: '0502155-0', 'E-Mail': 'vertrieb@api.at', UID: 'ATU1' },
    { Nummer: '3002', Name: 'Danci', Vorname: 'Ion', Ort: 'Unterpremstätten' },
    { Nummer: '3003', Vorname: 'Nur Vorname' },
    { Nummer: '9', Firma: '', Name: '', Vorname: '' },
    { Nummer: '8', Firma: 'Alt', Inaktiv: 'ja' },
  ])
  it('Firmenkunde wird vollständig übernommen, Marke steht in den Notizen', () => {
    expect(r.eintraege[0]!.input).toMatchObject({ firma: 'API Österreich GmbH', land: 'AT', plz: '2700', uid: 'ATU1', email: 'vertrieb@api.at' })
    expect(r.eintraege[0]!.input.notizen).toBe('SelectLine Kd.-Nr. 5053')
  })
  it('Privatkunde: Name → Nachname, Vorname bleibt erhalten', () => {
    expect(r.eintraege[1]!.input).toMatchObject({ nachname: 'Danci', vorname: 'Ion', ort: 'Unterpremstätten' })
  })
  it('nur Vorname genügt als Nachname; ganz ohne Namen und inaktive werden übersprungen', () => {
    expect(r.eintraege[2]!.input.nachname).toBe('Nur Vorname')
    expect(r.eintraege).toHaveLength(3)
    expect(r.uebersprungen).toHaveLength(2)
  })
  it('jedes Ergebnis besteht die API-Validierung', () => {
    for (const e of r.eintraege) expect(KundeInputSchema.safeParse(e.input).success, e.nummer).toBe(true)
  })
})

describe('Artikel', () => {
  it('Steuersätze', () => {
    expect(mwstAusProzent(20)).toBe('normal')
    expect(mwstAusProzent(10)).toBe('ermaessigt1')
    expect(mwstAusProzent(4.9)).toBe('ermaessigt3')
    expect(mwstAusProzent(7)).toBeNull()
    expect(mwstAusProzent(null)).toBeNull()
  })

  const r = parseArtikel([
    { Artikelnummer: '4670803', EAN: '8715946708034', Bezeichnung: 'Epson 604XL yellow', Warengruppe: 'Tinte', 'Steuer %': 20,
      'VK netto (Listenpreis)': 40.83, 'VK brutto': 49, 'Einkaufspreis (letzter)': 33.33, Lieferant: '70001', Hersteller: 'Epson', 'Hersteller-Art.Nr.': 'C13T10H44010' },
    { Artikelnummer: 'X1', Bezeichnung: 'Nur netto', 'Steuer %': 10, 'VK netto (Listenpreis)': 10 },
    { Artikelnummer: 'X2', Bezeichnung: 'Ohne Preis', 'Steuer %': 20 },
    { Artikelnummer: 'X3', Bezeichnung: 'Inaktiv', Inaktiv: 'ja' },
    { Artikelnummer: 'X4', Bezeichnung: '' },
  ])
  it('übernimmt Preise in Cent, EAN, Einkauf, Hersteller; SelectLine-Nr. wird Lieferanten-Artikelnummer', () => {
    const a = r.eintraege[0]!
    expect(a.input).toMatchObject({
      bezeichnung: 'Epson 604XL yellow', preisBruttoCent: 4900, mwstSatz: 'normal', ean: '8715946708034', einkaufspreisCent: 3333,
      lieferantenArtikelnummer: '4670803', hersteller: 'Epson', herstellerArtikelnummer: 'C13T10H44010',
    })
    expect(a.warengruppe).toBe('Tinte')
    expect(a.lieferantNummer).toBe('70001')
    expect(a.hatVerkaufspreis).toBe(true)
  })
  it('rechnet Netto-Listenpreis mit Steuersatz auf Brutto um', () => {
    expect(r.eintraege[1]!.input.preisBruttoCent).toBe(1100)
    expect(r.eintraege[1]!.input.mwstSatz).toBe('ermaessigt1')
  })
  it('zählt Artikel ohne Verkaufspreis; überspringt inaktive und unbenannte', () => {
    expect(r.ohnePreis).toBe(1)
    expect(r.eintraege.map(e => e.nummer)).toEqual(['4670803', 'X1', 'X2'])
    expect(r.uebersprungen).toHaveLength(2)
  })
  it('jedes Ergebnis besteht die API-Validierung (mit Mandant)', () => {
    for (const e of r.eintraege) {
      const p = ArtikelInputSchema.safeParse({ ...e.input, mandantId: '11111111-1111-4111-8111-111111111111' })
      expect(p.success, e.nummer).toBe(true)
    }
  })
})
