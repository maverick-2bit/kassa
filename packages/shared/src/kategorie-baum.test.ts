import { describe, it, expect } from 'vitest'
import { istErreichbar, sichtbareGruppenFlach, sichtbarkeitsMengen, type KategorieSortierbar } from './kategorie-baum.js'

/**
 *   Atriumbar (atr)
 *     Alkoholfrei (atr-alko)
 *       Limonaden (atr-limo)
 *       Säfte (atr-saft)
 *     Bier (atr-bier)
 *     Wein (atr-wein)
 *   Kellner Getränke (kel)
 *     Alkoholfrei (kel-alko)
 *     Bier (kel-bier)
 *   Grillen (grillen)
 */
const k = (id: string, name: string, parentId: string | null, reihenfolge: number): KategorieSortierbar => ({ id, name, parentId, reihenfolge })
// Absichtlich NICHT in Baumreihenfolge — die Funktionen müssen selbst sortieren
const menge: KategorieSortierbar[] = [
  k('grillen', 'Grillen', null, 2),
  k('kel-bier', 'Bier', 'kel', 1),
  k('atr-limo', 'Limonaden', 'atr-alko', 0),
  k('atr', 'Atriumbar', null, 0),
  k('atr-alko', 'Alkoholfrei', 'atr', 0),
  k('atr-saft', 'Säfte', 'atr-alko', 1),
  k('atr-bier', 'Bier', 'atr', 1),
  k('atr-wein', 'Wein', 'atr', 2),
  k('kel', 'Kellner Getränke', null, 1),
  k('kel-alko', 'Alkoholfrei', 'kel', 0),
]
const ALLE = menge.map(g => g.id)
const sortiert = (s: Set<string>) => [...s].sort()

describe('sichtbarkeitsMengen: jede Gruppe wird UNABHÄNGIG gewählt', () => {
  it('leere oder fehlende Liste = alle Gruppen gewählt (auch Artikel ohne Warengruppe), kein Zugang nötig', () => {
    for (const ids of [[], undefined]) {
      const m = sichtbarkeitsMengen(menge, ids)
      expect(m.alle).toBe(true)
      expect(sortiert(m.sichtbar)).toEqual([...ALLE].sort())
      expect(m.zugang.size).toBe(0)
    }
  })

  it('nur die Elterngruppe gewählt → ihre Untergruppen sind NICHT sichtbar (und nicht erreichbar)', () => {
    const m = sichtbarkeitsMengen(menge, ['atr'])
    expect(m.alle).toBe(false)
    expect(sortiert(m.sichtbar)).toEqual(['atr'])
    expect(m.zugang.size).toBe(0)
    for (const kind of ['atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein']) expect(istErreichbar(m, kind)).toBe(false)
  })

  it('nur „Alkoholfrei" der Atriumbar gewählt → Limonaden und Säfte sind NICHT dabei; die Atriumbar ist nur Zugang', () => {
    const m = sichtbarkeitsMengen(menge, ['atr-alko'])
    expect(sortiert(m.sichtbar)).toEqual(['atr-alko'])
    expect(sortiert(m.zugang)).toEqual(['atr'])
    expect(m.sichtbar.has('atr')).toBe(false)               // Zugang ≠ gewählt: keine eigenen Artikel
    for (const g of ['atr-limo', 'atr-saft', 'atr-bier', 'atr-wein']) expect(istErreichbar(m, g)).toBe(false)
    // gleichnamige Gruppen in anderen Teilbäumen sind unberührt
    expect(istErreichbar(m, 'kel-alko')).toBe(false)
    expect(istErreichbar(m, 'kel')).toBe(false)
  })

  it('nur eine Untergruppe gewählt → alle Vorfahren sind Zugang (ohne eigene Artikel), Enkel inklusive', () => {
    const m = sichtbarkeitsMengen(menge, ['atr-limo'])
    expect(sortiert(m.sichtbar)).toEqual(['atr-limo'])
    expect(sortiert(m.zugang)).toEqual(['atr', 'atr-alko'])
    expect(istErreichbar(m, 'atr-saft')).toBe(false)         // Geschwister-Untergruppe nicht gewählt
  })

  it('Elterngruppe + eine Untergruppe: die Elterngruppe ist gewählt (kein Zugang), die übrigen Untergruppen nicht', () => {
    const m = sichtbarkeitsMengen(menge, ['atr', 'atr-bier'])
    expect(sortiert(m.sichtbar)).toEqual(['atr', 'atr-bier'])
    expect(m.zugang.size).toBe(0)
    expect(istErreichbar(m, 'atr-alko')).toBe(false)
    expect(istErreichbar(m, 'atr-wein')).toBe(false)
  })

  it('Elterngruppe + Enkel: nur die dazwischenliegende Gruppe ist Zugang', () => {
    const m = sichtbarkeitsMengen(menge, ['atr', 'atr-limo'])
    expect(sortiert(m.sichtbar)).toEqual(['atr', 'atr-limo'])
    expect(sortiert(m.zugang)).toEqual(['atr-alko'])
    expect(istErreichbar(m, 'atr-saft')).toBe(false)
  })

  it('mehrere gewählte Untergruppen unter verschiedenen Eltern: je Eltern ein Zugang', () => {
    const m = sichtbarkeitsMengen(menge, ['atr-bier', 'kel-alko', 'grillen'])
    expect(sortiert(m.sichtbar)).toEqual(['atr-bier', 'grillen', 'kel-alko'])
    expect(sortiert(m.zugang)).toEqual(['atr', 'kel'])
  })

  it('alle Gruppen ausdrücklich gewählt: alles sichtbar, kein Zugang — aber nicht „alle" (künftige Gruppen kämen nicht dazu)', () => {
    const m = sichtbarkeitsMengen(menge, ALLE)
    expect(m.alle).toBe(false)
    expect(sortiert(m.sichtbar)).toEqual([...ALLE].sort())
    expect(m.zugang.size).toBe(0)
  })

  it('ältere gespeicherte Liste mit vollem Teilbaum (Gruppe + alle Untergruppen) verhält sich unverändert', () => {
    const m = sichtbarkeitsMengen(menge, ['atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein'])
    expect(sortiert(m.sichtbar)).toEqual(['atr', 'atr-alko', 'atr-bier', 'atr-limo', 'atr-saft', 'atr-wein'])
    expect(m.zugang.size).toBe(0)
    expect(istErreichbar(m, 'kel')).toBe(false)
  })

  it('unbekannte IDs zählen nicht; ohne bekannte Gruppe ist nichts sichtbar', () => {
    const m = sichtbarkeitsMengen(menge, ['gibt-es-nicht', 'grillen'])
    expect(sortiert(m.sichtbar)).toEqual(['grillen'])
    const nichts = sichtbarkeitsMengen(menge, ['gibt-es-nicht'])
    expect(nichts.alle).toBe(false)
    expect(nichts.sichtbar.size).toBe(0)
    expect(nichts.zugang.size).toBe(0)
  })

  it('fehlender Elternteil und Zyklus im Altbestand führen nicht in eine Endlosschleife', () => {
    const waise = sichtbarkeitsMengen([k('x', 'X', 'weg', 0), k('y', 'Y', null, 1)], ['x'])
    expect(sortiert(waise.sichtbar)).toEqual(['x'])
    expect(waise.zugang.size).toBe(0)
    const zyklus = sichtbarkeitsMengen([k('a', 'A', 'b', 0), k('b', 'B', 'a', 0)], ['a'])
    expect(zyklus.sichtbar.has('a')).toBe(true)
    expect(zyklus.zugang.size).toBeLessThanOrEqual(1)
  })

  it('die Eingabe wird nicht verändert; die Ergebnis-Mengen sind unabhängig voneinander', () => {
    const ids = ['atr-alko']
    const m = sichtbarkeitsMengen(menge, ids)
    expect(ids).toEqual(['atr-alko'])
    m.sichtbar.add('x')
    expect(sichtbarkeitsMengen(menge, ids).sichtbar.has('x')).toBe(false)
  })
})

describe('sichtbareGruppenFlach (Kellner-App, Gast-Karte)', () => {
  const ids = (liste: readonly string[] | undefined) => sichtbareGruppenFlach(menge, liste).map(g => g.id)

  it('ohne Einschränkung alle Gruppen in Baumreihenfolge', () => {
    expect(ids([])).toEqual(['atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein', 'kel', 'kel-alko', 'kel-bier', 'grillen'])
    expect(ids(undefined)).toEqual(ids([]))
  })

  it('nur „Alkoholfrei" gewählt → genau diese Gruppe (kein Zugang, keine Limonaden/Säfte, keine Atriumbar)', () => {
    expect(ids(['atr-alko'])).toEqual(['atr-alko'])
  })

  it('ausdrücklich gewählte Gruppen in Baumreihenfolge, unabhängig von der Reihenfolge der Liste', () => {
    expect(ids(['grillen', 'kel-bier', 'atr', 'atr-limo'])).toEqual(['atr', 'atr-limo', 'kel-bier', 'grillen'])
  })

  it('Elterngruppe allein → ohne ihre Untergruppen', () => {
    expect(ids(['kel'])).toEqual(['kel'])
  })
})
