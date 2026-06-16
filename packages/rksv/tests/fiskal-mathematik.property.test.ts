/**
 * Property-based Tests fuer die Fiskal-Mathematik.
 *
 * Statt einzelner Beispiele werden Invarianten ueber viele zufaellig generierte
 * Eingaben geprueft (deterministischer Seed -> reproduzierbar). Geld-/Vorzeichen-
 * fehler (wie der Storno-Doppelnegations-Bug im BMD-Export) sind genau die Klasse
 * von Fehlern, die solche Eigenschaften aufdecken.
 *
 * Geprueft: berechneBetraege (Bucket-Aufteilung), gesamtBetragCent (Summe),
 * Umsatzzaehler (Akkumulation inkl. Storno).
 */

import { describe, it, expect } from 'vitest'
import { berechneBetraege, gesamtBetragCent, Umsatzzaehler } from '../src/beleg.js'
import { MWST_PROZENT, type BelegPosition, type MwStSatz, type BetraegeSummen } from '../src/types.js'

// ---------------------------------------------------------------------------
// Deterministischer PRNG (mulberry32) — reproduzierbar bei Fehlern
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SAETZE = Object.keys(MWST_PROZENT) as MwStSatz[]

/** Laeuft eine Eigenschaft ueber `runs` zufaellige Faelle; meldet bei Fehler den Fall. */
function forAll<T>(runs: number, seed: number, gen: (rnd: () => number) => T, pruefe: (fall: T) => void) {
  const rnd = mulberry32(seed)
  for (let i = 0; i < runs; i++) {
    const fall = gen(rnd)
    try {
      pruefe(fall)
    } catch (err) {
      throw new Error(`Property verletzt bei Iteration ${i} (seed ${seed}), Fall: ${JSON.stringify(fall, (_, v) => typeof v === 'bigint' ? v.toString() : v)}\n${(err as Error).message}`)
    }
  }
}

const intIn = (rnd: () => number, min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min
const randSatz = (rnd: () => number): MwStSatz => SAETZE[intIn(rnd, 0, SAETZE.length - 1)]!

/** Eine Position mit ganzzahliger Menge != 0 und Bruttopreis in [0, 1_000_000] Cent. */
function randPos(rnd: () => number, vorzeichen: 'beliebig' | 'positiv' | 'negativ' = 'beliebig'): BelegPosition {
  let menge = intIn(rnd, 1, 12)
  if (vorzeichen === 'negativ' || (vorzeichen === 'beliebig' && rnd() < 0.25)) menge = -menge
  return {
    bezeichnung:        'Pos',
    menge,
    einzelpreisBreutto: intIn(rnd, 0, 1_000_000),
    mwstSatz:           randSatz(rnd),
  }
}

function randPositionen(rnd: () => number, vorzeichen: 'beliebig' | 'positiv' | 'negativ' = 'beliebig'): BelegPosition[] {
  const n = intIn(rnd, 0, 15)
  return Array.from({ length: n }, () => randPos(rnd, vorzeichen))
}

const posBrutto = (p: BelegPosition) => Math.round(p.menge * p.einzelpreisBreutto)
const summeBuckets = (b: BetraegeSummen) => b.normal + b.ermaessigt1 + b.ermaessigt2 + b.null + b.besonders

// ---------------------------------------------------------------------------
// berechneBetraege
// ---------------------------------------------------------------------------

describe('berechneBetraege (property-based)', () => {
  it('Summe aller Buckets == Summe der Positions-Bruttobetraege', () => {
    forAll(500, 1, randPositionen, (pos) => {
      const b = berechneBetraege(pos)
      const erwartet = pos.reduce((s, p) => s + posBrutto(p), 0)
      expect(summeBuckets(b)).toBe(erwartet)
    })
  })

  it('jeder Steuersatz-Bucket == Summe genau seiner Positionen', () => {
    forAll(500, 2, randPositionen, (pos) => {
      const b = berechneBetraege(pos)
      for (const satz of SAETZE) {
        const erwartet = pos.filter(p => p.mwstSatz === satz).reduce((s, p) => s + posBrutto(p), 0)
        expect(b[satz]).toBe(erwartet)
      }
    })
  })

  it('reihenfolge-unabhaengig (Permutation liefert identische Summen)', () => {
    forAll(300, 3, (rnd) => ({ pos: randPositionen(rnd), r: rnd }), ({ pos, r }) => {
      const gemischt = [...pos].sort(() => r() - 0.5)
      expect(berechneBetraege(gemischt)).toEqual(berechneBetraege(pos))
    })
  })

  it('gesamtBetragCent == arithmetische Summe der Buckets', () => {
    forAll(500, 4, randPositionen, (pos) => {
      const b = berechneBetraege(pos)
      expect(gesamtBetragCent(b)).toBe(BigInt(summeBuckets(b)))
    })
  })

  it('nur-positive Positionen -> alle Buckets >= 0; nur-negative (Storno) -> alle <= 0', () => {
    forAll(300, 5, (rnd) => randPositionen(rnd, 'positiv'), (pos) => {
      const b = berechneBetraege(pos)
      for (const satz of SAETZE) expect(b[satz]).toBeGreaterThanOrEqual(0)
    })
    forAll(300, 6, (rnd) => randPositionen(rnd, 'negativ'), (pos) => {
      const b = berechneBetraege(pos)
      for (const satz of SAETZE) expect(b[satz]).toBeLessThanOrEqual(0)
    })
  })

  it('leere Positionsliste -> alle Buckets 0', () => {
    const b = berechneBetraege([])
    expect(b).toEqual({ normal: 0, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 0 })
    expect(gesamtBetragCent(b)).toBe(0n)
  })

  it('Storno hebt Verkauf exakt auf (Verkauf + negierte Positionen == 0)', () => {
    forAll(300, 7, (rnd) => randPositionen(rnd, 'positiv'), (pos) => {
      const storno = pos.map(p => ({ ...p, menge: -p.menge }))
      const gesamt = gesamtBetragCent(berechneBetraege([...pos, ...storno]))
      expect(gesamt).toBe(0n)
    })
  })
})

// ---------------------------------------------------------------------------
// Umsatzzaehler
// ---------------------------------------------------------------------------

describe('Umsatzzaehler (property-based)', () => {
  it('Endstand == Summe aller addierten Betraege (Reihenfolge egal)', () => {
    forAll(500, 8, (rnd) => Array.from({ length: intIn(rnd, 0, 30) }, () => BigInt(intIn(rnd, -100000, 100000))),
      (betraege) => {
        const z = new Umsatzzaehler(0n)
        for (const b of betraege) z.addiere(b)
        const erwartet = betraege.reduce((s, b) => s + b, 0n)
        expect(z.aktuell).toBe(erwartet)
      })
  })

  it('Startwert wird beruecksichtigt', () => {
    forAll(300, 9, (rnd) => ({ start: BigInt(intIn(rnd, 0, 1_000_000)), delta: BigInt(intIn(rnd, -50000, 50000)) }),
      ({ start, delta }) => {
        const z = new Umsatzzaehler(start)
        expect(z.addiere(delta)).toBe(start + delta)
        expect(z.aktuell).toBe(start + delta)
      })
  })

  it('aktuell ist seiteneffektfrei (mehrfaches Lesen aendert nichts)', () => {
    const z = new Umsatzzaehler(4711n)
    expect(z.aktuell).toBe(4711n)
    expect(z.aktuell).toBe(4711n)
    z.addiere(0n)
    expect(z.aktuell).toBe(4711n)
  })

  it('Storno (negativer Betrag) senkt den Zaehler um genau den Betrag', () => {
    forAll(300, 10, (rnd) => ({ start: BigInt(intIn(rnd, 0, 1_000_000)), storno: BigInt(intIn(rnd, 1, 500000)) }),
      ({ start, storno }) => {
        const z = new Umsatzzaehler(start)
        z.addiere(-storno)
        expect(z.aktuell).toBe(start - storno)
      })
  })
})
