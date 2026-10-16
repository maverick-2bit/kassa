import { describe, expect, it } from 'vitest'
import { fragtNachOptionen, warengruppenWahl } from './optionen-abfrage.js'

describe('fragtNachOptionen — Artikel → Warengruppe → Kasse', () => {
  it('ohne jede Angabe wird gefragt (bisheriges Verhalten, Konfiguration noch nicht geladen)', () => {
    expect(fragtNachOptionen({})).toBe(true)
    expect(fragtNachOptionen({ kasse: undefined, warengruppe: null, artikel: null })).toBe(true)
  })

  it('die Kasse entscheidet, wenn Warengruppe und Artikel nichts vorgeben', () => {
    expect(fragtNachOptionen({ kasse: true,  warengruppe: null, artikel: null })).toBe(true)
    expect(fragtNachOptionen({ kasse: false, warengruppe: null, artikel: null })).toBe(false)
  })

  it('die Warengruppe geht vor der Kasse (Küche fragt auch an der Bar-Kasse)', () => {
    expect(fragtNachOptionen({ kasse: false, warengruppe: true,  artikel: null })).toBe(true)
    expect(fragtNachOptionen({ kasse: true,  warengruppe: false, artikel: null })).toBe(false)
  })

  it('der Artikel geht vor Warengruppe und Kasse', () => {
    expect(fragtNachOptionen({ kasse: false, warengruppe: false, artikel: true  })).toBe(true)
    expect(fragtNachOptionen({ kasse: true,  warengruppe: true,  artikel: false })).toBe(false)
  })
})

describe('warengruppenWahl — Untergruppen erben von der Obergruppe', () => {
  const gruppen = [
    { id: 'kueche',  parentId: null,     optionenAbfrage: true },
    { id: 'speisen', parentId: 'kueche', optionenAbfrage: null },
    { id: 'bar',     parentId: null,     optionenAbfrage: false },
    { id: 'bier',    parentId: 'bar',    optionenAbfrage: true },
    { id: 'wein',    parentId: 'bar',    optionenAbfrage: null },
    { id: 'frei',    parentId: null,     optionenAbfrage: null },
  ]

  it('eigene Wahl gewinnt', () => {
    expect(warengruppenWahl(gruppen, 'bier')).toBe(true)
    expect(warengruppenWahl(gruppen, 'bar')).toBe(false)
  })

  it('ohne eigene Wahl gilt die der nächsten Obergruppe mit Wahl', () => {
    expect(warengruppenWahl(gruppen, 'speisen')).toBe(true)
    expect(warengruppenWahl(gruppen, 'wein')).toBe(false)
  })

  it('weder Gruppe noch Obergruppen mit Wahl → null (Kasse entscheidet)', () => {
    expect(warengruppenWahl(gruppen, 'frei')).toBeNull()
  })

  it('Artikel ohne Warengruppe oder mit unbekannter Warengruppe → null', () => {
    expect(warengruppenWahl(gruppen, null)).toBeNull()
    expect(warengruppenWahl(gruppen, undefined)).toBeNull()
    expect(warengruppenWahl(gruppen, 'gibt-es-nicht')).toBeNull()
  })

  it('ein Zyklus im Altbestand hängt nicht', () => {
    const kreis = [
      { id: 'a', parentId: 'b', optionenAbfrage: null },
      { id: 'b', parentId: 'a', optionenAbfrage: null },
    ]
    expect(warengruppenWahl(kreis, 'a')).toBeNull()
  })
})
