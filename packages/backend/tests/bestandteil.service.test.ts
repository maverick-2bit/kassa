/**
 * Unit-Tests für die reine Rohstoff-/Stücklisten-Logik (bestandteil.service).
 *
 * Deckt die zwei korrektheits-kritischen Funktionen ohne DB ab:
 *   - berechneVerfuegbareMenge: abgeleitete Verfügbarkeit = min über lagergeführte
 *     Bestandteile von floor(lager / rezeptMenge); null wenn kein Rezept-Limit.
 *   - summiereBedarf: Bestandteil-Bedarf = Σ (rezeptMenge × delta) je Bestandteil,
 *     inkl. Mehrfachnutzung desselben Rohstoffs und negativer Deltas (Storno).
 */

import { describe, it, expect } from 'vitest'
import {
  berechneVerfuegbareMenge,
  summiereBedarf,
  type BestandteilAngereichert,
  type RezeptBestandteil,
} from '../src/services/bestandteil.service.js'

// Bequemer Builder für einen angereicherten Bestandteil
function b(
  bestandteilArtikelId: string,
  menge: number,
  lagerstandMenge: number | null,
  lagerstandAktiv = true,
): BestandteilAngereichert {
  return { bestandteilArtikelId, bezeichnung: bestandteilArtikelId, menge, lagerstandAktiv, lagerstandMenge }
}

describe('berechneVerfuegbareMenge', () => {
  it('kein Bestandteil → null (kein Rezept-Limit)', () => {
    expect(berechneVerfuegbareMenge([])).toBeNull()
  })

  it('nur nicht-lagergeführte Bestandteile → null', () => {
    expect(berechneVerfuegbareMenge([
      b('X', 1, null),               // lagerstandMenge null
      b('Y', 2, 50, false),          // lagerstandAktiv false
    ])).toBeNull()
  })

  it('ein Bestandteil: floor(lager / rezeptMenge)', () => {
    expect(berechneVerfuegbareMenge([b('Schnitzel', 2, 100)])).toBe(50)
    expect(berechneVerfuegbareMenge([b('Schnitzel', 2, 97)])).toBe(48)  // floor(48.5)
    expect(berechneVerfuegbareMenge([b('Schnitzel', 2, 5)])).toBe(2)    // floor(2.5)
  })

  it('Sperre: Bestandteil-Lager 0 → 0', () => {
    expect(berechneVerfuegbareMenge([b('Schnitzel', 1, 0)])).toBe(0)
    expect(berechneVerfuegbareMenge([b('Schnitzel', 2, 0)])).toBe(0)
  })

  it('mehrere Bestandteile → Minimum über alle', () => {
    // 100/2=50 vs 30/1=30 → 30 ist der Engpass
    expect(berechneVerfuegbareMenge([
      b('Schnitzel', 2, 100),
      b('Semmel',    1, 30),
    ])).toBe(30)
  })

  it('nicht-lagergeführte Bestandteile begrenzen nicht', () => {
    // nur der geführte (10/5=2) zählt; der ungeführte wird ignoriert
    expect(berechneVerfuegbareMenge([
      b('Panade', 5, 10),
      b('Gewürz', 1, null),
    ])).toBe(2)
  })

  it('menge <= 0 wird ignoriert (keine Division durch 0)', () => {
    expect(berechneVerfuegbareMenge([b('X', 0, 100)])).toBeNull()
    expect(berechneVerfuegbareMenge([
      b('X', 0, 100),
      b('Y', 4, 20),   // 20/4 = 5
    ])).toBe(5)
  })
})

describe('summiereBedarf', () => {
  const rezept = (...eintraege: RezeptBestandteil[]) => eintraege

  it('Artikel ohne Rezept → leerer Bedarf', () => {
    const bedarf = summiereBedarf([{ artikelId: 'Kaffee', delta: 3 }], new Map())
    expect(bedarf.size).toBe(0)
  })

  it('ein Artikel, ein Bestandteil: menge × delta', () => {
    const rez = new Map([['Wiener', rezept({ bestandteilArtikelId: 'Schnitzel', menge: 2 })]])
    expect(summiereBedarf([{ artikelId: 'Wiener', delta: 1 }], rez).get('Schnitzel')).toBe(2)
    expect(summiereBedarf([{ artikelId: 'Wiener', delta: 3 }], rez).get('Schnitzel')).toBe(6)
  })

  it('Nutzer-Beispiel: Wiener (2×) + Semmel (1×) desselben Rohstoffs → Summe 3', () => {
    const rez = new Map([
      ['Wiener', rezept({ bestandteilArtikelId: 'Schnitzel', menge: 2 })],
      ['Semmel', rezept({ bestandteilArtikelId: 'Schnitzel', menge: 1 })],
    ])
    const bedarf = summiereBedarf(
      [{ artikelId: 'Wiener', delta: 1 }, { artikelId: 'Semmel', delta: 1 }],
      rez,
    )
    expect(bedarf.get('Schnitzel')).toBe(3)
  })

  it('negatives Delta (Storno) → negativer Bedarf (Rückbuchung)', () => {
    const rez = new Map([['Wiener', rezept({ bestandteilArtikelId: 'Schnitzel', menge: 2 })]])
    expect(summiereBedarf([{ artikelId: 'Wiener', delta: -1 }], rez).get('Schnitzel')).toBe(-2)
  })

  it('mehrere Bestandteile je Rezept werden getrennt summiert', () => {
    const rez = new Map([['Menu', rezept(
      { bestandteilArtikelId: 'Schnitzel', menge: 2 },
      { bestandteilArtikelId: 'Pommes',    menge: 1 },
    )]])
    const bedarf = summiereBedarf([{ artikelId: 'Menu', delta: 2 }], rez)
    expect(bedarf.get('Schnitzel')).toBe(4)
    expect(bedarf.get('Pommes')).toBe(2)
  })

  it('gegenläufige Deltas heben sich auf (Netto 0)', () => {
    const rez = new Map([['Wiener', rezept({ bestandteilArtikelId: 'Schnitzel', menge: 2 })]])
    const bedarf = summiereBedarf(
      [{ artikelId: 'Wiener', delta: 3 }, { artikelId: 'Wiener', delta: -3 }],
      rez,
    )
    expect(bedarf.get('Schnitzel')).toBe(0)
  })
})
