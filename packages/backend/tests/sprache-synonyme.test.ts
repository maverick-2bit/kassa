import { describe, it, expect } from 'vitest'
import { bereinigeSynonyme, findeKonflikte, synonymSchluessel, type AndererArtikelName } from '../src/services/sprache/synonyme.js'

describe('Sprachbestellung — Synonyme (rein)', () => {
  it('Schlüssel: normalisiert, ohne Kommas', () => {
    expect(synonymSchluessel('  Krügerl, GROSS ')).toBe('kruegerl gross')
    expect(synonymSchluessel(',,')).toBe('')
  })

  it('bereinigt Leeres, Dubletten (auch anders geschrieben) und die eigene Bezeichnung', () => {
    const r = bereinigeSynonyme(['Seidl', ' seidl ', 'SEIDL', '', '   ', 'Seidel', 'Bier vom Fass 0,3l'], 'Bier vom Fass 0,3l')
    expect(r).toEqual([
      { text: 'Seidl',  textNorm: 'seidl' },
      { text: 'Seidel', textNorm: 'seidel' },
    ])
  })

  it('behält die erste Schreibweise und die Reihenfolge', () => {
    const r = bereinigeSynonyme(['Krügerl', 'Halbe', 'krügerl', 'Kruegerl'], 'Bier')
    expect(r.map(x => x.text)).toEqual(['Krügerl', 'Halbe']) // „Kruegerl" ist normalisiert dasselbe wie „Krügerl"
  })

  describe('Konflikte', () => {
    const andere: AndererArtikelName[] = [
      { artikelId: 'a1', bezeichnung: 'Radler',  textNorm: 'radler', art: 'bezeichnung' },
      { artikelId: 'a2', bezeichnung: 'Weißer Spritzer', textNorm: 'gespritzter', art: 'synonym' },
      { artikelId: 'a3', bezeichnung: 'Gespritzter', textNorm: 'gespritzter', art: 'bezeichnung' },
    ]

    it('meldet Synonyme, die ein anderer Artikel schon als Namen oder Synonym trägt', () => {
      const k = findeKonflikte(
        [{ text: 'Radler', textNorm: 'radler' }, { text: 'Gespritzter', textNorm: 'gespritzter' }, { text: 'Seidl', textNorm: 'seidl' }],
        andere,
      )
      expect(k.map(x => [x.text, x.artikelId, x.art])).toEqual([
        ['Radler', 'a1', 'bezeichnung'],
        ['Gespritzter', 'a3', 'bezeichnung'], // Bezeichnung hat Vorrang vor Synonym
      ])
    })

    it('keine Konflikte → leer', () => {
      expect(findeKonflikte([{ text: 'Seidl', textNorm: 'seidl' }], andere)).toEqual([])
      expect(findeKonflikte([], andere)).toEqual([])
    })
  })
})
