import { describe, it, expect } from 'vitest'
import { baueRaster, type RasterZelle } from './raster.js'
import { farbeZuHex, KategorieFarbeSchema, KATEGORIE_FARBE_HEX } from './schemas/kategorie.js'

const art = (bezeichnung: string, rasterPosition: number | null, reihenfolge = 0) =>
  ({ bezeichnung, rasterPosition, reihenfolge })

const beschreibe = (z: RasterZelle<string, ReturnType<typeof art>>[]) =>
  z.map(c => (c.typ === 'gruppe' ? `G:${c.gruppe}` : c.typ === 'artikel' ? `A:${c.artikel.bezeichnung}` : '_'))

describe('baueRaster', () => {
  it('Untergruppen zuerst, dann Artikel an ihrem Slot, Lücken leer', () => {
    const z = baueRaster(['Bier', 'Wein'], [art('c', 3), art('a', 1)])
    expect(beschreibe(z)).toEqual(['G:Bier', 'G:Wein', 'A:a', '_', 'A:c'])
  })
  it('ohne Positionen: flach nach reihenfolge/Bezeichnung, keine Leerfelder', () => {
    const z = baueRaster<string, ReturnType<typeof art>>([], [art('b', null, 2), art('a', null, 2), art('z', null, 1)])
    expect(beschreibe(z)).toEqual(['A:z', 'A:a', 'A:b'])
  })
  it('Artikel ohne Position werden hinter dem höchsten Slot angehängt', () => {
    const z = baueRaster<string, ReturnType<typeof art>>([], [art('x', null, 1), art('p', 2)])
    expect(beschreibe(z)).toEqual(['_', 'A:p', 'A:x'])
  })
  it('doppelter oder ungültiger Slot wird angehängt statt verloren', () => {
    const z = baueRaster<string, ReturnType<typeof art>>([], [art('a', 1, 1), art('b', 1, 2), art('c', 0, 3)])
    expect(beschreibe(z)).toEqual(['A:a', 'A:b', 'A:c'])
  })
  it('leere Gruppe ergibt leeres Raster', () => {
    expect(baueRaster([], [])).toEqual([])
  })
})

describe('farbeZuHex / KategorieFarbeSchema', () => {
  it('löst Namen und Hex auf, normalisiert auf Kleinbuchstaben', () => {
    expect(farbeZuHex('rot')).toBe(KATEGORIE_FARBE_HEX.rot)
    expect(farbeZuHex('#AABB0C')).toBe('#aabb0c')
    expect(farbeZuHex(null)).toBeUndefined()
    expect(farbeZuHex('blubb')).toBeUndefined()
    expect(farbeZuHex('toString')).toBeUndefined()
  })
  it('Schema akzeptiert Namen und Hex, lehnt anderes ab', () => {
    expect(KategorieFarbeSchema.parse('blau')).toBe('blau')
    expect(KategorieFarbeSchema.parse('#ABCDEF')).toBe('#abcdef')
    expect(KategorieFarbeSchema.safeParse('#abc').success).toBe(false)
    expect(KategorieFarbeSchema.safeParse('lachs').success).toBe(false)
  })
})
