/**
 * Gleichnamige Warengruppen („Alkoholfrei" ×3) in Artikel-Import, Duplikat-Erkennung und Artikelliste:
 * Zuordnung nie still über den Namen allein, Gruppen in Baumreihenfolge, Anzeige mit Pfad.
 */

import { describe, it, expect } from 'vitest'
import type { Artikel } from '@kassa/shared'
import { findeDuplikate } from './artikel-import-duplikate'
import { sortiereArtikel, STANDARD_SORTIERUNG, naechsteSortierung } from './artikel-liste'
import { asselloBaum } from './testdaten-kategorien'

let n = 0
const art = (bezeichnung: string, kategorieId: string | null, extra: Partial<Artikel> = {}): Artikel => {
  n++
  return {
    id: `a${n}`, mandantId: 'm', bezeichnung, preisBruttoCent: 300, mwstSatz: 'normal', artikelnummer: null, station: null,
    farbe: null, kategorieId, rasterPosition: null, aktiv: true, lagerstandAktiv: false, lagerstandMenge: null,
    mindestbestand: null, seriennummernAktiv: false, istFavorit: false, reihenfolge: 0, favoritenReihenfolge: 0,
    bonierdruckerId: null, bonierBeiDirektverkauf: false, istBestandteil: false, bestandteile: [], lieferantId: null,
    terminalSichtbar: null, createdAt: '', updatedAt: '', ...extra,
  }
}
const kategorien = asselloBaum()

describe('Duplikat-Erkennung beim Artikel-Import: gleicher Name ≠ gleiche Gruppe', () => {
  const sodaAtr = art('Soda', 'atr-alko')
  const sodaKel = art('Soda', 'kel-alko')

  it('derselbe Artikelname in einer ANDEREN gleichnamigen Gruppe ist kein Duplikat', () => {
    const d = findeDuplikate([
      { zeile: 2, bezeichnung: 'Soda', kategorie: 'Kellner Getränke/Alkoholfrei' },
      { zeile: 3, bezeichnung: 'Soda', kategorie: 'Eventmanagement/Event Getränke & Pakete/Alkoholfrei' },
    ], [sodaAtr, sodaKel], kategorien)
    expect(d.get(2)?.vorhanden?.id).toBe(sodaKel.id)       // genau der Artikel dieser Gruppe
    expect(d.has(3)).toBe(false)                           // Event-„Alkoholfrei" hat noch keinen Soda
  })

  it('Pfad mit „›" und beliebiger Schreibweise trifft dieselbe Gruppe', () => {
    const d = findeDuplikate([{ zeile: 2, bezeichnung: 'soda', kategorie: ' atriumbar › ALKOHOLFREI ' }], [sodaAtr, sodaKel], kategorien)
    expect(d.get(2)?.vorhanden?.id).toBe(sodaAtr.id)
  })

  it('ein mehrdeutiger reiner Name wird NIE still einer der Gruppen zugeordnet', () => {
    const d = findeDuplikate([{ zeile: 2, bezeichnung: 'Soda', kategorie: 'Alkoholfrei' }], [sodaAtr, sodaKel], kategorien)
    expect(d.has(2)).toBe(false)
    // doppelte Zeilen mit demselben mehrdeutigen Text werden dennoch als Datei-Duplikat erkannt
    const doppelt = findeDuplikate([
      { zeile: 2, bezeichnung: 'Soda', kategorie: 'Alkoholfrei' },
      { zeile: 3, bezeichnung: 'Soda', kategorie: 'Alkoholfrei' },
    ], [], kategorien)
    expect(doppelt.get(3)).toEqual({ dateiZeile: 2 })
  })

  it('gleiche Zeilen in verschiedenen gleichnamigen Gruppen sind keine Datei-Duplikate', () => {
    const d = findeDuplikate([
      { zeile: 2, bezeichnung: 'Soda', kategorie: 'Atriumbar/Alkoholfrei' },
      { zeile: 3, bezeichnung: 'Soda', kategorie: 'Kellner Getränke/Alkoholfrei' },
    ], [], kategorien)
    expect(d.size).toBe(0)
  })
})

describe('Artikelliste: Warengruppen in Baumreihenfolge', () => {
  const a1 = art('Zeta', 'ev-alko'), a2 = art('Alpha', 'kel-alko'), a3 = art('Mitte', 'atr-alko'), a4 = art('Ohne', null)
  const a5 = art('Limo', 'atr-limo'), a6 = art('Grill', 'grillen')
  const alle = [a1, a2, a3, a4, a5, a6]

  it('Standard = Kassen-Reihenfolge: Baumreihenfolge der Gruppen (nicht die Zahl unter Geschwistern), ohne Gruppe hinten', () => {
    // alle drei „Alkoholfrei" tragen reihenfolge 0 — nur die Baumposition trennt sie
    expect(sortiereArtikel(alle, kategorien, STANDARD_SORTIERUNG).map(a => a.bezeichnung))
      .toEqual(['Mitte', 'Limo', 'Alpha', 'Zeta', 'Grill', 'Ohne'])
  })

  it('Sortierung nach Warengruppe nutzt den Anzeige-Namen (bei Namensgleichheit der Pfad)', () => {
    const sort = naechsteSortierung(STANDARD_SORTIERUNG, 'kategorie')
    const namen = sortiereArtikel(alle, kategorien, sort).map(a => a.bezeichnung)
    // „Atriumbar › Alkoholfrei" < „Eventmanagement › … › Alkoholfrei" < „Grillen" < „Kellner Getränke › Alkoholfrei" < „Limonaden"
    expect(namen).toEqual(['Mitte', 'Zeta', 'Grill', 'Alpha', 'Limo', 'Ohne'])
  })
})
