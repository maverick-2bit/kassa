import { describe, it, expect } from 'vitest'
import { SYNONYME_MAX_JE_ARTIKEL } from '@kassa/shared'
import { entferneSynonym, fuegeSynonymeHinzu, konfliktText, SYNONYM_MAX_LAENGE, synonymeGeaendert, synonymSchluessel } from './synonyme'

const BIER = 'Bier vom Fass 0,3l'

describe('Synonyme — Schlüssel', () => {
  it('Umlaute, Groß-/Kleinschreibung und Satzzeichen sind egal', () => {
    expect(synonymSchluessel('Krügerl')).toBe('kruegerl')
    expect(synonymSchluessel('KRUEGERL!')).toBe('kruegerl')
    expect(synonymSchluessel('  Café  Crème ')).toBe('cafe creme')
    expect(synonymSchluessel('Bier 0,3l')).toBe('bier 0 3l')
    expect(synonymSchluessel('?!')).toBe('')
  })
})

describe('Synonyme — hinzufügen', () => {
  it('übernimmt einen Namen, getrimmt, am Ende der Liste', () => {
    expect(fuegeSynonymeHinzu(['Seidl'], '  Seidel ', BIER)).toEqual({ liste: ['Seidl', 'Seidel'], fehler: null })
  })

  it('mehrere Namen mit Komma, Semikolon oder Zeilenumbruch auf einmal', () => {
    expect(fuegeSynonymeHinzu([], 'Seidl, Seidel; Kleines\nBierchen', BIER))
      .toEqual({ liste: ['Seidl', 'Seidel', 'Kleines', 'Bierchen'], fehler: null })
  })

  it('Dezimalkomma zwischen Ziffern trennt nicht', () => {
    expect(fuegeSynonymeHinzu([], 'Seidl 0,3l, Seidel', BIER)).toEqual({ liste: ['Seidl 0,3l', 'Seidel'], fehler: null })
    expect(fuegeSynonymeHinzu([], 'Halbe 0,5', BIER).liste).toEqual(['Halbe 0,5'])
  })

  it('leer oder nur Satzzeichen → Meldung, Liste bleibt', () => {
    expect(fuegeSynonymeHinzu(['a1'], '   ', BIER)).toEqual({ liste: ['a1'], fehler: 'Bitte einen Namen eingeben.' })
    expect(fuegeSynonymeHinzu(['a1'], ',;', BIER).fehler).toBe('Bitte einen Namen eingeben.')
    expect(fuegeSynonymeHinzu(['a1'], '?!', BIER).fehler).toBe('Bitte einen Namen mit Buchstaben oder Ziffern eingeben.')
  })

  it('Dubletten — auch anders geschrieben — und der eigene Artikelname werden abgelehnt', () => {
    expect(fuegeSynonymeHinzu(['Krügerl'], 'kruegerl', BIER)).toEqual({ liste: ['Krügerl'], fehler: 'Dieses Synonym gibt es schon.' })
    expect(fuegeSynonymeHinzu([], 'bier vom fass 0,3L', BIER)).toEqual({ liste: [], fehler: 'Das ist schon der Name des Artikels.' })
    expect(fuegeSynonymeHinzu([], 'Seidl, SEIDL', BIER)).toEqual({ liste: ['Seidl'], fehler: 'Dieses Synonym gibt es schon.' })
  })

  it('Gültiges bleibt, wenn ein anderer Teil der Eingabe abgelehnt wird', () => {
    const r = fuegeSynonymeHinzu(['Seidl'], 'Seidl, Seidel', BIER)
    expect(r.liste).toEqual(['Seidl', 'Seidel'])
    expect(r.fehler).toBe('Dieses Synonym gibt es schon.')
  })

  it('Längenbegrenzung', () => {
    const lang = 'x'.repeat(SYNONYM_MAX_LAENGE + 1)
    expect(fuegeSynonymeHinzu([], lang, BIER)).toEqual({ liste: [], fehler: `Höchstens ${SYNONYM_MAX_LAENGE} Zeichen.` })
    expect(fuegeSynonymeHinzu([], 'x'.repeat(SYNONYM_MAX_LAENGE), BIER).fehler).toBeNull()
  })

  it('höchstens so viele Synonyme je Artikel, wie der Server erlaubt', () => {
    const voll = Array.from({ length: SYNONYME_MAX_JE_ARTIKEL }, (_, i) => `name${i}`)
    expect(fuegeSynonymeHinzu(voll, 'noch eins', BIER)).toEqual({ liste: voll, fehler: `Höchstens ${SYNONYME_MAX_JE_ARTIKEL} Synonyme je Artikel.` })
    const fast = voll.slice(0, -1)
    expect(fuegeSynonymeHinzu(fast, 'a, b', BIER).liste).toHaveLength(SYNONYME_MAX_JE_ARTIKEL) // nur eines passt noch
  })

  it('verändert die übergebene Liste nicht', () => {
    const vorher = ['Seidl']
    fuegeSynonymeHinzu(vorher, 'Seidel', BIER)
    expect(vorher).toEqual(['Seidl'])
  })
})

describe('Synonyme — entfernen und Änderungen', () => {
  it('entfernt genau einen Eintrag', () => {
    expect(entferneSynonym(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(entferneSynonym(['a'], 5)).toEqual(['a'])
  })

  it('erkennt Änderungen inklusive Reihenfolge', () => {
    expect(synonymeGeaendert(['a', 'b'], ['a', 'b'])).toBe(false)
    expect(synonymeGeaendert(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(synonymeGeaendert(['a'], ['a', 'b'])).toBe(true)
    expect(synonymeGeaendert([], [])).toBe(false)
  })
})

describe('Synonyme — Konflikttext', () => {
  it('nennt den anderen Artikel und die Folge', () => {
    const a = konfliktText({ text: 'Seidl', artikelId: 'x', artikelBezeichnung: 'Bier 0,3l', art: 'synonym' })
    expect(a).toBe('„Seidl" ist auch ein Synonym von „Bier 0,3l". Die Sprachbestellung fragt dann nach, welcher gemeint ist.')
    expect(konfliktText({ text: 'Burger', artikelId: 'x', artikelBezeichnung: 'Burger', art: 'bezeichnung' }))
      .toContain('der Name von „Burger"')
  })
})
