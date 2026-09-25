import { describe, it, expect } from 'vitest'
import type { Artikel, Kategorie } from '@kassa/shared'
import { filtereArtikel, naechsteSortierung, sortiereArtikel, STANDARD_SORTIERUNG } from './artikel-liste'
import { aktualisierungAusImport, findeDuplikate } from './artikel-import-duplikate'

const KAT_GETRAENKE = '00000000-0000-4000-8000-000000000001'
const KAT_SPEISEN   = '00000000-0000-4000-8000-000000000002'

function kat(id: string, name: string, reihenfolge: number): Kategorie {
  return {
    id, mandantId: 'm', name, farbe: 'grau', reihenfolge, aktiv: true, bonierdruckerId: null,
    station: null, terminalSichtbar: false, createdAt: '', updatedAt: '',
  }
}

let n = 0
function art(teil: Partial<Artikel>): Artikel {
  n++
  return {
    id: `a${n}`, mandantId: 'm', bezeichnung: `Artikel ${n}`, preisBruttoCent: 100, mwstSatz: 'normal',
    artikelnummer: null, station: null, farbe: null, kategorieId: null, aktiv: true,
    lagerstandAktiv: false, lagerstandMenge: null, mindestbestand: null, seriennummernAktiv: false,
    istFavorit: false, reihenfolge: 0, favoritenReihenfolge: 0, bonierdruckerId: null,
    bonierBeiDirektverkauf: false, istBestandteil: false, bestandteile: [], lieferantId: null,
    terminalSichtbar: null, createdAt: '', updatedAt: '',
    ...teil,
  }
}

// Speisen stehen an der Kasse VOR den Getränken (Reihenfolge 1 vs. 2)
const kategorien = [kat(KAT_GETRAENKE, 'Getränke', 2), kat(KAT_SPEISEN, 'Speisen', 1)]
const bier    = art({ bezeichnung: 'Bier',    kategorieId: KAT_GETRAENKE, reihenfolge: 1, preisBruttoCent: 450, istFavorit: true })
const cola    = art({ bezeichnung: 'Cola',    kategorieId: KAT_GETRAENKE, reihenfolge: 0, preisBruttoCent: 350 })
const schnitz = art({ bezeichnung: 'Schnitzel', kategorieId: KAT_SPEISEN, reihenfolge: 0, preisBruttoCent: 1450, artikelnummer: 'A-10' })
const pfand   = art({ bezeichnung: 'Pfand',   preisBruttoCent: 200, artikelnummer: 'A-9', aktiv: false })
const alle    = [pfand, bier, schnitz, cola]
const namen   = (a: Artikel[]) => a.map(x => x.bezeichnung)

describe('sortiereArtikel', () => {
  it('Standard = Kassen-Reihenfolge: Warengruppe, dann Artikel-Reihenfolge, ohne Warengruppe hinten', () => {
    expect(namen(sortiereArtikel(alle, kategorien, STANDARD_SORTIERUNG))).toEqual(['Schnitzel', 'Cola', 'Bier', 'Pfand'])
  })

  it('Warengruppe alphabetisch, darin Kassen-Reihenfolge; ohne Warengruppe in beiden Richtungen hinten', () => {
    expect(namen(sortiereArtikel(alle, kategorien, { spalte: 'kategorie', richtung: 'auf' })))
      .toEqual(['Cola', 'Bier', 'Schnitzel', 'Pfand'])
    expect(namen(sortiereArtikel(alle, kategorien, { spalte: 'kategorie', richtung: 'ab' })))
      .toEqual(['Schnitzel', 'Cola', 'Bier', 'Pfand'])
  })

  it('Preis numerisch, Nummer natürlich (A-9 vor A-10), leere Nummern hinten', () => {
    expect(namen(sortiereArtikel(alle, kategorien, { spalte: 'preis', richtung: 'ab' })))
      .toEqual(['Schnitzel', 'Bier', 'Cola', 'Pfand'])
    expect(namen(sortiereArtikel(alle, kategorien, { spalte: 'nummer', richtung: 'auf' })).slice(0, 2))
      .toEqual(['Pfand', 'Schnitzel'])
  })

  it('Favoriten und aktive Artikel zuerst', () => {
    expect(namen(sortiereArtikel(alle, kategorien, { spalte: 'favorit', richtung: 'auf' }))[0]).toBe('Bier')
    expect(namen(sortiereArtikel(alle, kategorien, { spalte: 'status', richtung: 'auf' })).at(-1)).toBe('Pfand')
  })

  it('Klick auf dieselbe Spalte dreht die Richtung, neue Spalte beginnt aufsteigend', () => {
    const s1 = naechsteSortierung(STANDARD_SORTIERUNG, 'preis')
    expect(s1).toEqual({ spalte: 'preis', richtung: 'auf' })
    expect(naechsteSortierung(s1, 'preis')).toEqual({ spalte: 'preis', richtung: 'ab' })
    expect(naechsteSortierung(s1, 'kategorie')).toEqual({ spalte: 'kategorie', richtung: 'auf' })
  })
})

describe('filtereArtikel', () => {
  it('filtert nach Warengruppe, „ohne" und Suchtext (Bezeichnung oder Nummer)', () => {
    expect(namen(filtereArtikel(alle, KAT_GETRAENKE, ''))).toEqual(['Bier', 'Cola'])
    expect(namen(filtereArtikel(alle, 'ohne', ''))).toEqual(['Pfand'])
    expect(namen(filtereArtikel(alle, 'alle', 'a-1'))).toEqual(['Schnitzel'])
    expect(namen(filtereArtikel(alle, KAT_GETRAENKE, 'COL'))).toEqual(['Cola'])
  })
})

describe('findeDuplikate', () => {
  it('findet gleiche Bezeichnung in derselben Warengruppe — nicht in einer anderen', () => {
    const d = findeDuplikate([
      { zeile: 2, bezeichnung: '  bier ', kategorie: 'getränke' },
      { zeile: 3, bezeichnung: 'Bier',    kategorie: 'Speisen' },
      { zeile: 4, bezeichnung: 'Pfand',   kategorie: '' },
    ], alle, kategorien)
    expect(d.get(2)?.vorhanden?.id).toBe(bier.id)
    expect(d.has(3)).toBe(false)
    // Deaktivierte Artikel zählen mit
    expect(d.get(4)?.vorhanden?.id).toBe(pfand.id)
  })

  it('meldet doppelte Zeilen in derselben Datei ab der zweiten', () => {
    const d = findeDuplikate([
      { zeile: 2, bezeichnung: 'Radler', kategorie: 'Getränke' },
      { zeile: 5, bezeichnung: 'radler', kategorie: 'Getränke' },
    ], alle, kategorien)
    expect(d.has(2)).toBe(false)
    expect(d.get(5)).toEqual({ dateiZeile: 2 })
  })

  it('bevorzugt den aktiven Artikel, wenn es auch einen deaktivierten gleichen gibt', () => {
    const alt = art({ bezeichnung: 'Bier', kategorieId: KAT_GETRAENKE, aktiv: false })
    const d = findeDuplikate([{ zeile: 2, bezeichnung: 'Bier', kategorie: 'Getränke' }], [alt, bier], kategorien)
    expect(d.get(2)?.vorhanden?.id).toBe(bier.id)
  })
})

describe('aktualisierungAusImport', () => {
  const daten = {
    bezeichnung: 'Bier', preisBruttoCent: 480, mwstSatz: 'normal' as const, station: null, kategorieId: KAT_GETRAENKE,
    istFavorit: false, lagerstandAktiv: true, lagerstandMenge: 50, mindestbestand: 5, seriennummernAktiv: false,
    terminalSichtbar: null, bonierBeiDirektverkauf: false, istBestandteil: false, bestandteile: [],
  }

  it('übernimmt Preis + Lagerführung, setzt die Menge nur beim Einschalten der Lagerführung', () => {
    expect(aktualisierungAusImport(bier, daten)).toMatchObject({ preisBruttoCent: 480, lagerstandAktiv: true, lagerstandMenge: 50 })
    const mitLager = { ...bier, lagerstandAktiv: true, lagerstandMenge: 12 }
    expect(aktualisierungAusImport(mitLager, daten)).not.toHaveProperty('lagerstandMenge')
  })

  it('aktiviert einen deaktivierten Artikel wieder', () => {
    expect(aktualisierungAusImport(pfand, daten).aktiv).toBe(true)
    expect(aktualisierungAusImport(bier, daten)).not.toHaveProperty('aktiv')
  })
})
