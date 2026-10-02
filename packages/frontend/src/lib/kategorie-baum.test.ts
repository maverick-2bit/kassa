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

// ---------------------------------------------------------------------------
// Pfade, Anzeige-Namen, Auflösung — drei gleichnamige „Alkoholfrei"
// ---------------------------------------------------------------------------

import { geschwisterVon, kategorieAnzeigeName, kategorieAnzeigeNamen, kategoriePfad, kategorieSchluessel, loeseKategorieAuf, normalisiereKategoriePfad } from './kategorie-baum'
import { asselloBaum, BAUM_REIHENFOLGE, kat as katA } from './testdaten-kategorien'

describe('kategoriePfad', () => {
  const menge = asselloBaum()
  it('voller Pfad von der Hauptgruppe; Hauptgruppe = nur ihr Name; unbekannte ID = leer', () => {
    expect(kategoriePfad(menge, 'atr-alko')).toBe('Atriumbar › Alkoholfrei')
    expect(kategoriePfad(menge, 'ev-alko')).toBe('Eventmanagement › Event Getränke & Pakete › Alkoholfrei')
    expect(kategoriePfad(menge, 'atr-limo')).toBe('Atriumbar › Alkoholfrei › Limonaden')
    expect(kategoriePfad(menge, 'grillen')).toBe('Grillen')
    expect(kategoriePfad(menge, 'gibt-es-nicht')).toBe('')
    expect(kategoriePfad(menge, 'kel-alko', '/')).toBe('Kellner Getränke/Alkoholfrei')
  })
  it('fehlende Elterngruppe und Zyklus lassen die Kette enden statt abzustürzen', () => {
    expect(kategoriePfad([katA('x', 'Waise', 'weg', 0)], 'x')).toBe('Waise')
    const zyklus = [katA('a', 'A', 'b', 0), katA('b', 'B', 'a', 0)]
    expect(kategoriePfad(zyklus, 'a').length).toBeGreaterThan(0)
  })
})

describe('kategorieAnzeigeName', () => {
  const menge = asselloBaum()
  it('eindeutiger Name bleibt Name, gleichnamige Gruppen zeigen den Pfad', () => {
    expect(kategorieAnzeigeName(menge, 'atr-saft')).toBe('Säfte')
    expect(kategorieAnzeigeName(menge, 'grillen')).toBe('Grillen')
    expect(kategorieAnzeigeName(menge, 'atr-alko')).toBe('Atriumbar › Alkoholfrei')
    expect(kategorieAnzeigeName(menge, 'kel-alko')).toBe('Kellner Getränke › Alkoholfrei')
    expect(kategorieAnzeigeName(menge, 'ev-alko')).toBe('Eventmanagement › Event Getränke & Pakete › Alkoholfrei')
    // zwei „Bier"
    expect(kategorieAnzeigeName(menge, 'atr-bier')).toBe('Atriumbar › Bier')
    expect(kategorieAnzeigeName(menge, 'kel-bier')).toBe('Kellner Getränke › Bier')
  })
  it('Vergleich ohne Groß-/Kleinschreibung und Mehrfach-Leerzeichen', () => {
    const m = [katA('a', 'Bier', null, 0), katA('b', 'bier ', 'a', 0), katA('c', 'Wein', null, 1)]
    expect(kategorieAnzeigeName(m, 'b')).toBe('Bier › bier ')
    expect(kategorieAnzeigeName(m, 'c')).toBe('Wein')
  })
  it('Eindeutigkeit gilt in der übergebenen Menge (z. B. nur aktive Gruppen)', () => {
    const mitInaktiver = [...menge, katA('alt', 'Wein', null, 9, false)]
    expect(kategorieAnzeigeName(mitInaktiver, 'atr-wein')).toBe('Atriumbar › Wein')
    expect(kategorieAnzeigeName(mitInaktiver.filter(k => k.aktiv), 'atr-wein')).toBe('Wein')
  })
  it('Funktions-Variante: leere/null/unbekannte IDs ergeben leer', () => {
    const name = kategorieAnzeigeNamen(menge)
    expect(name(null)).toBe('')
    expect(name(undefined)).toBe('')
    expect(name('gibt-es-nicht')).toBe('')
    expect(name('atr-alko')).toBe('Atriumbar › Alkoholfrei')
  })
})

describe('Warengruppe aus Excel/Import auflösen (Name ODER Pfad)', () => {
  const menge = asselloBaum()
  it('reiner Name: eindeutig → gefunden, mehrdeutig → NIE eine still gewählt', () => {
    expect(loeseKategorieAuf(menge, 'Säfte')).toMatchObject({ art: 'gefunden', kategorie: { id: 'atr-saft' } })
    const r = loeseKategorieAuf(menge, 'alkoholfrei')
    expect(r.art).toBe('mehrdeutig')
    if (r.art === 'mehrdeutig') expect(r.kandidaten.map(k => k.id).sort()).toEqual(['atr-alko', 'ev-alko', 'kel-alko'])
    expect(loeseKategorieAuf(menge, 'Bier').art).toBe('mehrdeutig')
  })
  it('Pfad löst auf — mit „/", „›" und beliebigen Leerzeichen', () => {
    for (const eingabe of ['Atriumbar/Alkoholfrei', 'atriumbar › alkoholfrei', ' Atriumbar / Alkoholfrei ']) {
      expect(loeseKategorieAuf(menge, eingabe)).toMatchObject({ art: 'gefunden', kategorie: { id: 'atr-alko' } })
    }
    expect(loeseKategorieAuf(menge, 'Eventmanagement/Event Getränke & Pakete/Alkoholfrei'))
      .toMatchObject({ art: 'gefunden', kategorie: { id: 'ev-alko' } })
  })
  it('unbekannt; leere Eingabe; aktive Gruppen gehen vor inaktiven', () => {
    expect(loeseKategorieAuf(menge, 'Gibt es nicht').art).toBe('unbekannt')
    expect(loeseKategorieAuf(menge, '  ').art).toBe('unbekannt')
    const m = [katA('a', 'Wein', null, 0, false), katA('b', 'Wein', null, 1, true)]
    expect(loeseKategorieAuf(m, 'wein')).toMatchObject({ art: 'gefunden', kategorie: { id: 'b' } })
    // nur inaktive Treffer → trotzdem gefunden (wie bisher bei bestehenden Artikeln in inaktiver Gruppe)
    expect(loeseKategorieAuf([katA('a', 'Alt', null, 0, false)], 'alt')).toMatchObject({ art: 'gefunden' })
  })
  it('kategorieSchluessel schreibt genau so, dass die Auflösung wieder dieselbe Gruppe trifft', () => {
    for (const k of menge) {
      const s = kategorieSchluessel(menge, k.id)
      expect(loeseKategorieAuf(menge, s)).toMatchObject({ art: 'gefunden', kategorie: { id: k.id } })
    }
    expect(kategorieSchluessel(menge, 'atr-saft')).toBe('Säfte')
    expect(kategorieSchluessel(menge, 'kel-alko')).toBe('Kellner Getränke/Alkoholfrei')
  })
  it('normalisiereKategoriePfad', () => {
    expect(normalisiereKategoriePfad('A › B / C > D')).toBe('a/b/c/d')
    expect(normalisiereKategoriePfad('  Wein  Keller ')).toBe('wein keller')
  })
})

describe('geschwisterVon / Baumreihenfolge mit gleichnamigen Gruppen', () => {
  const menge = asselloBaum()
  it('Geschwister inklusive der Gruppe selbst, in Reihenfolge', () => {
    expect(geschwisterVon(menge, 'atr-bier').map(k => k.id)).toEqual(['atr-alko', 'atr-bier', 'atr-wein'])
    expect(geschwisterVon(menge, 'grillen').map(k => k.id)).toEqual(['atr', 'kel', 'ev', 'grillen'])
    expect(geschwisterVon(menge, 'gibt-es-nicht')).toEqual([])
  })
  it('baumFlach ordnet gleichnamige Gruppen unter ihre Elterngruppe', () => {
    expect(baumFlach(menge).map(e => e.kategorie.id)).toEqual(BAUM_REIHENFOLGE)
    const tiefen = new Map(baumFlach(menge).map(e => [e.kategorie.id, e.tiefe] as const))
    expect(tiefen.get('atr')).toBe(0)
    expect(tiefen.get('atr-alko')).toBe(1)
    expect(tiefen.get('atr-limo')).toBe(2)
    expect(tiefen.get('ev-alko')).toBe(2)
  })
})
