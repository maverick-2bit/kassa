import { beforeEach, describe, expect, it } from 'vitest'
import {
  _leereFehlerSammler, bereinigeFehlertext, bereinigeRoute, entnehmeFehler, gibFehlerZurueck, meldeFehler,
} from '../src/services/fehler-sammler.js'

describe('Fehler-Sammler: Bereinigung', () => {
  it('SQL und Parameter von Datenbankfehlern verlassen die Box nicht', () => {
    const text = bereinigeFehlertext('Failed query: select "email", "passwort_hash" from "users" where "email" = $1 params: max@muster.at')
    expect(text).toBe('Datenbankabfrage fehlgeschlagen')
    expect(text).not.toMatch(/max@|select|passwort/i)
  })

  it('ersetzt Kennungen, E-Mail-Adressen, lange Zahlen und Tokens', () => {
    const text = bereinigeFehlertext(
      'Kunde 123e4567-e89b-12d3-a456-426614174000 max@muster.at IBAN 4711081512345 Token abcdefghijklmnopqrstuvwx123456 fehlt',
    )
    expect(text).toBe('Kunde <id> <mail> IBAN <zahl> Token <token> fehlt')
  })

  it('nimmt nur die erste Zeile (kein Stack) und kürzt lange Meldungen', () => {
    expect(bereinigeFehlertext('Erste Zeile\n    at foo (/app/x.js:1:2)')).toBe('Erste Zeile')
    const lang = bereinigeFehlertext('Wort '.repeat(300))
    expect(lang.length).toBeLessThanOrEqual(300)
    expect(lang.endsWith('…')).toBe(true)
  })

  it('Routen verlieren Kennungen und Query', () => {
    expect(bereinigeRoute('/api/belege/123e4567-e89b-12d3-a456-426614174000?token=geheim')).toBe('/api/belege/:id')
    expect(bereinigeRoute('/api/kunden/42/belege')).toBe('/api/kunden/:zahl/belege')
    expect(bereinigeRoute(undefined)).toBeNull()
  })
})

describe('Fehler-Sammler: Gruppieren', () => {
  beforeEach(() => _leereFehlerSammler())

  it('gleichartige Fehler werden gezählt, verschiedene getrennt', () => {
    const t1 = new Date('2026-11-04T10:00:00Z')
    const t2 = new Date('2026-11-04T10:05:00Z')
    meldeFehler(new Error('Drucker 123e4567-e89b-12d3-a456-426614174000 nicht erreichbar'), { route: '/api/druck' }, t1)
    meldeFehler(new Error('Drucker 223e4567-e89b-12d3-a456-426614174999 nicht erreichbar'), { route: '/api/druck' }, t2)
    meldeFehler(new TypeError('anderer Fehler'), { route: '/api/druck' }, t2)

    const liste = entnehmeFehler()
    expect(liste).toHaveLength(2)
    const drucker = liste.find(f => f.meldung.startsWith('Drucker'))!
    expect(drucker).toMatchObject({ anzahl: 2, ersterAm: t1.toISOString(), letzterAm: t2.toISOString(), route: '/api/druck' })
    expect(drucker.meldung).toBe('Drucker <id> nicht erreichbar')
    expect(liste.find(f => f.name === 'TypeError')?.anzahl).toBe(1)
    // Der Sammler ist danach leer
    expect(entnehmeFehler()).toEqual([])
  })

  it('derselbe Fehler in verschiedenen Betrieben zählt getrennt', () => {
    meldeFehler(new Error('kaputt'), { mandantId: '123e4567-e89b-12d3-a456-426614174000' })
    meldeFehler(new Error('kaputt'), { mandantId: '223e4567-e89b-12d3-a456-426614174000' })
    expect(entnehmeFehler()).toHaveLength(2)
  })

  it('nicht gesendete Fehler gehen zurück und werden mit neuen zusammengezählt', () => {
    meldeFehler(new Error('A'), {})
    meldeFehler(new Error('A'), {})
    const entnommen = entnehmeFehler()
    meldeFehler(new Error('A'), {})          // neuer Fehler, während die Meldung unterwegs war
    gibFehlerZurueck(entnommen)
    const liste = entnehmeFehler()
    expect(liste).toHaveLength(1)
    expect(liste[0]!.anzahl).toBe(3)
  })

  it('ein Fehlersturm sprengt weder Speicher noch Meldung (höchstens 200 Gruppen)', () => {
    for (let i = 0; i < 500; i++) meldeFehler(new Error(`Fehler Nummer ${i}x`), { route: `/api/r${i}` })
    expect(entnehmeFehler().length).toBeLessThanOrEqual(200)
  })

  it('wirft nie — auch bei seltsamen Eingaben', () => {
    expect(() => meldeFehler(undefined)).not.toThrow()
    expect(() => meldeFehler({ foo: 1 })).not.toThrow()
    expect(() => meldeFehler(null, { route: '/x', mandantId: 'kein-guid' })).not.toThrow()
  })
})
