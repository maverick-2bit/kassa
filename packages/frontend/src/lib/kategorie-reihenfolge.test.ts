import { describe, it, expect } from 'vitest'
import {
  elternSchluessel, geschwisterIds, reihenfolgeEintraege, verschiebeUnterGeschwistern, ziehUnterGeschwistern,
} from './kategorie-reihenfolge'
import { baumFlach } from './kategorie-baum'
import { asselloBaum, kat } from './testdaten-kategorien'

const reihe = (menge: readonly { id: string; reihenfolge: number }[], ids: string[]) =>
  ids.map(id => menge.find(k => k.id === id)!.reihenfolge)

describe('Reihenfolge unter Geschwistern', () => {
  it('Schlüssel der Geschwistermenge: Elterngruppe, Hauptgruppen = leer (auch bei fehlender Elterngruppe)', () => {
    const m = asselloBaum()
    expect(elternSchluessel(m, 'atr-alko')).toBe('atr')
    expect(elternSchluessel(m, 'ev-alko')).toBe('ev-pakete')
    expect(elternSchluessel(m, 'grillen')).toBe('')
    expect(elternSchluessel([kat('x', 'X', 'weg', 0)], 'x')).toBe('')
  })

  it('↑/↓ verschiebt NUR unter den Geschwistern derselben Elterngruppe', () => {
    const m = asselloBaum()
    const neu = verschiebeUnterGeschwistern(m, 'kel-alko', +1)
    expect(geschwisterIds(neu, 'kel-alko')).toEqual(['kel-bier', 'kel-alko'])
    expect(reihe(neu, ['kel-bier', 'kel-alko'])).toEqual([0, 1])
    // alles andere unverändert — insbesondere die drei übrigen Geschwistermengen
    for (const k of m.filter(x => !['kel-alko', 'kel-bier'].includes(x.id))) {
      expect(neu.find(x => x.id === k.id)!.reihenfolge).toBe(k.reihenfolge)
    }
  })

  it('am Rand und bei unbekannter ID bleibt alles unverändert (gleiche Referenz)', () => {
    const m = asselloBaum()
    expect(verschiebeUnterGeschwistern(m, 'atr-alko', -1)).toBe(m)          // schon erste
    expect(verschiebeUnterGeschwistern(m, 'atr-wein', +1)).toBe(m)          // schon letzte
    expect(verschiebeUnterGeschwistern(m, 'gibt-es-nicht', +1)).toBe(m)
    expect(verschiebeUnterGeschwistern(m, 'atr-bier', 0)).toBe(m)
  })

  it('Drag & Drop nur zwischen Geschwistern; über Elterngruppen hinweg passiert nichts', () => {
    const m = asselloBaum()
    expect(ziehUnterGeschwistern(m, 'atr-alko', 'kel-alko')).toBe(m)        // gleicher Name, andere Eltern
    expect(ziehUnterGeschwistern(m, 'atr-limo', 'atr-bier')).toBe(m)        // Enkel auf Kind
    expect(ziehUnterGeschwistern(m, 'atr', 'atr')).toBe(m)
    const neu = ziehUnterGeschwistern(m, 'atr-wein', 'atr-alko')
    expect(geschwisterIds(neu, 'atr-wein')).toEqual(['atr-wein', 'atr-alko', 'atr-bier'])
    expect(reihe(neu, ['atr-wein', 'atr-alko', 'atr-bier'])).toEqual([0, 1, 2])
  })

  it('Hauptgruppen lassen sich untereinander verschieben, die Untergruppen bleiben bei ihrer Elterngruppe', () => {
    const m = asselloBaum()
    const neu = ziehUnterGeschwistern(m, 'grillen', 'atr')
    expect(baumFlach(neu).filter(e => e.tiefe === 0).map(e => e.kategorie.id)).toEqual(['grillen', 'atr', 'kel', 'ev'])
    // der Teilbaum von Atriumbar ist unverändert
    expect(geschwisterIds(neu, 'atr-alko')).toEqual(['atr-alko', 'atr-bier', 'atr-wein'])
  })
})

describe('Reihenfolge speichern: nie globale Flat-Indizes', () => {
  it('liefert nur die Einträge der veränderten Geschwistermenge, mit Positionen 0..n-1', () => {
    const m = verschiebeUnterGeschwistern(asselloBaum(), 'kel-alko', +1)
    const eintraege = reihenfolgeEintraege(m, new Set(['kel']))
    expect(eintraege).toEqual([{ id: 'kel-bier', reihenfolge: 0 }, { id: 'kel-alko', reihenfolge: 1 }])
  })

  it('Hauptgruppen verschoben: nur die 4 Hauptgruppen (0..3) — keine Untergruppen, keine Indizes über 3', () => {
    const m = ziehUnterGeschwistern(asselloBaum(), 'grillen', 'atr')
    const eintraege = reihenfolgeEintraege(m, new Set(['']))
    expect(eintraege).toEqual([
      { id: 'grillen', reihenfolge: 0 }, { id: 'atr', reihenfolge: 1 }, { id: 'kel', reihenfolge: 2 }, { id: 'ev', reihenfolge: 3 },
    ])
  })

  it('mehrere veränderte Geschwistermengen: jede für sich 0..n-1, nie ein Wert ≥ Geschwisterzahl', () => {
    let m: readonly ReturnType<typeof asselloBaum>[number][] = asselloBaum()
    m = verschiebeUnterGeschwistern(m, 'atr-wein', -1)          // Atriumbar-Kinder: Alkoholfrei, Wein, Bier
    m = verschiebeUnterGeschwistern(m, 'ev-kaffee', -1)         // Event-Paket-Kinder: Kaffee, Alkoholfrei
    const eintraege = reihenfolgeEintraege(m, new Set(['atr', 'ev-pakete']))
    expect(eintraege).toEqual([
      { id: 'atr-alko', reihenfolge: 0 }, { id: 'atr-wein', reihenfolge: 1 }, { id: 'atr-bier', reihenfolge: 2 },
      { id: 'ev-kaffee', reihenfolge: 0 }, { id: 'ev-alko', reihenfolge: 1 },
    ])
    expect(Math.max(...eintraege.map(e => e.reihenfolge))).toBe(2)
    // die flache Anzeigeliste hätte 14 Einträge — kein Eintrag trägt einen solchen Index
    expect(eintraege.every(e => e.reihenfolge < 3)).toBe(true)
  })

  it('unveränderte Geschwistermengen werden nicht angefasst (leere Menge = keine Einträge)', () => {
    expect(reihenfolgeEintraege(asselloBaum(), new Set())).toEqual([])
  })

  it('Regression: Speichern der Anzeigeliste würde die Asello-Reihenfolge zerstören — hier bleibt sie erhalten', () => {
    // Asello-Import: Positionen unter Geschwistern. Nach einer Verschiebung unter den Hauptgruppen
    // bleiben die Positionen aller Untergruppen exakt wie importiert.
    const importiert = asselloBaum()
    const m = ziehUnterGeschwistern(importiert, 'ev', 'atr')
    const geschrieben = new Map(reihenfolgeEintraege(m, new Set([''])).map(e => [e.id, e.reihenfolge] as const))
    const nachSpeichern = importiert.map(k => ({ ...k, reihenfolge: geschrieben.get(k.id) ?? k.reihenfolge }))
    for (const id of ['atr-alko', 'atr-bier', 'atr-wein', 'atr-limo', 'atr-saft', 'kel-alko', 'kel-bier', 'ev-pakete', 'ev-alko', 'ev-kaffee']) {
      expect(nachSpeichern.find(k => k.id === id)!.reihenfolge).toBe(importiert.find(k => k.id === id)!.reihenfolge)
    }
    // die Baumreihenfolge der drei „Alkoholfrei" ist unverändert unter ihren Eltern
    const baum = baumFlach(nachSpeichern).map(e => e.kategorie.id)
    expect(baum.indexOf('atr-alko')).toBeGreaterThan(baum.indexOf('atr'))
    expect(baum.indexOf('kel-alko')).toBeGreaterThan(baum.indexOf('kel'))
    expect(baum.indexOf('ev-alko')).toBeGreaterThan(baum.indexOf('ev-pakete'))
  })
})
