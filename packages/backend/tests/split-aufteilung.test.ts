/**
 * Unit-Tests für pruefeAufteilung (tisch-tab.service) — die rein rechnerische
 * Vorabprüfung beim Rechnung-Teilen, bevor der erste Teilbeleg entsteht.
 *
 * Schwerpunkt ist das Zuordnen der Zahler-Positionen zum Tab: gleiche Position
 * aus mehreren Bestellrunden, Optionen (auch deren Anzahl) und Preise. Das
 * Alles-oder-nichts gegen die echte DB prüft tests/integration/tisch-tab-split.test.ts.
 */

import { describe, it, expect } from 'vitest'
import type { TabPosition, TischTabSplittenInput } from '@kassa/shared'
import { pruefeAufteilung, TischTabError } from '../src/services/tisch-tab.service.js'

const BIER   = '00000000-0000-4000-8000-00000000b1e2'
const BURGER = '00000000-0000-4000-8000-0000000b0e6e'
const POMMES = { modifikatorId: '00000000-0000-4000-8000-00000000c0f1', gruppeId: '00000000-0000-4000-8000-00000000c0f0', gruppeName: 'Beilage', name: 'Pommes', aufschlagCent: 150 }
const SALAT  = { ...POMMES, modifikatorId: '00000000-0000-4000-8000-00000000c0f2', name: 'Salat' }

type Zahler = TischTabSplittenInput['zahlungen'][number]

const bier = (menge: number): TabPosition => ({ artikelId: BIER, bezeichnung: 'Bier', preisBruttoCent: 500, menge })
const burgerMit = (option: typeof POMMES, menge = 1): TabPosition =>
  ({ artikelId: BURGER, bezeichnung: 'Burger', preisBruttoCent: 1140, menge, modifikatoren: [option] })

const zahler = (positionen: TabPosition[], barCent: number, karteCent = 0): Zahler =>
  ({ positionen, zahlung: { barCent, karteCent, sonstigeCent: 0 } })

function fehlerVon(fn: () => unknown): TischTabError {
  try {
    fn()
  } catch (err) {
    if (err instanceof TischTabError) return err
    throw err
  }
  throw new Error('Kein Fehler geworfen')
}

describe('pruefeAufteilung', () => {
  it('liefert je Zahler die Belegpositionen mit Tab-Preis und Options-Zusatz', () => {
    const teile = pruefeAufteilung([bier(2), burgerMit(POMMES)], [
      zahler([bier(1)], 500),
      zahler([bier(1), burgerMit(POMMES)], 0, 1640),
    ])
    expect(teile).toEqual([
      { positionen: [{ artikelId: BIER, menge: 1, einzelpreisBreuttoCent: 500 }], zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 } },
      {
        positionen: [
          { artikelId: BIER,   menge: 1, einzelpreisBreuttoCent: 500 },
          { artikelId: BURGER, menge: 1, einzelpreisBreuttoCent: 1140, bezeichnungZusatz: 'Pommes' },
        ],
        zahlung: { barCent: 0, karteCent: 1640, sonstigeCent: 0 },
      },
    ])
  })

  it('gleiche Position aus zwei Bestellrunden lässt sich frei über die Zahler verteilen', () => {
    // Runde 1: 2 Bier, Runde 2: 1 Bier — zwei Tab-Zeilen, ein Schlüssel
    const teile = pruefeAufteilung([bier(2), bier(1)], [
      zahler([bier(1), bier(1)], 1000),  // je eins aus Runde 1 und Runde 2
      zahler([bier(1)], 500),
    ])
    expect(teile.map(t => t.positionen.reduce((s, p) => s + p.menge, 0))).toEqual([2, 1])
  })

  it('Options-Anzahl: fehlende Anzahl und Anzahl 1 sind dieselbe Position', () => {
    const tab = [{ ...burgerMit(POMMES), modifikatoren: [{ ...POMMES, menge: 1 }] }]
    expect(() => pruefeAufteilung(tab, [zahler([burgerMit(POMMES)], 1140)])).not.toThrow()
  })

  it('andere Option zum gleichen Preis ist NICHT dieselbe Position', () => {
    const f = fehlerVon(() => pruefeAufteilung([burgerMit(POMMES, 2)], [
      zahler([burgerMit(POMMES)], 1140),
      zahler([burgerMit(SALAT)],  1140),
    ]))
    expect(f.httpStatus).toBe(400)
    expect(f.message).toBe('Zahler 2: „Burger" steht so nicht (mehr) auf dem Tisch — bitte neu laden')
  })

  it('anderer Preis (z. B. manipuliert oder veraltet) wird abgewiesen', () => {
    const f = fehlerVon(() => pruefeAufteilung([bier(2)], [
      zahler([{ ...bier(1), preisBruttoCent: 1 }], 1),
      zahler([bier(1)], 500),
    ]))
    expect(f.message).toMatch(/^Zahler 1: „Bier" steht so nicht/)
  })

  it('gemischt bezahlt (bar + Karte) passt, ein Cent daneben nicht', () => {
    const tab = [bier(1), burgerMit(POMMES)]
    expect(() => pruefeAufteilung(tab, [zahler([bier(1)], 200, 300), zahler([burgerMit(POMMES)], 1000, 140)])).not.toThrow()
    const f = fehlerVon(() => pruefeAufteilung(tab, [zahler([bier(1)], 200, 300), zahler([burgerMit(POMMES)], 1000, 139)]))
    expect(f.message).toBe('Zahler 2: Zahlung 11,39 € passt nicht zur Summe 11,40 €')
  })

  it('unvollständig aufgeteilt → 400 mit dem, was fehlt', () => {
    const f = fehlerVon(() => pruefeAufteilung([bier(3), burgerMit(POMMES)], [
      zahler([bier(1)], 500),
      zahler([burgerMit(POMMES)], 1140),
    ]))
    expect(f.httpStatus).toBe(400)
    expect(f.message).toBe('Nicht alles aufgeteilt: 2× Bier')
  })

  it('mehr aufgeteilt als bestellt → 400', () => {
    const f = fehlerVon(() => pruefeAufteilung([bier(1)], [
      zahler([bier(1)], 500),
      zahler([bier(1)], 500),
    ]))
    expect(f.message).toBe('Zahler 2: „Bier" ist öfter aufgeteilt als bestellt')
  })
})
