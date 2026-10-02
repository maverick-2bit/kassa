import { describe, it, expect } from 'vitest'
import type { Kategorie } from '@kassa/shared'
import {
  baumFlach, erweitereSichtbarkeit, nachkommenIds, pfadIds, untergruppenVon, wurzelgruppen, wurzelIdVon,
} from './kategorie-baum'

const kat = (id: string, parentId: string | null, reihenfolge = 0, name = id): Kategorie => ({
  id, parentId, reihenfolge, name,
  mandantId: 'm', farbe: 'grau', aktiv: true, bonierdruckerId: null, station: null,
  terminalSichtbar: false, createdAt: '', updatedAt: '',
})

const baum = [
  kat('bar', null, 1), kat('speisen', null, 0),
  kat('bar-alk', 'bar', 1), kat('bar-na', 'bar', 0), kat('bar-alk-bier', 'bar-alk', 0),
]

describe('kategorie-baum', () => {
  it('Hauptgruppen und Untergruppen nach reihenfolge', () => {
    expect(wurzelgruppen(baum).map(k => k.id)).toEqual(['speisen', 'bar'])
    expect(untergruppenVon(baum, 'bar').map(k => k.id)).toEqual(['bar-na', 'bar-alk'])
  })
  it('Gruppe mit fehlendem Elternteil zählt als Hauptgruppe', () => {
    expect(wurzelgruppen([kat('x', 'weg'), kat('y', null)]).map(k => k.id).sort()).toEqual(['x', 'y'])
  })
  it('Nachkommen, Pfad und Wurzel', () => {
    expect(nachkommenIds(baum, 'bar').sort()).toEqual(['bar-alk', 'bar-alk-bier', 'bar-na'])
    expect(pfadIds(baum, 'bar-alk-bier')).toEqual(['bar', 'bar-alk', 'bar-alk-bier'])
    expect(wurzelIdVon(baum, 'bar-alk-bier')).toBe('bar')
    expect(wurzelIdVon(baum, 'unbekannt')).toBeNull()
  })
  it('Sichtbarkeit: leer = alle, sonst Nachkommen + Vorfahren', () => {
    expect(erweitereSichtbarkeit(baum, [])).toEqual([])
    expect(erweitereSichtbarkeit(baum, undefined)).toBeUndefined()
    expect(erweitereSichtbarkeit(baum, ['bar-alk'])!.sort()).toEqual(['bar', 'bar-alk', 'bar-alk-bier'])
  })
  it('baumFlach: Tiefensuche mit Tiefe', () => {
    expect(baumFlach(baum).map(e => `${e.tiefe}:${e.kategorie.id}`)).toEqual([
      '0:speisen', '0:bar', '1:bar-na', '1:bar-alk', '2:bar-alk-bier',
    ])
  })
  it('Zyklus im Altbestand führt nicht in eine Endlosschleife', () => {
    const zyklus = [kat('a', 'b'), kat('b', 'a')]
    expect(nachkommenIds(zyklus, 'a')).toEqual(['b'])
    expect(pfadIds(zyklus, 'a').length).toBeLessThanOrEqual(2)
    expect(baumFlach(zyklus)).toEqual([])
  })
})
