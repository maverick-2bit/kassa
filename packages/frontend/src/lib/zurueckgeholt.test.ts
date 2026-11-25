import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BelegResponse } from '@kassa/shared'
import {
  OFFEN_GILT_MS, beobachteVergessen, leseOffenenStorno, leseZurueckgeholt, merkeZurueckgeholt, positionenAusBeleg,
  vergissZurueckgeholt, zurueckholenGesperrt, type ZurueckgeholterBeleg,
} from './zurueckgeholt'

type Pos = BelegResponse['positionen'][number]
const pos = (p: Partial<Pos>): Pos => ({ bezeichnung: 'Spritzer', menge: 1, einzelpreisBreutto: 380, mwstSatz: 'normal', ...p })
const aus = (...p: Partial<Pos>[]) => positionenAusBeleg({ positionen: p.map(pos) })

const eintrag = (ueber: Partial<ZurueckgeholterBeleg> = {}): ZurueckgeholterBeleg => ({
  status: 'bereit', zeit: 1000, belegId: 'b1', belegNummer: 7, belegKasseId: 'k9', kasseBezeichnung: 'Bar', stornoNummer: 8,
  positionen: aus({}), ...ueber,
})

describe('positionenAusBeleg', () => {
  it('ganze Mengen bleiben unverändert (auch Rabattzeilen mit negativem Preis)', () => {
    expect(aus({ menge: 4 }, { bezeichnung: 'Rabatt (10%)', einzelpreisBreutto: -152 })).toEqual([
      { bezeichnung: 'Spritzer', menge: 4, preisCent: 380, mwstSatz: 'normal' },
      { bezeichnung: 'Rabatt (10%)', menge: 1, preisCent: -152, mwstSatz: 'normal' },
    ])
  })

  it('Bruchmenge → Menge 1 mit dem gebuchten Zeilenbetrag', () => {
    expect(aus({ bezeichnung: 'Käse', menge: 0.5, einzelpreisBreutto: 1999 })).toEqual([
      { bezeichnung: '0,5 × Käse', menge: 1, preisCent: 1000, mwstSatz: 'normal' },
    ])
  })

  it('halbe Cent runden wie beim Signieren von Null weg (Retoure: sonst ein Cent daneben)', () => {
    expect(aus({ menge: 1.5, einzelpreisBreutto: 333 })[0]!.preisCent).toBe(500)
    expect(aus({ menge: 1.5, einzelpreisBreutto: -333 })[0]!.preisCent).toBe(-500)
    expect(Object.is(aus({ menge: 0.5, einzelpreisBreutto: 0 })[0]!.preisCent, 0)).toBe(true)
  })

  it('Seriennummern stehen in der Bezeichnung, höchstens 200 Zeichen', () => {
    expect(aus({ bezeichnung: 'Drucker', seriennummern: ['A1', 'A2'], menge: 2 })[0]!.bezeichnung).toBe('Drucker (SN A1, A2)')
    expect(aus({ bezeichnung: 'x'.repeat(250) })[0]!.bezeichnung).toHaveLength(200)
    expect(aus({ bezeichnung: 'x'.repeat(199), menge: 0.5 })[0]!.bezeichnung).toHaveLength(200)
  })
})

describe('zurueckholenGesperrt', () => {
  it('Gutschein/Kredit (sonstige Zahlung, auch teilweise) sperrt; bar und Karte nicht', () => {
    expect(zurueckholenGesperrt({ summeSonstigeCent: 0 })).toBeNull()
    expect(zurueckholenGesperrt({ summeSonstigeCent: 500 })).toMatch(/doppelt zahlen/)
    expect(zurueckholenGesperrt({ summeSonstigeCent: -500 })).not.toBeNull()
  })
})

describe('Warenkorb im Speicher des Geräts', () => {
  let speicher: Map<string, string>
  let horcher: ((e: Partial<StorageEvent>) => void)[]

  beforeEach(() => {
    speicher = new Map()
    horcher = []
    vi.stubGlobal('localStorage', {
      getItem:    (k: string) => speicher.get(k) ?? null,
      setItem:    (k: string, v: string) => { speicher.set(k, v) },
      removeItem: (k: string) => { speicher.delete(k) },
    })
    vi.stubGlobal('window', {
      addEventListener:    (_: string, f: never) => { horcher.push(f) },
      removeEventListener: (_: string, f: never) => { horcher = horcher.filter(h => h !== f) },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('je Kasse getrennt; bleibt beim Lesen liegen, bis er vergessen wird', () => {
    expect(merkeZurueckgeholt('k1', eintrag())).toBe(true)
    expect(leseZurueckgeholt('k1')).toEqual(eintrag())
    expect(leseZurueckgeholt('k1')).toEqual(eintrag())
    expect(leseZurueckgeholt('k2')).toBeNull()
    vergissZurueckgeholt('k1')
    expect(leseZurueckgeholt('k1')).toBeNull()
  })

  it('ein vorgemerkter Storno (offen) ist noch kein Warenkorb — und verfällt', () => {
    merkeZurueckgeholt('k1', eintrag({ status: 'offen' }))
    expect(leseZurueckgeholt('k1')).toBeNull()
    expect(leseOffenenStorno('k1', 1000 + OFFEN_GILT_MS - 1)?.belegId).toBe('b1')
    expect(leseOffenenStorno('k1', 1000 + OFFEN_GILT_MS)).toBeNull()
    merkeZurueckgeholt('k1', eintrag())
    expect(leseOffenenStorno('k1', 1000)).toBeNull()
  })

  it('Speicher gesperrt → false (dann wird nicht storniert); kaputter Inhalt → null', () => {
    speicher.set('kassa:zurueckgeholt:k1', '{kaputt')
    expect(leseZurueckgeholt('k1')).toBeNull()
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('voll') }, getItem: () => { throw new Error('gesperrt') } })
    expect(merkeZurueckgeholt('k1', eintrag())).toBe(false)
    expect(leseZurueckgeholt('k1')).toBeNull()
  })

  it('anderer Tab hat ihn kassiert → Meldung; Änderungen und andere Kassen melden nichts', () => {
    const fn = vi.fn()
    const ab = beobachteVergessen('k1', fn)
    horcher[0]!({ key: 'kassa:zurueckgeholt:k1', newValue: '{}' })
    horcher[0]!({ key: 'kassa:zurueckgeholt:k2', newValue: null })
    expect(fn).not.toHaveBeenCalled()
    horcher[0]!({ key: 'kassa:zurueckgeholt:k1', newValue: null })
    expect(fn).toHaveBeenCalledOnce()
    ab()
    expect(horcher).toHaveLength(0)
  })
})
