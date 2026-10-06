import { describe, it, expect } from 'vitest'
import {
  KASSEN_LAYOUT_MAX_EINTRAEGE,
  KASSEN_LAYOUT_MAX_POSITION,
  KasseArtikelLayoutEintragSchema,
  KasseArtikelLayoutSchema,
  KasseArtikelLayoutUpdateSchema,
  StandardRasterUpdateSchema,
  STANDARD_RASTER_MAX_POSITION,
} from './artikel-layout.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const platziert = (n: number, position: number) => ({ artikelId: id(n), position, ausgeblendet: false })
const versteckt = (n: number) => ({ artikelId: id(n), position: null, ausgeblendet: true })

const meldungen = (r: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }) =>
  (r.error?.issues ?? []).map(i => `${i.path.join('.')}: ${i.message}`)

describe('KasseArtikelLayoutEintragSchema', () => {
  it('nimmt platzierte (mit Position) und ausgeblendete (ohne) Einträge', () => {
    expect(KasseArtikelLayoutEintragSchema.safeParse(platziert(1, 1)).success).toBe(true)
    expect(KasseArtikelLayoutEintragSchema.safeParse(platziert(1, KASSEN_LAYOUT_MAX_POSITION)).success).toBe(true)
    expect(KasseArtikelLayoutEintragSchema.safeParse(versteckt(1)).success).toBe(true)
  })

  it('lehnt Position 0, negativ, Bruchzahl und über dem Höchstwert ab', () => {
    for (const position of [0, -1, 1.5, KASSEN_LAYOUT_MAX_POSITION + 1, Number.NaN]) {
      expect(KasseArtikelLayoutEintragSchema.safeParse({ ...platziert(1, 1), position }).success, String(position)).toBe(false)
    }
  })

  it('ausgeblendet MIT Position und platziert OHNE Position sind ungültig', () => {
    expect(KasseArtikelLayoutEintragSchema.safeParse({ artikelId: id(1), position: 3, ausgeblendet: true }).success).toBe(false)
    expect(KasseArtikelLayoutEintragSchema.safeParse({ artikelId: id(1), position: null, ausgeblendet: false }).success).toBe(false)
  })

  it('verlangt eine uuid als artikelId', () => {
    expect(KasseArtikelLayoutEintragSchema.safeParse({ artikelId: 'kein-uuid', position: 1, ausgeblendet: false }).success).toBe(false)
  })
})

describe('KasseArtikelLayoutUpdateSchema', () => {
  it('akzeptiert eine gemischte Anordnung und die leere Liste (= zurück auf Standard)', () => {
    expect(KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: [platziert(1, 2), platziert(2, 1), versteckt(3)] }).success).toBe(true)
    expect(KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: [] }).success).toBe(true)
  })

  it('lehnt doppelte Positionen ab und nennt die Stelle', () => {
    const r = KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: [platziert(1, 2), platziert(2, 2)] })
    expect(r.success).toBe(false)
    expect(meldungen(r)).toEqual(['eintraege.1.position: Position 2 ist mehrfach vergeben'])
  })

  it('lehnt denselben Artikel zweimal ab (auch wenn einmal ausgeblendet)', () => {
    const r = KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: [platziert(1, 1), versteckt(1)] })
    expect(r.success).toBe(false)
    expect(meldungen(r)).toEqual(['eintraege.1.artikelId: Artikel kommt mehrfach vor'])
  })

  it('mehrere ausgeblendete Einträge (alle position null) sind KEINE doppelte Position', () => {
    expect(KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: [versteckt(1), versteckt(2), versteckt(3)] }).success).toBe(true)
  })

  it('begrenzt die Zahl der Einträge', () => {
    const viele = Array.from({ length: KASSEN_LAYOUT_MAX_EINTRAEGE + 1 }, (_, i) => versteckt(i + 1))
    expect(KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: viele }).success).toBe(false)
    expect(KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: viele.slice(1) }).success).toBe(true)
  })

  it('verlangt das Feld eintraege', () => {
    expect(KasseArtikelLayoutUpdateSchema.safeParse({}).success).toBe(false)
    expect(KasseArtikelLayoutUpdateSchema.safeParse({ eintraege: 'x' }).success).toBe(false)
  })
})

describe('KasseArtikelLayoutSchema (Antwort)', () => {
  it('beschreibt eine Warengruppe samt Einträgen', () => {
    expect(KasseArtikelLayoutSchema.safeParse({ kategorieId: id(9), eintraege: [platziert(1, 1), versteckt(2)] }).success).toBe(true)
  })
})

describe('StandardRasterUpdateSchema', () => {
  it('Slot oder null je Artikel; bis 999 wie ArtikelInput/Layout-Import', () => {
    expect(StandardRasterUpdateSchema.safeParse({ eintraege: [
      { artikelId: id(1), position: 1 },
      { artikelId: id(2), position: STANDARD_RASTER_MAX_POSITION },
      { artikelId: id(3), position: null },
      { artikelId: id(4), position: null },
    ] }).success).toBe(true)
    expect(StandardRasterUpdateSchema.safeParse({ eintraege: [{ artikelId: id(1), position: STANDARD_RASTER_MAX_POSITION + 1 }] }).success).toBe(false)
    expect(StandardRasterUpdateSchema.safeParse({ eintraege: [{ artikelId: id(1), position: 0 }] }).success).toBe(false)
  })

  it('doppelte Positionen und doppelte Artikel abgelehnt', () => {
    expect(StandardRasterUpdateSchema.safeParse({ eintraege: [
      { artikelId: id(1), position: 4 }, { artikelId: id(2), position: 4 },
    ] }).success).toBe(false)
    expect(StandardRasterUpdateSchema.safeParse({ eintraege: [
      { artikelId: id(1), position: 4 }, { artikelId: id(1), position: 5 },
    ] }).success).toBe(false)
  })
})
