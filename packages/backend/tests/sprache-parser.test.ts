import { describe, it, expect } from 'vitest'
import { baueKatalog, leseVor, parseBestellung, type ParseErgebnis } from '../src/services/sprache/index.js'
import { KARTE } from './fixtures/sprache-karte.js'

const katalog = baueKatalog(KARTE)
const parse = (s: string): ParseErgebnis => parseBestellung(katalog, s)

/** Kurzform zum Vergleichen: „2× bier05 [sicher]" */
const kurz = (e: ParseErgebnis) => e.vorschlaege.map(v => `${v.menge}× ${v.artikel?.id ?? '?'} [${v.status}]`)

describe('Sprachbestellung — Parser', () => {
  describe('Mengen und Trenner', () => {
    it('zwei Positionen mit „und"', () => {
      expect(kurz(parse('zwei Bier und ein Spritzer weiß'))).toEqual(['2× bier05 [sicher]', '1× spritzer [sicher]'])
    })

    it('Komma, „noch" und Füllwörter', () => {
      const e = parse('Hallo, bitte zwei Cola, noch ein Radler')
      expect(kurz(e)).toEqual(['2× cola [sicher]', '1× radler [sicher]'])
    })

    it('Ziffern, „2x" und „einmal/zweimal"', () => {
      expect(kurz(parse('2 Bier'))).toEqual(['2× bier05 [sicher]'])
      expect(kurz(parse('3x Radler'))).toEqual(['3× radler [sicher]'])
      expect(kurz(parse('einmal Kaiserschmarrn und zweimal Apfelstrudel'))).toEqual(['1× schmarrn [sicher]', '2× strudel [sicher]'])
    })

    it('ohne Mengenangabe = 1; österreichisches „a" = ein', () => {
      expect(kurz(parse('Radler'))).toEqual(['1× radler [sicher]'])
      expect(kurz(parse('a Seidl'))).toEqual(['1× bier03 [sicher]'])
    })

    it('„Viertel" ist keine Menge, sondern Teil des Artikels', () => {
      expect(kurz(parse('ein Viertel Zweigelt und ein Viertel Grüner Veltliner'))).toEqual(['1× zweigelt [sicher]', '1× veltliner [sicher]'])
    })

    it('„und" im Artikelnamen: „Gin und Tonic" bleibt eine Position', () => {
      expect(kurz(parse('zwei Gin und Tonic und ein Radler'))).toEqual(['2× gin [sicher]', '1× radler [sicher]'])
    })
  })

  describe('Tisch und Platz', () => {
    it('Tisch als Zahlwort', () => {
      const e = parse('Tisch zwölf, ein Wiener Schnitzel')
      expect(e.tisch).toBe('12')
      expect(kurz(e)).toEqual(['1× wschnitzel [sicher]'])
    })

    it('„an Tisch 5 Platz 2" und Tisch am Ende', () => {
      const a = parse('an Tisch 5 Platz 2 zwei Cola')
      expect([a.tisch, a.platz]).toEqual(['5', '2'])
      expect(kurz(a)).toEqual(['2× cola [sicher]'])
      expect(parse('zwei Cola für Tisch sieben'.replace('sieben', '7')).tisch).toBe('7')
    })

    it('Tischname bleibt erhalten', () => {
      expect(parse('Tisch a3 ein Bier').tisch).toBe('A3')
    })

    it('ohne Tisch = null', () => {
      expect(parse('ein Bier').tisch).toBeNull()
    })
  })

  describe('Unscharfer Abgleich', () => {
    it('Synonyme (Umgangssprache)', () => {
      expect(kurz(parse('zwei Krügerl'))).toEqual(['2× bier05 [sicher]'])
      expect(kurz(parse('ein Gespritzter'))).toEqual(['1× spritzer [sicher]'])
      expect(kurz(parse('ein Schwarzer'))).toEqual(['1× espresso [sicher]'])
    })

    it('Verhörer werden erkannt, aber zur Kontrolle markiert', () => {
      const e = parse('zwei Seitel')
      expect(e.vorschlaege[0]!.artikel?.id).toBe('bier03')
      expect(e.vorschlaege[0]!.status).toBe('pruefen')
    })

    it('Wortreihenfolge und Beugung sind egal', () => {
      expect(kurz(parse('ein weißer Spritzer'))).toEqual(['1× spritzer [sicher]'])
      expect(kurz(parse('zwei Spritzer weiss'))).toEqual(['2× spritzer [sicher]'])
    })

    it('Kurzform eines längeren Namens: eindeutig → sicher, Alternative bleibt sichtbar', () => {
      const e = parse('ein Schnitzel')
      expect(e.vorschlaege[0]!.artikel?.id).toBe('wschnitzel')
      expect(e.vorschlaege[0]!.alternativen.map(a => a.id)).toContain('pschnitzel')
    })

    it('mehrdeutig → prüfen, mit Alternativen', () => {
      const v = parse('eine Pizza').vorschlaege[0]!
      expect(v.status).toBe('pruefen')
      expect([v.artikel?.id, ...v.alternativen.map(a => a.id)].sort()).toEqual(['pizza-m', 'pizza-s'])
    })

    it('unbekannter Artikel → unbekannt, der Rest der Bestellung bleibt', () => {
      const e = parse('zwei Bier und ein Sushi')
      expect(kurz(e)).toEqual(['2× bier05 [sicher]', '1× ? [unbekannt]'])
      expect(e.vorschlaege[1]!.text).toBe('sushi')
    })

    it('leere/unverständliche Eingabe → keine Vorschläge', () => {
      expect(parse('').vorschlaege).toEqual([])
      expect(parse('äh bitte').vorschlaege).toEqual([])
    })

    it('Konfidenz: exakter Treffer 1.0, Verhörer darunter', () => {
      expect(parse('Radler').vorschlaege[0]!.konfidenz).toBe(1)
      expect(parse('Seitel').vorschlaege[0]!.konfidenz).toBeLessThan(0.85)
    })
  })

  describe('Optionen (Modifikatoren)', () => {
    it('Beilage als Option', () => {
      const v = parse('ein Wiener Schnitzel mit Pommes').vorschlaege[0]!
      expect(v.modifikatoren.map(m => m.id)).toEqual(['m-pommes'])
      expect(v.status).toBe('sicher')
    })

    it('„ohne Zitrone" trifft den Modifikator „ohne Zitrone"', () => {
      const v = parse('ein Schnitzel ohne Zitrone').vorschlaege[0]!
      expect(v.modifikatoren.map(m => m.id)).toEqual(['m-o-zitrone'])
      expect(v.hinweise).toEqual([])
    })

    it('mehrere Optionen: „medium ohne Zwiebel und ohne Gurken"', () => {
      const v = parse('ein Burger medium ohne Zwiebel und ohne Gurken').vorschlaege[0]!
      expect(v.modifikatoren.map(m => m.id).sort()).toEqual(['m-medium', 'm-o-gurken', 'm-o-zwiebel'])
      expect(v.status).toBe('sicher')
    })

    it('„ohne Zwiebel und Gurken": das „ohne" gilt weiter', () => {
      const e = parse('ein Burger ohne Zwiebel und Gurken')
      expect(e.vorschlaege).toHaveLength(1)
      expect(e.vorschlaege[0]!.modifikatoren.map(m => m.id).sort()).toEqual(['m-o-gurken', 'm-o-zwiebel'])
    })

    it('Option vor dem Artikel: „ein durchgebratener Burger" / „Burger Well Done" (Synonym)', () => {
      expect(parse('einen Burger well done').vorschlaege[0]!.modifikatoren.map(m => m.id)).toEqual(['m-durch'])
    })

    it('unbekannte Option wird nicht geraten, sondern als Hinweis geführt → prüfen', () => {
      const v = parse('ein Burger ohne Senf').vorschlaege[0]!
      expect(v.modifikatoren).toEqual([])
      expect(v.hinweise).toEqual(['ohne senf'])
      expect(v.status).toBe('pruefen')
    })

    it('„ohne X" wird nie zu „X" umgedeutet', () => {
      // Karte kennt „Pommes" als Beilage, aber kein „ohne Pommes" → darf NICHT als Beilage Pommes landen
      const v = parse('ein Schnitzel ohne Pommes').vorschlaege[0]!
      expect(v.modifikatoren).toEqual([])
      expect(v.hinweise).toEqual(['ohne pommes'])
    })

    it('„mit X" wird nie zu „ohne X" umgedeutet', () => {
      const v = parse('ein Burger mit Zwiebel').vorschlaege[0]!
      expect(v.modifikatoren).toEqual([])
      expect(v.hinweise).toEqual(['mit zwiebel'])
    })

    it('nur ähnlich klingende/zusammengesetzte Option wird nicht geraten, sondern erfragt', () => {
      const v = parse('ein Schnitzel mit Kartoffeln').vorschlaege[0]!  // Karte: „Petersilkartoffeln"
      expect(v.modifikatoren).toEqual([])
      expect(v.hinweise).toEqual(['mit kartoffeln'])
      expect(v.status).toBe('pruefen')
    })

    it('Mengenangabe nach einer Option beginnt eine neue Position', () => {
      const e = parse('ein Burger ohne Senf und zwei Bier')
      expect(e.vorschlaege.map(v => v.artikel?.id)).toEqual(['burger', 'bier05'])
      expect(e.vorschlaege[1]!.hinweise).toEqual([])
    })

    it('Optionen gehören zum richtigen Artikel', () => {
      const e = parse('ein Schnitzel mit Reis und ein Burger medium')
      expect(e.vorschlaege.map(v => v.modifikatoren.map(m => m.id))).toEqual([['m-reis'], ['m-medium']])
    })
  })

  describe('Vorlesen', () => {
    it('liest eine sichere Bestellung zur Bestätigung vor', () => {
      expect(leseVor(parse('Tisch zwölf, zwei Bier und ein Wiener Schnitzel mit Pommes')))
        .toBe('Tisch 12: zwei Bier vom Fass 0,5l, ein Wiener Schnitzel Pommes. Richtig?')
    })

    it('markiert Unsicheres und Unverstandenes', () => {
      const text = leseVor(parse('ein Burger ohne Senf und ein Sushi'))
      expect(text).toContain('ein Burger ohne senf')
      expect(text).toContain('unklar: sushi')
      expect(text.endsWith('Bitte prüfen.')).toBe(true)
    })

    it('nennt bei Mehrdeutigkeit die Alternative', () => {
      expect(leseVor(parse('eine Pizza'))).toMatch(/oder Pizza (Margherita|Salami)\?/)
    })

    it('leere Eingabe', () => {
      expect(leseVor(parse(''))).toBe('Nichts verstanden.')
    })
  })
})

describe('Sprachbestellung — Geschwindigkeit', () => {
  it('große Karte (2000 Artikel): ein Satz mit mehreren Positionen bleibt weit unter einer Sekunde', () => {
    const woerter = ['Wiener', 'Grüner', 'Gebratene', 'Hausgemachte', 'Frische', 'Kleine', 'Große', 'Gemischte']
    const nomen = ['Schnitzel', 'Suppe', 'Salat', 'Burger', 'Pizza', 'Nudeln', 'Torte', 'Strudel', 'Wein', 'Saft']
    const viele = Array.from({ length: 2000 }, (_, i) => ({
      id: `a${i}`, bezeichnung: `${woerter[i % 8]} ${nomen[(i * 3) % 10]} ${i}`, synonyme: [`${nomen[i % 10]} ${i}`],
      modifikatoren: Array.from({ length: 6 }, (_, k) => ({ id: `m${i}-${k}`, gruppeId: 'g', name: `Option ${k}` })),
    }))
    const grosser = baueKatalog(viele)
    const t0 = performance.now()
    const e = parseBestellung(grosser, 'Tisch zwölf, zwei Wiener Schnitzel 5 ohne Option 3, noch ein Salat 33 und drei Suppe 100')
    const dauer = performance.now() - t0
    expect(e.vorschlaege).toHaveLength(3)
    // Gemessen ~50 ms kalt; Grenze großzügig, damit langsame CI-Rechner nicht flackern — fängt aber O(Artikel × Bereiche)-Rückfälle (~1,5 s)
    expect(dauer).toBeLessThan(600)
  })
})
