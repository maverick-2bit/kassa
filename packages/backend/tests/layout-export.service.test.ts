/**
 * Layout-Export (reine Logik): Gruppenbaum, Auswahl, Farben, MwSt, Raster-Plätze, Optionen — und der Rundlauf:
 * was der Export schreibt, plant der Import in einer leeren Kassa genauso wieder an.
 */

import { describe, it, expect } from 'vitest'
import { farbeZuHex, LayoutImportSchema, type LayoutImport } from '@kassa/shared'
import {
  baueLayoutExport, type ExportArtikel, type ExportGruppe, type ExportOptionsgruppe, type ExportZustand,
} from '../src/services/layout-export.service.js'
import { planeLayout, satzZuMwst, mwstZuSatz, type KassaZustand } from '../src/services/layout-import.service.js'

const gruppe = (id: string, name: string, o: Partial<ExportGruppe> = {}): ExportGruppe =>
  ({ id, name, parentId: null, farbe: 'grau', reihenfolge: 0, station: null, aktiv: true, ...o })

const artikel = (id: string, bezeichnung: string, kategorieId: string | null, o: Partial<ExportArtikel> = {}): ExportArtikel => ({
  id, bezeichnung, artikelnummer: null, preisBruttoCent: 350, mwstSatz: 'normal', farbe: null, kategorieId,
  rasterPosition: null, reihenfolge: 0, allergene: null, aktiv: true, istBestandteil: false, ...o,
})

const zustand = (o: Partial<ExportZustand> = {}): ExportZustand =>
  ({ firmenname: 'smarte events OG', gruppen: [], artikel: [], optionsgruppen: [], zuordnungen: [], ...o })

const og = (id: string, name: string, typ: string, maxAuswahl: number | null, optionen: [string, number][]): ExportOptionsgruppe =>
  ({ id, name, typ, maxAuswahl, optionen: optionen.map(([n, a], i) => ({ name: n, aufschlagCent: a, reihenfolge: i })) })

const namen = (l: { name: string }[]) => l.map(x => x.name)

/** Kellner Getränke (mit Untergruppe Bier) und Kellner Speisen — wie in der Beschreibung des Nutzers */
function kellnerKatalog(): ExportZustand {
  return zustand({
    gruppen: [
      gruppe('g1', 'Kellner Getränke', { reihenfolge: 0, farbe: 'blau', station: 'schank' }),
      gruppe('g2', 'Kellner Speisen',  { reihenfolge: 1, farbe: '#AA5500', station: 'kueche' }),
      gruppe('g3', 'Bier', { parentId: 'g1', reihenfolge: 0, farbe: 'gold' }),
      gruppe('g9', 'Büro', { reihenfolge: 2 }),
    ],
    artikel: [
      artikel('a1', 'Cola 0,33',  'g1', { rasterPosition: 1, preisBruttoCent: 320 }),
      artikel('a2', 'Wasser',     'g1', { rasterPosition: 2, preisBruttoCent: 290, mwstSatz: 'ermaessigt1' }),
      artikel('a3', 'Pils 0,5',   'g3', { rasterPosition: 1, preisBruttoCent: 450 }),
      artikel('a4', 'Schnitzel',  'g2', { rasterPosition: 1, preisBruttoCent: 1450, allergene: 'A,C', artikelnummer: '0007', farbe: 'rot' }),
      artikel('a5', 'Pfand-Rückgabe', 'g1', { rasterPosition: 3, preisBruttoCent: -50, mwstSatz: 'null' }),
      artikel('a6', 'Kopierpapier', 'g9'),
    ],
  })
}

describe('baueLayoutExport: Aufbau', () => {
  it('Hauptgruppen und Untergruppen in Reihenfolge, Farben als Hex, Stationen, Artikel mit Preis und MwSt', () => {
    const { layout, zusammenfassung } = baueLayoutExport(kellnerKatalog())
    expect(namen(layout.gruppen)).toEqual(['Kellner Getränke', 'Kellner Speisen', 'Büro'])
    const getraenke = layout.gruppen[0]!
    expect(getraenke).toMatchObject({ farbe: farbeZuHex('blau'), station: 'schank', reihenfolge: 0 })
    expect(namen(getraenke.untergruppen)).toEqual(['Bier'])
    expect(getraenke.untergruppen[0]!.artikel.map(a => [a.name, a.preisCent, a.mwst, a.slot])).toEqual([['Pils 0,5', 450, 0.2, 1]])
    expect(getraenke.artikel.map(a => [a.name, a.preisCent, a.mwst, a.slot])).toEqual([
      ['Cola 0,33', 320, 0.2, 1], ['Wasser', 290, 0.1, 2], ['Pfand-Rückgabe', -50, 0, 3],
    ])
    // Hex bleibt (klein geschrieben), Artikelfarbe als Hex, Nummer und Allergene mit
    const speisen = layout.gruppen[1]!
    expect(speisen.farbe).toBe('#aa5500')
    expect(speisen.artikel[0]).toMatchObject({ name: 'Schnitzel', nr: '0007', allergene: 'A,C', farbe: farbeZuHex('rot'), preisCent: 1450 })
    expect(zusammenfassung).toEqual({ gruppen: 4, artikel: 6, optionsgruppen: 0 })
  })

  it('die Datei ist für den Import gültig und trägt Herkunft samt Datum; Favoriten und Spalten fehlen bewusst', () => {
    const { layout } = baueLayoutExport(kellnerKatalog(), { datum: '2026-10-16' })
    expect(layout.quelle).toBe('Kassa-Export smarte events OG (2026-10-16)')
    expect(layout.favoriten).toEqual([])
    expect(layout.spalten).toBeUndefined()
    expect(LayoutImportSchema.safeParse(layout).success).toBe(true)
  })

  it('unbekannte Farben fallen auf die Standardfarbe, ungültige Stationen entfallen', () => {
    const { layout } = baueLayoutExport(zustand({ gruppen: [gruppe('g', 'X', { farbe: 'quatsch', station: 'irgendwas' })] }))
    expect(layout.gruppen[0]).toMatchObject({ farbe: '#637685', station: null })
  })
})

describe('baueLayoutExport: Auswahl', () => {
  it('eine gewählte Gruppe nimmt ihre Untergruppen mit — andere Gruppen bleiben draußen', () => {
    const { layout, zusammenfassung } = baueLayoutExport(kellnerKatalog(), { kategorieIds: ['g1', 'g2'] })
    expect(namen(layout.gruppen)).toEqual(['Kellner Getränke', 'Kellner Speisen'])
    expect(namen(layout.gruppen[0]!.untergruppen)).toEqual(['Bier'])
    expect(zusammenfassung).toEqual({ gruppen: 3, artikel: 5, optionsgruppen: 0 })
  })

  it('nur eine Untergruppe gewählt: sie wird zur obersten Gruppe der Datei', () => {
    const { layout } = baueLayoutExport(kellnerKatalog(), { kategorieIds: ['g3'] })
    expect(namen(layout.gruppen)).toEqual(['Bier'])
  })

  it('Eltern UND Kind gewählt: die Untergruppe steht nur einmal, unter ihrer Gruppe', () => {
    const { layout, zusammenfassung } = baueLayoutExport(kellnerKatalog(), { kategorieIds: ['g1', 'g3'] })
    expect(namen(layout.gruppen)).toEqual(['Kellner Getränke'])
    expect(namen(layout.gruppen[0]!.untergruppen)).toEqual(['Bier'])
    expect(zusammenfassung.gruppen).toBe(2)
  })

  it('unbekannte und inaktive IDs ändern nichts; ohne Auswahl (leer) gilt: alle', () => {
    const z = kellnerKatalog()
    z.gruppen.push(gruppe('g8', 'Alt', { aktiv: false }))
    expect(namen(baueLayoutExport(z, { kategorieIds: ['gibt-es-nicht', 'g8'] }).layout.gruppen)).toEqual([])
    expect(namen(baueLayoutExport(z, { kategorieIds: [] }).layout.gruppen)).toEqual(['Kellner Getränke', 'Kellner Speisen', 'Büro'])
    expect(namen(baueLayoutExport(z).layout.gruppen)).toEqual(['Kellner Getränke', 'Kellner Speisen', 'Büro'])
  })
})

describe('baueLayoutExport: was nicht mitkommt', () => {
  it('inaktive Artikel, Rohstoffe und inaktive Untergruppen fehlen; Artikel ohne Gruppe nur mit Hinweis', () => {
    const z = kellnerKatalog()
    z.artikel.push(
      artikel('x1', 'Alt', 'g1', { aktiv: false }),
      artikel('x2', 'Mehl', 'g2', { istBestandteil: true }),
      artikel('x3', 'Ohne Gruppe', null),
    )
    z.gruppen.push(gruppe('g7', 'Stillgelegt', { parentId: 'g1', aktiv: false }))
    const { layout, hinweise } = baueLayoutExport(z)
    const alleArtikel = JSON.stringify(layout)
    expect(alleArtikel).not.toContain('Alt"')
    expect(alleArtikel).not.toContain('Mehl')
    expect(alleArtikel).not.toContain('Stillgelegt')
    expect(hinweise).toEqual(['1 Artikel ohne Warengruppe sind nicht enthalten (der Import ordnet Artikel über ihre Gruppe zu).'])
    // Bei einer ausdrücklichen Auswahl ist das kein Thema
    expect(baueLayoutExport(z, { kategorieIds: ['g1'] }).hinweise).toEqual([])
  })

  it('ein unbekannter Steuersatz lässt den Artikel aus — mit Hinweis statt einer kaputten Datei', () => {
    const z = zustand({ gruppen: [gruppe('g', 'X')], artikel: [artikel('a', 'Seltsam', 'g', { mwstSatz: 'sonderfall' }), artikel('b', 'Normal', 'g')] })
    const { layout, hinweise, zusammenfassung } = baueLayoutExport(z)
    expect(layout.gruppen[0]!.artikel.map(a => a.name)).toEqual(['Normal'])
    expect(zusammenfassung.artikel).toBe(1)
    expect(hinweise).toEqual(['1 Artikel mit unbekanntem Steuersatz sind nicht enthalten: Seltsam'])
  })
})

describe('baueLayoutExport: Raster-Plätze', () => {
  it('gesetzte Plätze bleiben (auch mit Lücken); Artikel ohne Platz füllen die Lücken von vorn', () => {
    const z = zustand({
      gruppen: [gruppe('g', 'X')],
      artikel: [
        artikel('a', 'Eins', 'g', { rasterPosition: 1 }),
        artikel('b', 'Fünf', 'g', { rasterPosition: 5 }),
        artikel('c', 'Ohne A', 'g', { reihenfolge: 1 }),
        artikel('d', 'Ohne B', 'g', { reihenfolge: 2 }),
      ],
    })
    const slots = baueLayoutExport(z).layout.gruppen[0]!.artikel.map(a => [a.name, a.slot])
    expect(slots).toEqual([['Eins', 1], ['Fünf', 5], ['Ohne A', 2], ['Ohne B', 3]])
  })

  it('doppelt vergebene Plätze: der zweite Artikel bekommt einen freien', () => {
    const z = zustand({
      gruppen: [gruppe('g', 'X')],
      artikel: [artikel('a', 'A', 'g', { rasterPosition: 2, reihenfolge: 1 }), artikel('b', 'B', 'g', { rasterPosition: 2, reihenfolge: 2 })],
    })
    const slots = baueLayoutExport(z).layout.gruppen[0]!.artikel.map(a => a.slot)
    expect(new Set(slots).size).toBe(2)
    expect(slots).toContain(2)
  })
})

describe('baueLayoutExport: Optionen', () => {
  const z = (): ExportZustand => zustand({
    gruppen: [gruppe('g', 'Getränke')],
    artikel: [artikel('a', 'Spritzer', 'g', { rasterPosition: 1 }), artikel('b', 'Wasser', 'g', { rasterPosition: 2 })],
    optionsgruppen: [
      og('o1', 'Größe', 'pflicht', 1, [['Klein', 0], ['Groß', 100]]),
      og('o2', 'Extras (Eis / Zitrone)', 'optional', null, [['Eis', 0], ['Zitrone', 20], ['Ohne Soda', -30]]),
      og('o3', 'Leer', 'optional', null, []),
      og('o4', 'Zwei davon', 'optional', 2, [['A', 0], ['B', 0], ['C', 0]]),
    ],
    zuordnungen: [
      { artikelId: 'a', gruppeId: 'o2', reihenfolge: 1 },
      { artikelId: 'a', gruppeId: 'o1', reihenfolge: 0 },
      { artikelId: 'a', gruppeId: 'o3', reihenfolge: 2 },
      { artikelId: 'a', gruppeId: 'o4', reihenfolge: 3 },
      { artikelId: 'a', gruppeId: 'weg', reihenfolge: 4 },
      { artikelId: 'b', gruppeId: 'o1', reihenfolge: 0 },
    ],
  })

  it('Namen bleiben unverändert (exakterName), Pflicht und Auswahlgrenze stimmen, Reihenfolge wie am Artikel', () => {
    const a = baueLayoutExport(z()).layout.gruppen[0]!.artikel[0]!
    expect(a.optionen.map(o => [o.gruppe, o.exakterName, o.pflicht, o.mehrfach, o.maxAuswahl])).toEqual([
      ['Größe', true, true, false, 1],
      ['Extras (Eis / Zitrone)', true, false, true, null],
      ['Zwei davon', true, false, false, 2],
    ])
    expect(a.optionen[1]!.optionen).toEqual([
      { name: 'Eis', aufschlagCent: 0 }, { name: 'Zitrone', aufschlagCent: 20 }, { name: 'Ohne Soda', aufschlagCent: -30 },
    ])
  })

  it('Gruppen ohne aktive Optionen und unbekannte Zuordnungen entfallen; die Zählung zählt jede Gruppe einmal', () => {
    const { zusammenfassung } = baueLayoutExport(z())
    expect(zusammenfassung.optionsgruppen).toBe(3)         // Größe (an zwei Artikeln), Extras, Zwei davon
  })
})

describe('Rundlauf: Export → Import-Planung in einer leeren Kassa', () => {
  const leer: KassaZustand = { gruppen: [], artikel: [], kassen: [], kassenFavoritenAnzahl: 0 }
  const opts = { dryRun: true, fehlendeAnlegen: true, spaltenSetzen: true, katalogLoeschen: false }

  it('legt dieselben Gruppen und Artikel mit denselben Werten an', () => {
    const z = kellnerKatalog()
    z.optionsgruppen = [og('o1', 'Größe', 'pflicht', 1, [['Klein', 0], ['Groß', 100]]), og('o4', 'Zwei davon', 'optional', 2, [['A', 0], ['B', 0]])]
    z.zuordnungen = [{ artikelId: 'a1', gruppeId: 'o1', reihenfolge: 0 }, { artikelId: 'a1', gruppeId: 'o4', reihenfolge: 1 }]

    const { layout } = baueLayoutExport(z, { kategorieIds: ['g1', 'g2'] })
    const datei = LayoutImportSchema.parse(JSON.parse(JSON.stringify(layout)))      // so liest es der Import aus der Datei
    const plan = planeLayout(leer, datei, opts)

    expect(plan.neueGruppen.map(g => [g.name, g.farbe, g.station, g.reihenfolge])).toEqual([
      ['Kellner Getränke', farbeZuHex('blau'), 'schank', 0],
      // Bier hat keine eigene Station und erbt die der Elterngruppe — der Import schreibt sie ausdrücklich dazu (wirkt gleich)
      ['Bier', farbeZuHex('gold'), 'schank', 0],
      ['Kellner Speisen', '#aa5500', 'kueche', 1],
    ])
    const gruppeId = (name: string) => plan.neueGruppen.find(g => g.name === name)!.id
    expect(plan.neueGruppen.find(g => g.name === 'Bier')!.parentId).toBe(gruppeId('Kellner Getränke'))

    const mitMwst = plan.neueArtikel.map(a => [a.bezeichnung, a.preisBruttoCent, a.mwstSatz, a.rasterPosition, a.allergene])
    expect(mitMwst).toEqual(expect.arrayContaining([
      ['Cola 0,33', 320, 'normal', 1, null],
      ['Wasser', 290, 'ermaessigt1', 2, null],
      ['Pfand-Rückgabe', -50, 'null', 3, null],
      ['Pils 0,5', 450, 'normal', 1, null],
      ['Schnitzel', 1450, 'normal', 1, 'A,C'],
    ]))
    expect(plan.neueArtikel).toHaveLength(5)
    expect(plan.neueArtikel.find(a => a.bezeichnung === 'Schnitzel')!.kategorieId).toBe(gruppeId('Kellner Speisen'))

    // Optionen: exakter Name und Auswahlgrenze überleben den Weg (kein „Größe (Klein / Groß)")
    expect(plan.optionen.map(o => [o.name, o.typ, o.maxAuswahl])).toEqual([['Größe', 'pflicht', 1], ['Zwei davon', 'optional', 2]])
    expect(plan.bericht.zaehler.artikel).toMatchObject({ imLayout: 5, neu: 5 })
    expect(plan.bericht.zaehler.gruppen).toMatchObject({ imLayout: 3, neu: 3 })
  })

  it('Dateien OHNE die neuen Felder (Asello) verhalten sich wie bisher: Optionsname mit Vorschau, mehrfach → unbegrenzt', () => {
    const asello: LayoutImport = LayoutImportSchema.parse({
      gruppen: [{ name: 'Getränke', farbe: '#112233', artikel: [{
        name: 'Spritzer', preisCent: 300, mwst: 0.2, slot: 1,
        optionen: [{ gruppe: 'Variante', pflicht: true, mehrfach: false, optionen: [{ name: 'mit Eis' }, { name: 'mit Zitrone' }] },
                   { gruppe: 'Extras', mehrfach: true, optionen: [{ name: 'Strohhalm', aufschlagCent: 10 }] }],
      }] }],
    })
    const plan = planeLayout(leer, asello, opts)
    expect(plan.optionen.map(o => [o.name, o.maxAuswahl])).toEqual([['Variante (mit Eis / mit Zitrone)', 1], ['Extras (Strohhalm)', null]])
    expect(plan.neueArtikel[0]!.allergene).toBeNull()
  })
})

describe('Steuersatz-Zuordnung (Export ↔ Import)', () => {
  it('satzZuMwst ist die Umkehrung von mwstZuSatz', () => {
    for (const satz of ['normal', 'ermaessigt1', 'ermaessigt2', 'null', 'besonders']) {
      expect(mwstZuSatz(satzZuMwst(satz)!)).toBe(satz)
    }
    expect(satzZuMwst('quatsch')).toBeUndefined()
  })
})
