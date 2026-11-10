import { describe, it, expect } from 'vitest'
import type { Artikel, ModifikatorGruppe, SprachVorschlag } from '@kassa/shared'
import { baueKorbPositionen } from './korb'
import { waehleArtikel, type SprachEintrag } from './eintraege'

const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const artikel = (n: number, o: Partial<Artikel> = {}): Artikel => ({
  id: G(n), bezeichnung: `Artikel ${n}`, preisBruttoCent: 500, lagerstandMenge: null, ...o,
} as Artikel)

const mod = (n: number, o: Record<string, unknown> = {}) => ({
  id: G(n), gruppeId: G(900), name: `Mod ${n}`, aufschlagCent: 0, reihenfolge: 0, aktiv: true, lagerstandMenge: null, createdAt: '', ...o,
})

const gruppe = (n: number, mods: ReturnType<typeof mod>[], o: Partial<ModifikatorGruppe> = {}): ModifikatorGruppe => ({
  id: G(n), mandantId: G(999), name: `Gruppe ${n}`, typ: 'optional', maxAuswahl: null, jeAuswahlArtikel: false,
  reihenfolge: 0, aktiv: true, modifikatoren: mods.map(m => ({ ...m, gruppeId: G(n) })), createdAt: '', updatedAt: '', ...o,
} as ModifikatorGruppe)

/** mods: [Modifikator-Nr, Gruppen-Nr, Name] */
const eintrag = (
  artikelNr: number | null,
  o: { menge?: number; mods?: [number, number, string][]; hinweise?: string[]; text?: string } = {},
): SprachEintrag => ({
  id: 1,
  artikelId: artikelNr === null ? null : G(artikelNr),
  menge: o.menge ?? 1,
  vorschlag: {
    menge: o.menge ?? 1, text: o.text ?? 'x', artikel: artikelNr === null ? null : { id: G(artikelNr), bezeichnung: `Artikel ${artikelNr}` },
    konfidenz: 1, status: 'sicher', alternativen: [],
    modifikatoren: (o.mods ?? []).map(([id, gruppeId, name]) => ({ id: G(id), gruppeId: G(gruppeId), name })),
    hinweise: o.hinweise ?? [],
  } satisfies SprachVorschlag,
})

describe('Sprach-Korb', () => {
  it('Artikel ohne Optionen → eine Position, Menge übernommen', () => {
    const r = baueKorbPositionen([eintrag(1, { menge: 3 })], [artikel(1)], new Map())
    expect(r.offen).toEqual([])
    expect(r.positionen).toHaveLength(1)
    expect(r.positionen[0]).toMatchObject({ menge: 3, modifikatoren: [] })
    expect(r.positionen[0]!.artikel.id).toBe(G(1))
  })

  it('Optionen: Aufschlag kommt auf den Preis, Auswahl trägt Gruppen- und Optionsname (wie beim Antippen)', () => {
    const g = gruppe(50, [mod(60, { name: 'Extra Käse', aufschlagCent: 120 })])
    const r = baueKorbPositionen([eintrag(1, { mods: [[60, 50, 'Extra Käse']] })], [artikel(1)], new Map([[G(1), [g]]]))
    expect(r.positionen[0]!.artikel.preisBruttoCent).toBe(620)
    expect(r.positionen[0]!.modifikatoren).toEqual([
      { modifikatorId: G(60), gruppeId: G(50), gruppeName: 'Gruppe 50', name: 'Extra Käse', aufschlagCent: 120 },
    ])
  })

  it('„jede Auswahl = eigener Artikel": teilt in Positionen wie in der Artikelseite', () => {
    const g = gruppe(50, [mod(60, { name: 'süß' })], { jeAuswahlArtikel: true })
    const r = baueKorbPositionen([eintrag(1, { menge: 2, mods: [[60, 50, 'süß']] })], [artikel(1)], new Map([[G(1), [g]]]))
    expect(r.positionen).toHaveLength(1)
    expect(r.positionen[0]!.menge).toBe(2) // 2 × (1 Auswahl)
    expect(r.positionen[0]!.modifikatoren.map(m => m.name)).toEqual(['süß'])
  })

  it('fehlende Pflicht-Option → offen, nichts geraten', () => {
    const g = gruppe(50, [mod(60), mod(61)], { typ: 'pflicht', name: 'Größe' })
    const r = baueKorbPositionen([eintrag(1)], [artikel(1)], new Map([[G(1), [g]]]))
    expect(r.positionen).toEqual([])
    expect(r.offen[0]).toMatchObject({ grund: 'Pflicht-Option fehlt: Größe' })
    expect(r.offen[0]!.artikel?.id).toBe(G(1)) // „Optionen wählen" ist möglich
  })

  it('erfüllte Pflicht-Option → in den Korb', () => {
    const g = gruppe(50, [mod(60), mod(61)], { typ: 'pflicht' })
    const r = baueKorbPositionen([eintrag(1, { mods: [[61, 50, 'Mod 61']] })], [artikel(1)], new Map([[G(1), [g]]]))
    expect(r.offen).toEqual([])
    expect(r.positionen[0]!.modifikatoren.map(m => m.modifikatorId)).toEqual([G(61)])
  })

  it('nicht zuordenbarer Hinweis („ohne senf") → offen statt stillschweigend verloren', () => {
    const r = baueKorbPositionen([eintrag(1, { hinweise: ['ohne senf'] })], [artikel(1)], new Map())
    expect(r.positionen).toEqual([])
    expect(r.offen[0]!.grund).toBe('Nicht übernehmbar: ohne senf')
  })

  it('Option inzwischen deaktiviert oder Gruppe weg → offen', () => {
    const g = gruppe(50, [mod(60, { aktiv: false })])
    expect(baueKorbPositionen([eintrag(1, { mods: [[60, 50, 'Mod 60']] })], [artikel(1)], new Map([[G(1), [g]]])).offen[0]!.grund)
      .toBe('Option „Mod 60" nicht mehr verfügbar')
    expect(baueKorbPositionen([eintrag(1, { mods: [[60, 50, 'Mod 60']] })], [artikel(1)], new Map()).offen).toHaveLength(1)
  })

  it('zu viele Optionen in einer Gruppe (maxAuswahl) → offen', () => {
    const g = gruppe(50, [mod(60), mod(61)], { maxAuswahl: 1 })
    const r = baueKorbPositionen([eintrag(1, { mods: [[60, 50, 'a'], [61, 50, 'b']] })], [artikel(1)], new Map([[G(1), [g]]]))
    expect(r.offen[0]!.grund).toBe('Zu viele Optionen bei „Gruppe 50"')
  })

  it('ausverkauft, nicht erkannt, Artikel verschwunden → offen mit Grund', () => {
    const r = baueKorbPositionen(
      [eintrag(1), eintrag(null, { text: 'sushi' }), eintrag(3)],
      [artikel(1, { lagerstandMenge: 0 })],
      new Map(),
    )
    expect(r.positionen).toEqual([])
    expect(r.offen.map(o => o.grund)).toEqual(['Ausverkauft', 'Nicht verstanden: „sushi"', 'Artikel an dieser Kasse nicht verfügbar'])
    expect(r.offen.map(o => o.artikel?.id ?? null)).toEqual([G(1), null, null])
  })

  it('gemischt: Fertiges kommt in den Korb, Offenes bleibt zurück', () => {
    const r = baueKorbPositionen([eintrag(1), eintrag(2, { hinweise: ['ohne eis'] })], [artikel(1), artikel(2)], new Map())
    expect(r.positionen.map(p => p.artikel.id)).toEqual([G(1)])
    expect(r.offen.map(o => o.artikel?.id)).toEqual([G(2)])
  })

  it('gewählte Alternative: Optionen des ersten Treffers werden nicht auf den anderen Artikel übertragen', () => {
    const g = gruppe(50, [mod(60, { aufschlagCent: 100 })])
    const e = waehleArtikel(eintrag(1, { mods: [[60, 50, 'Mod 60']] }), G(2))
    const r = baueKorbPositionen([e], [artikel(1), artikel(2)], new Map([[G(1), [g]]]))
    expect(r.positionen[0]).toMatchObject({ modifikatoren: [] })
    expect(r.positionen[0]!.artikel).toMatchObject({ id: G(2), preisBruttoCent: 500 })
  })
})
