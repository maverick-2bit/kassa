import { describe, expect, it } from 'vitest'
import { auswahlGueltig, baueAuswahlPositionen, gruppenSumme, type OptionenMengen } from './optionen-auswahl.js'
import type { ModifikatorGruppe } from './schemas/modifikator.js'

const mod = (id: string, name: string, aufschlagCent = 0) =>
  ({ id, gruppeId: 'x', name, aufschlagCent, reihenfolge: 0, aktiv: true, lagerstandMenge: null, createdAt: '' })

const gruppe = (id: string, name: string, extra: Partial<ModifikatorGruppe>, optionen: ReturnType<typeof mod>[]): ModifikatorGruppe => ({
  id, mandantId: 'm', name, typ: 'optional', maxAuswahl: null, jeAuswahlArtikel: false, reihenfolge: 0, aktiv: true,
  modifikatoren: optionen, createdAt: '', updatedAt: '', ...extra,
})

const VARIANTE = gruppe('g-var', 'Variante', { typ: 'pflicht', jeAuswahlArtikel: true },
  [mod('suess', 'süß'), mod('sommer', 'Sommer'), mod('weiss', 'weiß'), mod('eis', 'mit Eis', 50)])
const SENF = gruppe('g-senf', 'Zusatz', {}, [mod('senf', 'mit Senf'), mod('kren', 'mit Kren')])

const mengen = (e: Record<string, Record<string, number>>): OptionenMengen =>
  new Map(Object.entries(e).map(([g, m]) => [g, new Map(Object.entries(m))] as const))

describe('baueAuswahlPositionen — normale Gruppen: eine Position mit allen Optionen', () => {
  it('Senf und Kren sind EINE Position', () => {
    const p = baueAuswahlPositionen([SENF], mengen({ 'g-senf': { senf: 1, kren: 1 } }))
    expect(p).toHaveLength(1)
    expect(p[0]!.menge).toBe(1)
    expect(p[0]!.modifikatoren.map(m => m.name)).toEqual(['mit Senf', 'mit Kren'])
  })

  it('mehrfach gewählte Option bekommt ihre Anzahl, einfache nicht', () => {
    const p = baueAuswahlPositionen([SENF], mengen({ 'g-senf': { senf: 2, kren: 1 } }))
    expect(p[0]!.modifikatoren.find(m => m.name === 'mit Senf')?.menge).toBe(2)
    expect(p[0]!.modifikatoren.find(m => m.name === 'mit Kren')).not.toHaveProperty('menge')
  })

  it('ohne Auswahl: eine Position ohne Optionen', () => {
    expect(baueAuswahlPositionen([SENF], mengen({}))).toEqual([{ modifikatoren: [], menge: 1 }])
  })
})

describe('baueAuswahlPositionen — „Jede Auswahl = eigener Artikel" (Spritzer süß, Sommer, weiß)', () => {
  it('drei gewählte Varianten = drei Positionen', () => {
    const p = baueAuswahlPositionen([VARIANTE], mengen({ 'g-var': { suess: 1, sommer: 1, weiss: 1 } }))
    expect(p).toHaveLength(3)
    expect(p.map(x => x.modifikatoren.map(m => m.name))).toEqual([['süß'], ['Sommer'], ['weiß']])
    expect(p.every(x => x.menge === 1)).toBe(true)
  })

  it('mehrfach angeklickte Variante = Menge der Position (2× weiß)', () => {
    const p = baueAuswahlPositionen([VARIANTE], mengen({ 'g-var': { suess: 1, weiss: 2 } }))
    expect(p.map(x => [x.modifikatoren[0]!.name, x.menge])).toEqual([['süß', 1], ['weiß', 2]])
    // die Anzahl steckt in der Position, nicht doppelt an der Option
    expect(p[1]!.modifikatoren[0]).not.toHaveProperty('menge')
  })

  it('Optionen anderer Gruppen hängen an jeder Position', () => {
    const p = baueAuswahlPositionen([VARIANTE, SENF], mengen({ 'g-var': { suess: 1, weiss: 1 }, 'g-senf': { senf: 1 } }))
    expect(p.map(x => x.modifikatoren.map(m => m.name))).toEqual([['süß', 'mit Senf'], ['weiß', 'mit Senf']])
  })

  it('Aufpreis bleibt an der Option der jeweiligen Position', () => {
    const p = baueAuswahlPositionen([VARIANTE], mengen({ 'g-var': { suess: 1, eis: 1 } }))
    expect(p.map(x => x.modifikatoren[0]!.aufschlagCent)).toEqual([0, 50])
  })

  it('Gruppe ohne Auswahl teilt nicht auf: die Optionen der anderen bleiben EINE Position', () => {
    const p = baueAuswahlPositionen([VARIANTE, SENF], mengen({ 'g-senf': { senf: 1, kren: 1 } }))
    expect(p).toHaveLength(1)
    expect(p[0]!.modifikatoren.map(m => m.name)).toEqual(['mit Senf', 'mit Kren'])
  })

  it('zwei aufteilende Gruppen: nur die erste teilt auf, die zweite bleibt normal', () => {
    const zweite = gruppe('g-zwei', 'Größe', { jeAuswahlArtikel: true }, [mod('klein', 'klein'), mod('gross', 'groß')])
    const p = baueAuswahlPositionen([VARIANTE, zweite], mengen({ 'g-var': { suess: 1, weiss: 1 }, 'g-zwei': { klein: 1 } }))
    expect(p.map(x => x.modifikatoren.map(m => m.name))).toEqual([['süß', 'klein'], ['weiß', 'klein']])
  })
})

describe('auswahlGueltig / gruppenSumme', () => {
  it('Pflichtgruppe braucht mindestens eine Option, optionale nicht', () => {
    expect(auswahlGueltig([VARIANTE, SENF], mengen({}))).toBe(false)
    expect(auswahlGueltig([VARIANTE, SENF], mengen({ 'g-var': { suess: 1 } }))).toBe(true)
    expect(auswahlGueltig([SENF], mengen({}))).toBe(true)
  })

  it('Summe zählt die Anzahlen', () => {
    expect(gruppenSumme(mengen({ 'g-var': { suess: 1, weiss: 2 } }), 'g-var')).toBe(3)
    expect(gruppenSumme(mengen({}), 'g-var')).toBe(0)
  })
})
