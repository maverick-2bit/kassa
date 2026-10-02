import { describe, it, expect } from 'vitest'
import {
  ausgeblendeteArtikelIds,
  baueKassenRaster,
  baueRaster,
  kompakteArtikelListe,
  loeseAnordnungAuf,
  RASTER_MAX_SLOT,
  type KassenAnordnungEintrag,
  type RasterZelle,
} from './raster.js'

/** Artikel mit ID = Bezeichnung (lesbar in den Erwartungen) */
const art = (id: string, rasterPosition: number | null = null, reihenfolge = 0) =>
  ({ id, bezeichnung: id, rasterPosition, reihenfolge })
type A = ReturnType<typeof art>

const platziert = (artikelId: string, position: number): KassenAnordnungEintrag =>
  ({ artikelId, position, ausgeblendet: false })
const versteckt = (artikelId: string): KassenAnordnungEintrag =>
  ({ artikelId, position: null, ausgeblendet: true })

const text = (z: RasterZelle<string, A>[]) =>
  z.map(c => (c.typ === 'gruppe' ? `G:${c.gruppe}` : c.typ === 'artikel' ? c.artikel.id : '_'))

const slots = (artikel: A[], eintraege?: KassenAnordnungEintrag[] | null) =>
  loeseAnordnungAuf(artikel, eintraege).slots.map(a => a?.id ?? '_')

describe('Kassen-Anordnung: keine Zeile = Standard-Layout', () => {
  const artikel = [art('Cola', 3), art('Fanta', 1), art('Soda', null, 5)]

  it('ohne Zeilen exakt wie baueRaster (undefined, null, leere Liste)', () => {
    const standard = text(baueRaster(['Bier'], artikel))
    expect(standard).toEqual(['G:Bier', 'Fanta', '_', 'Cola', 'Soda'])
    expect(text(baueKassenRaster(['Bier'], artikel))).toEqual(standard)
    expect(text(baueKassenRaster(['Bier'], artikel, null))).toEqual(standard)
    expect(text(baueKassenRaster(['Bier'], artikel, []))).toEqual(standard)
  })

  it('eigene = false, nichts ausgeblendet', () => {
    const r = loeseAnordnungAuf(artikel, [])
    expect(r.eigene).toBe(false)
    expect(r.ausgeblendet).toEqual([])
  })

  it('Zeilen, die nur zu fremden Artikeln gehören (verschoben/deaktiviert/gelöscht), zählen nicht → Standard', () => {
    const z = [platziert('Gibt-es-nicht', 1), versteckt('Auch-nicht')]
    const r = loeseAnordnungAuf(artikel, z)
    expect(r.eigene).toBe(false)
    expect(slots(artikel, z)).toEqual(['Fanta', '_', 'Cola', 'Soda'])
  })
})

describe('Kassen-Anordnung: eigene Zeilen gelten', () => {
  // Standard wäre: Fanta(1), _, Cola(3) — die Kasse will es anders
  const artikel = [art('Cola', 3), art('Fanta', 1), art('Soda', 2)]

  it('platzierte Artikel stehen an ihrem Slot, auch gegen die Standard-Position', () => {
    const z = [platziert('Cola', 1), platziert('Fanta', 2), platziert('Soda', 3)]
    expect(slots(artikel, z)).toEqual(['Cola', 'Fanta', 'Soda'])
    expect(loeseAnordnungAuf(artikel, z).eigene).toBe(true)
  })

  it('fehlende Slotnummern sind leere Felder (vorn, in der Mitte), am Ende gibt es keine', () => {
    const z = [platziert('Cola', 4), platziert('Fanta', 2), platziert('Soda', 7)]
    expect(slots(artikel, z)).toEqual(['_', 'Fanta', '_', 'Cola', '_', '_', 'Soda'])
  })

  it('Untergruppen-Kacheln bleiben vorn, Slot 1 ist die erste Zelle DANACH', () => {
    const z = [platziert('Cola', 2), platziert('Fanta', 1), platziert('Soda', 4)]
    expect(text(baueKassenRaster(['Bier', 'Wein'], artikel, z))).toEqual(['G:Bier', 'G:Wein', 'Fanta', 'Cola', '_', 'Soda'])
  })

  it('ausgeblendete Artikel erscheinen nicht im Raster, tauchen aber in `ausgeblendet` auf', () => {
    const z = [platziert('Cola', 1), versteckt('Fanta'), platziert('Soda', 2)]
    expect(slots(artikel, z)).toEqual(['Cola', 'Soda'])
    expect(loeseAnordnungAuf(artikel, z).ausgeblendet.map(a => a.id)).toEqual(['Fanta'])
  })

  it('ein ausgeblendeter Artikel wird NICHT hinten angehängt', () => {
    const z = [versteckt('Cola')]
    // Fanta, Soda haben keine Zeile → hinten angehängt (Standard-Reihenfolge); Cola bleibt weg
    expect(slots(artikel, z)).toEqual(['Fanta', 'Soda'])
  })

  it('ausgeblendet gewinnt über eine mitgelieferte Position', () => {
    const z: KassenAnordnungEintrag[] = [{ artikelId: 'Cola', position: 1, ausgeblendet: true }, platziert('Fanta', 1)]
    expect(slots(artikel, z)).toContain('Fanta')
    expect(slots(artikel, z)).not.toContain('Cola')
  })

  it('gleiche Eingabe ergibt gleiche Ausgabe (kein Zustand, Eingabe bleibt unverändert)', () => {
    const z = [platziert('Cola', 2)]
    const kopie = JSON.parse(JSON.stringify(z))
    const vorher = [...artikel]
    expect(slots(artikel, z)).toEqual(slots(artikel, z))
    expect(z).toEqual(kopie)
    expect(artikel).toEqual(vorher)
  })
})

describe('Kassen-Anordnung: Neulinge, Altbestand, Robustheit', () => {
  it('Artikel OHNE Zeile (später angelegt) werden hinter dem höchsten Slot angehängt — in Standard-Reihenfolge', () => {
    const artikel = [art('Cola'), art('Fanta'), art('Neu-B', null, 0), art('Neu-A', null, 0), art('Neu-Z', null, -1)]
    const z = [platziert('Fanta', 1), platziert('Cola', 3)]
    // Neu-Z (reihenfolge −1) vor Neu-A < Neu-B (Bezeichnung)
    expect(slots(artikel, z)).toEqual(['Fanta', '_', 'Cola', 'Neu-Z', 'Neu-A', 'Neu-B'])
  })

  it('Neulinge ohne jeden platzierten Artikel: kein Leerfeld, nur Anhängen', () => {
    const artikel = [art('Cola'), art('Fanta')]
    expect(slots(artikel, [versteckt('Cola')])).toEqual(['Fanta'])
  })

  it('die Standard-Position eines Neulings zählt in einer Kassen-Anordnung nicht — er kommt hinten dran', () => {
    const artikel = [art('Cola', 1), art('Neu', 2)]
    expect(slots(artikel, [platziert('Cola', 3)])).toEqual(['_', '_', 'Cola', 'Neu'])
  })

  it('doppelte Position: der erste in Standard-Reihenfolge gewinnt, der andere kommt hinten dran (nicht verloren)', () => {
    const artikel = [art('B', null, 2), art('A', null, 1)]
    const z = [platziert('A', 2), platziert('B', 2)]
    expect(slots(artikel, z)).toEqual(['_', 'A', 'B'])
  })

  it('ungültige Positionen (0, negativ, Bruchzahl, NaN, über dem Höchstwert, fehlend) hängen hinten an', () => {
    const artikel = [art('A', null, 1), art('B', null, 2), art('C', null, 3), art('D', null, 4), art('E', null, 5), art('F', null, 6), art('Ok', null, 7)]
    const z: KassenAnordnungEintrag[] = [
      { artikelId: 'A', position: 0, ausgeblendet: false },
      { artikelId: 'B', position: -3, ausgeblendet: false },
      { artikelId: 'C', position: 1.5, ausgeblendet: false },
      { artikelId: 'D', position: Number.NaN, ausgeblendet: false },
      { artikelId: 'E', position: RASTER_MAX_SLOT + 1, ausgeblendet: false },
      { artikelId: 'F', position: null, ausgeblendet: false },
      platziert('Ok', 2),
    ]
    expect(slots(artikel, z)).toEqual(['_', 'Ok', 'A', 'B', 'C', 'D', 'E', 'F'])
  })

  it('ein absurd hoher Slot sprengt die Schleife nicht (Altbestand/Direktzugriff)', () => {
    const artikel = [art('A'), art('B')]
    const z = [platziert('A', 2_000_000_000), platziert('B', 1)]
    const start = Date.now()
    expect(slots(artikel, z)).toEqual(['B', 'A'])
    expect(Date.now() - start).toBeLessThan(500)
    // auch im Standard-Layout
    expect(baueRaster([], [{ bezeichnung: 'x', reihenfolge: 0, rasterPosition: 2_000_000_000 }])).toHaveLength(1)
  })

  it('der höchste gültige Slot wird noch gesetzt', () => {
    const artikel = [art('A')]
    const r = slots(artikel, [platziert('A', RASTER_MAX_SLOT)])
    expect(r).toHaveLength(RASTER_MAX_SLOT)
    expect(r[RASTER_MAX_SLOT - 1]).toBe('A')
  })

  it('mehrere Zeilen zum selben Artikel: die erste zählt', () => {
    const artikel = [art('A'), art('B')]
    const z = [platziert('A', 3), platziert('A', 1), platziert('B', 1)]
    expect(slots(artikel, z)).toEqual(['B', '_', 'A'])
  })

  it('leere Gruppe ergibt leeres Raster, Untergruppen bleiben', () => {
    expect(baueKassenRaster([], [], [platziert('x', 1)])).toEqual([])
    expect(text(baueKassenRaster(['Bier'], [], []))).toEqual(['G:Bier'])
  })

  it('Zeilen zu Artikeln außerhalb von `artikel` (anderes Gruppenmitglied, deaktiviert) werden ignoriert, die übrigen gelten', () => {
    const artikel = [art('Cola'), art('Fanta')]
    const z = [platziert('Cola', 2), platziert('Weg', 1)]
    // Slot 1 bleibt leer (Weg kennt die Kasse in dieser Gruppe nicht), Fanta hängt hinten dran
    expect(slots(artikel, z)).toEqual(['_', 'Cola', 'Fanta'])
  })
})

describe('ausgeblendeteArtikelIds', () => {
  const artikel = [
    { id: 'Cola', kategorieId: 'G1' },
    { id: 'Fanta', kategorieId: 'G1' },
    { id: 'Pizza', kategorieId: 'G2' },
    { id: 'Lose', kategorieId: null },
  ]

  it('sammelt die ausgeblendeten Artikel aller Warengruppen', () => {
    const layouts = [
      { kategorieId: 'G1', eintraege: [versteckt('Cola'), platziert('Fanta', 1)] },
      { kategorieId: 'G2', eintraege: [versteckt('Pizza')] },
    ]
    expect([...ausgeblendeteArtikelIds(artikel, layouts)].sort()).toEqual(['Cola', 'Pizza'])
  })

  it('veraltete Zeilen (Artikel inzwischen in einer anderen Warengruppe), unbekannte Artikel und platzierte zählen nicht', () => {
    const layouts = [
      { kategorieId: 'G2', eintraege: [versteckt('Cola'), versteckt('Gibt-es-nicht'), platziert('Pizza', 1)] },
    ]
    expect(ausgeblendeteArtikelIds(artikel, layouts).size).toBe(0)
  })

  it('ohne Anordnung leer', () => {
    expect(ausgeblendeteArtikelIds(artikel, undefined).size).toBe(0)
    expect(ausgeblendeteArtikelIds(artikel, null).size).toBe(0)
    expect(ausgeblendeteArtikelIds(artikel, []).size).toBe(0)
  })
})

describe('kompakteArtikelListe (Kellner-App)', () => {
  const ids = (l: A[]) => l.map(a => a.id)

  it('ohne Anordnung exakt wie bisher nach reihenfolge (nicht nach Rasterposition), Gleichstand in Eingabereihenfolge', () => {
    const artikel = [art('Cola', 1, 3), art('Fanta', 9, 1), art('Soda', null, 1), art('Sprite', 2, 2)]
    expect(ids(kompakteArtikelListe(artikel))).toEqual(['Fanta', 'Soda', 'Sprite', 'Cola'])
    expect(ids(kompakteArtikelListe(artikel, []))).toEqual(['Fanta', 'Soda', 'Sprite', 'Cola'])
    expect(ids(kompakteArtikelListe(artikel, null))).toEqual(['Fanta', 'Soda', 'Sprite', 'Cola'])
  })

  it('mit eigener Anordnung: deren Reihenfolge ohne Leerfelder, ausgeblendete entfallen, Neulinge hinten', () => {
    const artikel = [art('Cola'), art('Fanta'), art('Soda'), art('Neu')]
    const z = [platziert('Soda', 1), platziert('Cola', 4), versteckt('Fanta')]
    expect(ids(kompakteArtikelListe(artikel, z))).toEqual(['Soda', 'Cola', 'Neu'])
  })

  it('Zeilen nur zu fremden Artikeln: Standard (reihenfolge)', () => {
    const artikel = [art('B', null, 2), art('A', null, 1)]
    expect(ids(kompakteArtikelListe(artikel, [platziert('Weg', 1)]))).toEqual(['A', 'B'])
  })

  it('verändert die Eingabe nicht', () => {
    const artikel = [art('B', null, 2), art('A', null, 1)]
    kompakteArtikelListe(artikel)
    expect(ids(artikel)).toEqual(['B', 'A'])
  })
})
