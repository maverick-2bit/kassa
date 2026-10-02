/**
 * Layout-Import: Namens-Normalisierung, Matching (Mehrdeutigkeit, Präfix-Gruppen),
 * Raster/Farben/Favoriten und Idempotenz — reine Planung ohne Datenbank.
 */

import { describe, it, expect } from 'vitest'
import { LayoutImportSchema, type LayoutImport, type LayoutImportOptionen } from '@kassa/shared'
import {
  mwstZuSatz, namensPassung, normalisiereName, planeLayout, STANDARD_GRUPPENFARBE,
  type KassaArtikel, type KassaGruppe, type KassaZustand,
} from '../src/services/layout-import.service.js'
import { flacherKassaZustand, ladeAselloLayout, testId, wendePlanAn } from './helpers/layout-kassa.js'

const OPT: LayoutImportOptionen = { dryRun: false, fehlendeAnlegen: true, spaltenSetzen: true, katalogLoeschen: false }

// ---------------------------------------------------------------------------
describe('normalisiereName / namensPassung / mwstZuSatz', () => {
  it('lowercase, Whitespace gekürzt, Apostrophe vereinheitlicht, führendes # ignoriert', () => {
    expect(normalisiereName("  Brez´n ")).toBe("brez'n")
    expect(normalisiereName('Brez`n')).toBe("brez'n")
    expect(normalisiereName("Brez'n")).toBe("brez'n")
    expect(normalisiereName('Brez’n')).toBe("brez'n")
    expect(normalisiereName('#Berliner   Luft')).toBe('berliner luft')
    expect(normalisiereName('# Berliner Luft')).toBe('berliner luft')
    expect(normalisiereName('GRÜNER  Veltliner')).toBe('grüner veltliner')
    expect(normalisiereName('Nuss Torte')).toBe('nuss torte')
  })
  it('Namenspassung: gleich > Präfix-Variante > nein', () => {
    expect(namensPassung('Speisen', 'speisen')).toBe(2)
    expect(namensPassung('Kellner Speisen', 'Speisen')).toBe(1)
    expect(namensPassung('Event Alkoholfrei', 'Alkoholfrei')).toBe(1)
    expect(namensPassung('Weinkeller', 'Wein')).toBe(0)
    expect(namensPassung('Wein', 'Kellner Wein')).toBe(0)
  })
  it('MwSt-Anteil auf Kassa-Satz', () => {
    expect(mwstZuSatz(0.2)).toBe('normal')
    expect(mwstZuSatz(0.1)).toBe('ermaessigt1')
    expect(mwstZuSatz(0.13)).toBe('ermaessigt2')
    expect(mwstZuSatz(0)).toBe('null')
    expect(mwstZuSatz(0.19)).toBe('besonders')
    expect(mwstZuSatz(0.07)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Kleines Layout zum Durchrechnen einzelner Regeln
// ---------------------------------------------------------------------------

const grp = (name: string, farbe: string, artikel: [string, number, (string | null)?][] = [], untergruppen: unknown[] = [], extra: object = {}) => ({
  name, farbe, farbeGesetzt: true, artikel: artikel.map(([n, slot, f]) => ({ name: n, preisCent: 300, mwst: 0.2, slot, farbe: f ?? null })),
  untergruppen, ...extra,
})
const mkLayout = (gruppen: unknown[], favoriten: unknown[] = []): LayoutImport =>
  LayoutImportSchema.parse({ spalten: 3, gruppen, favoriten })

const kg = (name: string, extra: Partial<KassaGruppe> = {}): KassaGruppe => ({
  id: testId(), name, parentId: null, aktiv: true, farbe: 'grau', reihenfolge: 0,
  station: null, bonierdruckerId: null, terminalSichtbar: false, ...extra,
})
const ka = (bezeichnung: string, kategorieId: string | null, extra: Partial<KassaArtikel> = {}): KassaArtikel => ({
  id: testId(), bezeichnung, kategorieId, farbe: null, rasterPosition: null, reihenfolge: 0,
  istFavorit: false, favoritenReihenfolge: 0, aktiv: true, istBestandteil: false, ...extra,
})
const zustand = (gruppen: KassaGruppe[], artikel: KassaArtikel[]): KassaZustand =>
  ({ gruppen, artikel, kassen: [{ id: testId(), artikelProZeile: 4 }], kassenFavoritenAnzahl: 0 })

describe('Matching', () => {
  it('eindeutiger Name wird zugeordnet, Preis/Station bleiben unberührt, Slot/Farbe/Gruppe gesetzt', () => {
    const wein = kg('Wein', { station: 'schank', bonierdruckerId: testId() })
    const spritzer = ka('Spritzer', wein.id)
    const plan = planeLayout(
      zustand([wein], [spritzer]),
      mkLayout([grp('Bar', '#e76815', [], [grp('Wein', '#60aa30', [['Spritzer', 4, '#AABBCC']])])]),
      OPT,
    )
    expect(plan.bericht.zaehler.artikel).toMatchObject({ zugeordnet: 1, neu: 0, mehrdeutig: 0, geaendert: 1 })
    expect(plan.artikelUpdates).toEqual([{ id: spritzer.id, werte: { farbe: '#aabbcc', rasterPosition: 4, reihenfolge: 4 } }])
    // bestehende Gruppe „Wein" wiederverwendet (Station bleibt!), unter die neue Hauptgruppe „Bar" gehängt
    expect(plan.neueGruppen.map(g => g.name)).toEqual(['Bar'])
    expect(plan.gruppenUpdates).toEqual([{ id: wein.id, werte: { parentId: plan.neueGruppen[0]!.id, farbe: '#60aa30' } }])
  })

  it('Apostroph-/Groß-Kleinschreibung-Varianten matchen', () => {
    const g = kg('Speisen')
    const brezn = ka("brez'n", g.id)
    const plan = planeLayout(zustand([g], [brezn]), mkLayout([grp('Speisen', '#112233', [['Brez´n', 1]])]), OPT)
    expect(plan.bericht.zaehler.artikel.zugeordnet).toBe(1)
    expect(plan.neueArtikel).toHaveLength(0)
  })

  it('gleicher Name in zwei Gruppen: je Gruppe ein eigener Kassa-Artikel (Präfix-Gruppe)', () => {
    const speisen = kg('Speisen'), kSpeisen = kg('Kellner Speisen')
    const b1 = ka('Brez´n', speisen.id), b2 = ka('Brez´n', kSpeisen.id)
    const plan = planeLayout(
      zustand([speisen, kSpeisen], [b2, b1]),
      mkLayout([grp('Atriumbar', '#e76815', [], [grp('Speisen', '#111111', [['Brez´n', 1]])]), grp('Kellner Speisen', '#222222', [['Brez´n', 1]])]),
      OPT,
    )
    expect(plan.bericht.zaehler.artikel).toMatchObject({ zugeordnet: 2, neu: 0, mehrdeutig: 0, geaendert: 2 })
    // b1 (Gruppe Speisen) → Atriumbar/Speisen, b2 (Kellner Speisen) → Kellner Speisen: Gruppen bleiben, nichts getauscht
    expect(plan.artikelUpdates.map(u => u.id).sort()).toEqual([b1.id, b2.id].sort())
    expect(plan.artikelUpdates.every(u => u.werte.kategorieId === undefined)).toBe(true)
    expect(plan.neueGruppen.map(g => g.name)).toEqual(['Atriumbar'])
  })

  it('zwei Layout-Artikel gleichen Namens, aber nur ein Kassa-Artikel → der zweite wird neu angelegt', () => {
    const speisen = kg('Speisen')
    const b1 = ka('Brez´n', speisen.id)
    const plan = planeLayout(
      zustand([speisen], [b1]),
      mkLayout([grp('Speisen', '#111111', [['Brez´n', 1]]), grp('Kellner Speisen', '#222222', [['Brez´n', 1]])]),
      OPT,
    )
    expect(plan.bericht.zaehler.artikel).toMatchObject({ zugeordnet: 1, neu: 1 })
    expect(plan.neueArtikel[0]).toMatchObject({ bezeichnung: 'Brez´n', mwstSatz: 'normal', preisBruttoCent: 300 })
  })

  it('mehrdeutig: gleicher Name, Gruppen passen nicht → gemeldet und NICHT angefasst', () => {
    const a = kg('Getränke'), b = kg('Sonstiges')
    const c1 = ka('Cola', a.id), c2 = ka('Cola', b.id)
    const plan = planeLayout(zustand([a, b], [c1, c2]), mkLayout([grp('Bar', '#111111', [['Cola', 1]])]), OPT)
    expect(plan.bericht.zaehler.artikel).toMatchObject({ zugeordnet: 0, mehrdeutig: 1, neu: 0 })
    expect(plan.bericht.probleme.mehrdeutig[0]).toMatchObject({ name: 'Cola', pfad: 'Bar' })
    expect(plan.bericht.probleme.mehrdeutig[0]!.kandidaten).toHaveLength(2)
    expect(plan.artikelUpdates).toEqual([])
    expect(plan.neueArtikel).toEqual([])
  })

  it('mehrdeutig: ein Kassa-Artikel, zwei gleichwertige Layout-Gruppen → keiner wird angefasst', () => {
    const g = kg('Wein')
    const w = ka('Weißer Spritzer', g.id)
    const plan = planeLayout(
      zustand([g], [w]),
      mkLayout([grp('Eins', '#111111', [], [grp('Wein', '#222222', [['Weißer Spritzer', 1]])]), grp('Zwei', '#333333', [], [grp('Wein', '#444444', [['Weißer Spritzer', 1]])])]),
      OPT,
    )
    expect(plan.bericht.zaehler.artikel.mehrdeutig).toBe(2)
    expect(plan.artikelUpdates).toEqual([])
  })

  it('inaktive und Rohstoff-Artikel werden nicht gematcht', () => {
    const g = kg('Bar')
    const alt = ka('Cola', g.id, { aktiv: false }), roh = ka('Cola', g.id, { istBestandteil: true })
    const plan = planeLayout(zustand([g], [alt, roh]), mkLayout([grp('Bar', '#111111', [['Cola', 1]])]), OPT)
    expect(plan.bericht.zaehler.artikel).toMatchObject({ zugeordnet: 0, neu: 1 })
  })

  it('fehlendeAnlegen=false: nicht gefunden, nicht angelegt; unbekannter Steuersatz ebenso', () => {
    const l = LayoutImportSchema.parse({ gruppen: [{ ...grp('Bar', '#111111', [['Neu', 1]]), artikel: [
      { name: 'Neu', preisCent: 100, mwst: 0.2, slot: 1 }, { name: 'Komisch', preisCent: 100, mwst: 0.07, slot: 2 },
    ] }] })
    const aus = planeLayout(zustand([], []), l, { ...OPT, fehlendeAnlegen: false })
    expect(aus.bericht.zaehler.artikel).toMatchObject({ neu: 0, nichtGefundenNichtAngelegt: 2 })
    const an = planeLayout(zustand([], []), l, OPT)
    expect(an.bericht.zaehler.artikel).toMatchObject({ neu: 1, nichtGefundenNichtAngelegt: 1 })
    expect(an.bericht.probleme.nichtGefunden[0]!.grund).toMatch(/Steuersatz/)
  })

  it('doppelter Slot in einem Knoten: zweiter ohne Raster-Position, gemeldet', () => {
    const plan = planeLayout(zustand([], []), mkLayout([grp('Bar', '#111111', [['A', 2], ['B', 2]])]), OPT)
    expect(plan.bericht.probleme.doppelteSlots).toEqual([{ name: 'B', pfad: 'Bar', slot: 2 }])
    expect(plan.neueArtikel.map(a => a.rasterPosition)).toEqual([2, null])
  })
})

describe('Gruppen', () => {
  it('Präfix-Gruppe mit den meisten Artikeln gewinnt; neue Gruppe erbt Station/Bonierdrucker der häufigsten bisherigen', () => {
    const drucker = testId()
    const plain = kg('Alkoholfrei'), kellner = kg('Kellner Alkoholfrei', { station: 'schank', bonierdruckerId: drucker, terminalSichtbar: true })
    const arts = [ka('Soda', kellner.id), ka('Saft', kellner.id), ka('Wasser', plain.id)]
    const plan = planeLayout(
      zustand([plain, kellner], arts),
      mkLayout([
        grp('Atriumbar', '#e76815', [], [grp('Alkoholfrei', '#60aa30', [['Wasser', 1]])]),
        grp('Kellner Getränke', '#db3385', [], [grp('Alkoholfrei', '#60aa30', [['Soda', 1], ['Saft', 2]])]),
      ]),
      OPT,
    )
    const byName = new Map(plan.gruppenUpdates.map(u => [u.id, u]))
    expect(byName.has(plain.id) && byName.has(kellner.id)).toBe(true)
    expect(plan.neueGruppen.map(g => g.name).sort()).toEqual(['Atriumbar', 'Kellner Getränke'])
    // Hauptgruppen ohne eigene Artikel erben von den Unterartikeln: Kellner Getränke ← Kellner Alkoholfrei
    const kg2 = plan.neueGruppen.find(g => g.name === 'Kellner Getränke')!
    expect(kg2).toMatchObject({ station: 'schank', bonierdruckerId: drucker, terminalSichtbar: true })
    expect(byName.get(kellner.id)!.werte.parentId).toBe(kg2.id)
    expect(byName.get(plain.id)!.werte.parentId).toBe(plan.neueGruppen.find(g => g.name === 'Atriumbar')!.id)
  })

  it('Gruppe ohne gesetzte Farbe bekommt Grau-Standard; Reihenfolge = Position unter Geschwistern', () => {
    const plan = planeLayout(zustand([], []), mkLayout([
      grp('Zwei', '#111111', [], [], { reihenfolge: 7, farbeGesetzt: false }),
      grp('Eins', '#222222', [], [], { reihenfolge: 3 }),
    ]), OPT)
    expect(plan.neueGruppen.map(g => [g.name, g.reihenfolge, g.farbe])).toEqual([
      ['Eins', 0, '#222222'], ['Zwei', 1, STANDARD_GRUPPENFARBE],
    ])
  })

  it('Kassa-Gruppen ohne Gegenstück bleiben und werden gemeldet', () => {
    const alt = kg('Altlast'); const a = ka('Etwas', alt.id)
    const plan = planeLayout(zustand([alt], [a]), mkLayout([grp('Bar', '#111111', [])]), OPT)
    expect(plan.bericht.probleme.nichtZugeordneteKassaGruppen).toEqual([{ id: alt.id, name: 'Altlast', artikel: 1 }])
  })
})

describe('Favoriten', () => {
  it('setzt die Favoriten in fester Reihenfolge, entfernt alte, löscht Kassen-Listen', () => {
    const g = kg('Bar')
    const alt = ka('Alt', g.id, { istFavorit: true, favoritenReihenfolge: 1 })
    const bier = ka('Bier', g.id), wein = ka('Wein', g.id)
    const z = zustand([g], [alt, bier, wein]); z.kassenFavoritenAnzahl = 5
    const plan = planeLayout(z, mkLayout([grp('Bar', '#111111', [['Bier', 1], ['Wein', 2], ['Alt', 3]])], [
      { name: 'Wein', pfad: 'Bar' }, { name: 'Bier', pfad: 'Bar' }, { name: 'Nix', pfad: 'Bar' },
    ]), OPT)
    const fav = new Map(plan.artikelUpdates.map(u => [u.id, u.werte]))
    expect(fav.get(wein.id)).toMatchObject({ istFavorit: true, favoritenReihenfolge: 1 })
    expect(fav.get(bier.id)).toMatchObject({ istFavorit: true, favoritenReihenfolge: 2 })
    expect(fav.get(alt.id)).toMatchObject({ istFavorit: false })
    expect(plan.kassenFavoritenLoeschen).toBe(true)
    expect(plan.bericht.zaehler.favoriten).toEqual({ gesetzt: 2, nichtAufgeloest: 1, entfernt: 1, kassenFavoritenGeloescht: 5 })
    expect(plan.bericht.probleme.favoritenNichtAufgeloest[0]).toMatchObject({ name: 'Nix' })
  })

  it('ohne Favoriten im Layout bleiben die bisherigen unberührt', () => {
    const g = kg('Bar'); const f = ka('Bier', g.id, { istFavorit: true, favoritenReihenfolge: 3 })
    const z = zustand([g], [f]); z.kassenFavoritenAnzahl = 2
    const plan = planeLayout(z, mkLayout([grp('Bar', '#111111', [['Bier', 1]])]), OPT)
    expect(plan.artikelUpdates.every(u => u.werte.istFavorit === undefined)).toBe(true)
    expect(plan.kassenFavoritenLoeschen).toBe(false)
  })

  it('neu angelegter Artikel kann Favorit sein', () => {
    const plan = planeLayout(zustand([], []), mkLayout([grp('Bar', '#111111', [['Neu', 1]])], [{ name: 'Neu', pfad: 'Bar' }]), OPT)
    expect(plan.neueArtikel[0]).toMatchObject({ istFavorit: true, favoritenReihenfolge: 1 })
  })
})

describe('Kassen: Spalten', () => {
  it('setzt artikelProZeile auf spalten, nur wo abweichend; abwählbar', () => {
    const z = zustand([], []); z.kassen = [{ id: testId(), artikelProZeile: 4 }, { id: testId(), artikelProZeile: 3 }]
    const l = mkLayout([grp('Bar', '#111111')])
    expect(planeLayout(z, l, OPT).kassenUpdates).toEqual([{ id: z.kassen[0]!.id, artikelProZeile: 3 }])
    expect(planeLayout(z, l, { ...OPT, spaltenSetzen: false }).kassenUpdates).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Das echte Asello-Layout gegen einen flachen Kassa-Vorbestand
// ---------------------------------------------------------------------------

describe('Asello-Layout (53 Gruppen, 494 Artikel, 27 Favoriten) gegen flachen Vorbestand', () => {
  const layout = ladeAselloLayout()
  const { zustand: start, gruppeVonPfad, artikelVonPfadUndName } = flacherKassaZustand(layout)
  const plan = planeLayout(start, layout, OPT)

  it('Fixture hat den erwarteten Umfang', () => {
    expect(plan.bericht.zaehler.gruppen.imLayout).toBe(53)
    expect(plan.bericht.zaehler.artikel.imLayout).toBe(494)
    expect(layout.favoriten).toHaveLength(27)
  })

  it('ordnet jeden Artikel genau einmal zu, nichts mehrdeutig, nichts neu', () => {
    expect(plan.bericht.probleme.mehrdeutig).toEqual([])
    expect(plan.bericht.probleme.nichtGefunden).toEqual([])
    expect(plan.bericht.zaehler.artikel).toMatchObject({ zugeordnet: 494, neu: 0, mehrdeutig: 0, nichtGefundenNichtAngelegt: 0 })
    expect(plan.bericht.probleme.doppelteSlots).toEqual([])
  })

  it('jede flache Gruppe wird wiederverwendet — Gruppen mit Artikeln nie neu', () => {
    // 53 Knoten; flache Gruppen gibt es nur für Knoten mit Artikeln
    expect(plan.bericht.zaehler.gruppen.gefunden).toBe(gruppeVonPfad.size)
    expect(plan.neueGruppen.length).toBe(53 - gruppeVonPfad.size)
    // nichts bleibt unzugeordnet
    expect(plan.bericht.probleme.nichtZugeordneteKassaGruppen).toEqual([])
  })

  it('Duplikat-Artikel („Brez´n" in Atriumbar/Speisen und Kellner Speisen) landen je in ihrer Gruppe', () => {
    const nach = wendePlanAn(start, plan)
    const art = (pfad: string, name: string) => nach.artikel.find(a => a.id === artikelVonPfadUndName.get(`${pfad}|${name}`)!.id)!
    const atrium = art('Atriumbar/Speisen', 'Brez´n'), kellner = art('Kellner Speisen', 'Brez´n')
    expect(atrium.id).not.toBe(kellner.id)
    expect(atrium.kategorieId).toBe(gruppeVonPfad.get('Atriumbar/Speisen')!.id)
    expect(kellner.kategorieId).toBe(gruppeVonPfad.get('Kellner Speisen')!.id)
  })

  it('Baum, Farben, Slots, Reihenfolge und Favoriten stimmen nach dem Anwenden', () => {
    const nach = wendePlanAn(start, plan)
    const kinderVon = (id: string | null) => nach.gruppen.filter(g => g.parentId === id)
    // 14 Hauptgruppen wie im Layout; bestehende Gruppen unter richtigen Eltern
    expect(kinderVon(null).filter(g => layout.gruppen.some(l => l.name === g.name)).length).toBe(layout.gruppen.length)
    const atrium = nach.gruppen.find(g => g.name === 'Atriumbar')!
    expect(atrium.farbe).toBe('#e76815')
    expect(kinderVon(atrium.id).map(g => g.name)).toEqual(
      layout.gruppen[0]!.untergruppen.map(u => u.name === 'Alkoholfrei' ? 'Alkoholfrei' : u.name))
    expect(nach.gruppen.find(g => g.name === 'Sponsoren')!.farbe).toBe('#637685')
    // Slot + Hex-Farbe eines Artikels
    const limo = nach.artikel.find(a => a.id === artikelVonPfadUndName.get('Atriumbar/Alkoholfrei|0,3l Limo')!.id)!
    expect(limo).toMatchObject({ rasterPosition: 1, reihenfolge: 1, farbe: '#463123' })
    // Station der flachen Kassa-Gruppe bleibt erhalten (Kellner Getränke → schank)
    for (const g of start.gruppen.filter(g => g.station === 'schank')) {
      expect(nach.gruppen.find(x => x.id === g.id)!.station).toBe('schank')
    }
    // die neue Hauptgruppe „Kellner Getränke" erbt die Station ihrer Untergruppen
    expect(nach.gruppen.find(g => g.name === 'Kellner Getränke')!.station).toBe('schank')
    // Favoriten: 27 in fester Reihenfolge
    const favs = nach.artikel.filter(a => a.istFavorit).sort((a, b) => a.favoritenReihenfolge - b.favoritenReihenfolge)
    expect(favs).toHaveLength(27)
    expect(favs.map(f => f.favoritenReihenfolge)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1))
    expect(favs[0]!.bezeichnung).toBe('0,3l Soda')
    expect(nach.kassen[0]!.artikelProZeile).toBe(3)
  })

  it('ist idempotent: zweiter Lauf ändert nichts mehr', () => {
    const nach = wendePlanAn(start, plan)
    const zweiter = planeLayout(nach, layout, OPT)
    expect(zweiter.neueGruppen).toEqual([])
    expect(zweiter.neueArtikel).toEqual([])
    expect(zweiter.gruppenUpdates).toEqual([])
    expect(zweiter.artikelUpdates).toEqual([])
    expect(zweiter.kassenUpdates).toEqual([])
    expect(zweiter.bericht.zaehler.gruppen).toMatchObject({ neu: 0, geaendert: 0, umgehaengt: 0, gefunden: 53 })
    expect(zweiter.bericht.zaehler.artikel).toMatchObject({ zugeordnet: 494, neu: 0, geaendert: 0, mehrdeutig: 0 })
    expect(zweiter.bericht.zaehler.favoriten).toMatchObject({ gesetzt: 27, entfernt: 0 })
  })

  it('fehlende Artikel: ohne Vorbestand werden alle 494 angelegt, danach ist der Lauf idempotent', () => {
    const leer = zustand([], [])
    const p1 = planeLayout(leer, layout, OPT)
    // inkl. der zwei Pfand-Rückgabe-Artikel mit negativem Preis (Retourglas, Becher retour)
    expect(p1.neueArtikel).toHaveLength(494)
    expect(p1.bericht.probleme.nichtGefunden).toEqual([])
    expect(p1.neueArtikel.filter(a => a.preisBruttoCent < 0).map(a => [a.bezeichnung, a.preisBruttoCent, a.mwstSatz]).sort()).toEqual([
      ['Becher retour', -200, 'null'], ['Retourglas', -50, 'ermaessigt1'],
    ])
    expect(p1.neueGruppen).toHaveLength(53)
    expect(p1.neueArtikel.filter(a => a.istFavorit)).toHaveLength(27)
    const p2 = planeLayout(wendePlanAn(leer, p1), layout, OPT)
    expect(p2.neueArtikel).toEqual([])
    expect(p2.neueGruppen).toEqual([])
    expect(p2.gruppenUpdates).toEqual([])
    expect(p2.artikelUpdates).toEqual([])
  })
})


// ---------------------------------------------------------------------------
// Station je Gruppe, Optionen je Artikel, Sauberer Neustart (katalogLoeschen)
// ---------------------------------------------------------------------------

import { optionsgruppenName } from '../src/services/layout-import.service.js'
import type { LoeschPlan } from '../src/services/katalog-loeschen.service.js'

const opt = (gruppe: string, optionen: [string, number][], pflicht = false, mehrfach = false) =>
  ({ gruppe, pflicht, mehrfach, optionen: optionen.map(([name, aufschlagCent]) => ({ name, aufschlagCent })) })
const artMitOpt = (name: string, slot: number, optionen: unknown[]) => ({ name, preisCent: 300, mwst: 0.2, slot, optionen })

describe('Station je Gruppe', () => {
  it('neue Gruppe: Layout-Station gewinnt gegen die Vererbung; ohne Angabe wird vererbt', () => {
    const alt = kg('Schankalt', { station: 'kueche' })
    const plan = planeLayout(zustand([alt], [ka('Bier', alt.id)]), mkLayout([
      grp('Bar', '#111111', [], [], { station: 'schank' }),
      grp('Schankalt2', '#222222', [['Bier', 1]]),
    ]), OPT)
    const bar = plan.neueGruppen.find(g => g.name === 'Bar')!
    expect(bar.station).toBe('schank')
    // Schankalt2 passt nicht zur Kassa-Gruppe Schankalt: neu, erbt (Artikel Bier liegt dort) kueche
    expect(plan.neueGruppen.find(g => g.name === 'Schankalt2')!.station).toBe('kueche')
    // Artikel erben dynamisch: keine station-Änderung an Artikeln
    expect(plan.artikelUpdates.every(u => !('station' in u.werte))).toBe(true)
  })

  it('bestehende Gruppe: Layout-Station nur setzen, wenn sie noch keine hat', () => {
    const ohne = kg('Wein'), mit = kg('Bier', { station: 'kueche' })
    const plan = planeLayout(zustand([ohne, mit], []), mkLayout([
      grp('Wein', '#111111', [], [], { station: 'schank' }), grp('Bier', '#222222', [], [], { station: 'schank' }),
    ]), OPT)
    const upd = new Map(plan.gruppenUpdates.map(u => [u.id, u.werte]))
    expect(upd.get(ohne.id)?.station).toBe('schank')
    expect(upd.get(mit.id)?.station).toBeUndefined()
  })
})

describe('Optionen je Artikel', () => {
  it('Mapping pflicht/mehrfach, Reihenfolge, negative Aufschläge, lesbarer Gruppenname', () => {
    const l = mkLayout([grp('Bar', '#111111', [], [], {})])
    l.gruppen[0]!.artikel = [artMitOpt('Spritzer', 1, [
      opt('Variante', [['gespritzt', 0], ['Ohne Soda', -200], ['mit Eis', 50]], true, false),
      opt('Optionen', [['Zitrone', 0]], false, true),
    ]) as never]
    const plan = planeLayout(zustand([], []), l, OPT)
    const id = plan.neueArtikel[0]!.id
    expect(plan.optionen).toEqual([
      { artikelId: id, name: 'Variante (gespritzt / Ohne Soda …)', typ: 'pflicht', maxAuswahl: 1,
        optionen: [{ name: 'gespritzt', aufschlagCent: 0 }, { name: 'Ohne Soda', aufschlagCent: -200 }, { name: 'mit Eis', aufschlagCent: 50 }] },
      { artikelId: id, name: 'Optionen (Zitrone)', typ: 'optional', maxAuswahl: null, optionen: [{ name: 'Zitrone', aufschlagCent: 0 }] },
    ])
    expect(plan.bericht.zaehler.optionen).toEqual({ gruppenNeu: 2, gruppenWiederverwendet: 0, zuordnungenNeu: 2, uebersprungen: 0 })
    expect(optionsgruppenName('Variante', [{ name: 'a' }])).toBe('Variante (a)')
  })

  it('inhaltsgleiche Gruppen nur einmal; bestehende wiederverwendet; zweiter Lauf = keine neuen Zuordnungen', () => {
    const l = mkLayout([grp('Bar', '#111111', [], [], {})])
    const gleich = () => opt('Variante', [['Still', 0], ['Prickelnd', 0]])
    l.gruppen[0]!.artikel = [artMitOpt('Soda', 1, [gleich()]) as never, artMitOpt('Wasser', 2, [gleich()]) as never]
    const p1 = planeLayout(zustand([], []), l, OPT)
    expect(p1.bericht.zaehler.optionen).toMatchObject({ gruppenNeu: 1, gruppenWiederverwendet: 0, zuordnungenNeu: 2 })
    const nach = wendePlanAn(zustand([], []), p1)
    const p2 = planeLayout(nach, l, OPT)
    expect(p2.bericht.zaehler.optionen).toMatchObject({ gruppenNeu: 0, gruppenWiederverwendet: 1, zuordnungenNeu: 0 })
  })

  it('mehrdeutige / nicht angelegte Artikel bekommen keine Optionen (werden gezählt)', () => {
    const g1 = kg('A'), g2 = kg('B')
    const l = mkLayout([grp('Bar', '#111111', [], [], {})])
    l.gruppen[0]!.artikel = [artMitOpt('Cola', 1, [opt('Variante', [['x', 0]])]) as never]
    const mehr = planeLayout(zustand([g1, g2], [ka('Cola', g1.id), ka('Cola', g2.id)]), l, OPT)
    expect(mehr.bericht.zaehler.optionen).toMatchObject({ gruppenNeu: 0, zuordnungenNeu: 0, uebersprungen: 1 })
    const nein = planeLayout(zustand([], []), l, { ...OPT, fehlendeAnlegen: false })
    expect(nein.bericht.zaehler.optionen.uebersprungen).toBe(1)
    expect(nein.optionen).toEqual([])
  })
})

describe('Sauberer Neustart (katalogLoeschen)', () => {
  const loesch = (extra: Partial<LoeschPlan> = {}): LoeschPlan => ({
    artikelLoeschen: 2, gruppenLoeschen: 1, optionsgruppen: 3, seriennummern: 4, inventurPositionen: 5, sichtbarkeiten: 6,
    artikelBehalten: [], gruppenBehalten: [], preisregeln: [], ...extra,
  })

  it('Altbestand wird NICHT wiederverwendet: alles neu, Löschplan und Zähler im Bericht', () => {
    const g = kg('Bar'); const cola = ka('Cola', g.id)
    const z = { ...zustand([g], [cola]), kassenFavoritenAnzahl: 2, loeschung: loesch() }
    const l = mkLayout([grp('Bar', '#111111', [['Cola', 1]])])
    const normal = planeLayout(z, l, OPT)
    expect(normal.neueGruppen).toHaveLength(0)
    const plan = planeLayout(z, l, { ...OPT, katalogLoeschen: true })
    expect(plan.neueGruppen.map(x => x.name)).toEqual(['Bar'])
    expect(plan.neueArtikel.map(x => x.bezeichnung)).toEqual(['Cola'])
    expect(plan.artikelUpdates).toEqual([])
    expect(plan.loeschung).toEqual(z.loeschung)
    expect(plan.kassenFavoritenLoeschen).toBe(true)
    expect(plan.bericht.katalogLoeschen).toMatchObject({ aktiv: true, geloescht: { artikel: 2, gruppen: 1, optionsgruppen: 3, seriennummern: 4, inventurPositionen: 5, sichtbarkeiten: 6, kassenFavoriten: 2 } })
    expect(plan.bericht.zusammenfassung[0]).toMatch(/Sauberer Neustart.*gelöscht.*auch bei Wiederholung/)
    expect(planeLayout(z, l, { ...OPT, katalogLoeschen: true, dryRun: true }).bericht.zusammenfassung[0]).toMatch(/würde löschen/)
    // ohne Haken: keine Löschung, Bericht inaktiv
    expect(normal.loeschung).toBeNull()
    expect(normal.bericht.katalogLoeschen.aktiv).toBe(false)
  })

  it('Fallback: nur deaktivierte Artikel/Gruppen stehen mit Grund im Bericht', () => {
    const z = { ...zustand([], []), loeschung: loesch({
      artikelBehalten: [{ id: testId(), bezeichnung: 'Offener Tisch-Artikel', grund: 'offener Tisch' }],
      gruppenBehalten: [{ id: testId(), name: 'Alt', grund: 'enthält Artikel mit laufenden Vorgängen' }],
    }) }
    const plan = planeLayout(z, mkLayout([grp('Bar', '#111111')]), { ...OPT, katalogLoeschen: true })
    expect(plan.bericht.katalogLoeschen.nurDeaktiviert.artikel).toEqual([{ name: 'Offener Tisch-Artikel', grund: 'offener Tisch' }])
    expect(plan.bericht.zusammenfassung.join(' ')).toMatch(/Nur deaktiviert statt gelöscht/)
  })

  it('zweiter Lauf OHNE katalogLoeschen ändert nichts mehr (auch Optionen)', () => {
    const l = mkLayout([grp('Bar', '#111111', [['Cola', 1]])])
    l.gruppen[0]!.artikel[0]!.optionen = [opt('Variante', [['a', 0]])] as never
    const z0 = { ...zustand([], []), loeschung: loesch() }
    const p1 = planeLayout(z0, l, { ...OPT, katalogLoeschen: true })
    const nach = wendePlanAn(z0, p1)
    const p2 = planeLayout(nach, l, OPT)
    for (const k of ['neueGruppen', 'neueArtikel', 'gruppenUpdates', 'artikelUpdates', 'kassenUpdates'] as const) expect(p2[k]).toEqual([])
    expect(p2.bericht.zaehler.optionen).toMatchObject({ gruppenNeu: 0, zuordnungenNeu: 0 })
  })
})
