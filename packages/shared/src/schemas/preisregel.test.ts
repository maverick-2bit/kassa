import { describe, it, expect } from 'vitest'
import {
  imZeitfenster,
  isoWochentag,
  regelGiltJetzt,
  aktiverRabattProzent,
  happyHourPreisCent,
  type Preisregel,
} from './preisregel.js'

const mkRegel = (over: Partial<Preisregel> = {}): Preisregel => ({
  id:            '00000000-0000-0000-0000-000000000001',
  name:          'Happy Hour',
  aktiv:         true,
  wochentage:    [1, 2, 3, 4, 5],
  vonZeit:       '17:00',
  bisZeit:       '19:00',
  rabattProzent: 20,
  kategorieIds:  [],
  artikelIds:    [],
  createdAt:     '',
  updatedAt:     '',
  ...over,
})

// 6. Juli 2026 ist ein Montag (lokale Zeit)
const mo18 = new Date(2026, 6, 6, 18, 0)
const mo16 = new Date(2026, 6, 6, 16, 0)
const mo19 = new Date(2026, 6, 6, 19, 0)
const sa18 = new Date(2026, 6, 11, 18, 0)

describe('imZeitfenster', () => {
  it('innerhalb des Fensters', () => expect(imZeitfenster('17:00', '19:00', mo18)).toBe(true))
  it('davor', () => expect(imZeitfenster('17:00', '19:00', mo16)).toBe(false))
  it('obere Grenze ist exklusiv', () => expect(imZeitfenster('17:00', '19:00', mo19)).toBe(false))
  it('über Mitternacht (von > bis)', () => {
    expect(imZeitfenster('22:00', '02:00', new Date(2026, 6, 6, 23, 0))).toBe(true)
    expect(imZeitfenster('22:00', '02:00', new Date(2026, 6, 6, 1, 0))).toBe(true)
    expect(imZeitfenster('22:00', '02:00', new Date(2026, 6, 6, 12, 0))).toBe(false)
  })
})

describe('isoWochentag', () => {
  it('Montag = 1', () => expect(isoWochentag(mo18)).toBe(1))
  it('Samstag = 6', () => expect(isoWochentag(sa18)).toBe(6))
})

describe('regelGiltJetzt — Zeit/Tag', () => {
  it('gilt Mo 18 Uhr', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, mo18)).toBe(true))
  it('gilt nicht Sa (nicht in wochentage)', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, sa18)).toBe(false))
  it('gilt nicht außerhalb der Zeit', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, mo16)).toBe(false))
  it('inaktive Regel gilt nie', () => expect(regelGiltJetzt(mkRegel({ aktiv: false }), 'a1', null, mo18)).toBe(false))
})

describe('regelGiltJetzt — Geltungsbereich', () => {
  it('leer+leer gilt für alle Artikel', () => expect(regelGiltJetzt(mkRegel(), 'aX', 'kX', mo18)).toBe(true))

  it('Warengruppe: passende Kategorie', () => expect(regelGiltJetzt(mkRegel({ kategorieIds: ['k1'] }), 'a1', 'k1', mo18)).toBe(true))
  it('Warengruppe: andere Kategorie', () => expect(regelGiltJetzt(mkRegel({ kategorieIds: ['k1'] }), 'a1', 'k2', mo18)).toBe(false))

  it('Einzel-Artikel: passender Artikel', () => expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'] }), 'a1', 'k9', mo18)).toBe(true))
  it('Einzel-Artikel: anderer Artikel', () => expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'] }), 'a2', 'k9', mo18)).toBe(false))

  it('Artikel ODER Warengruppe: Artikel passt', () =>
    expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'], kategorieIds: ['k1'] }), 'a1', 'kX', mo18)).toBe(true))
  it('Artikel ODER Warengruppe: Kategorie passt', () =>
    expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'], kategorieIds: ['k1'] }), 'aX', 'k1', mo18)).toBe(true))
  it('Artikel ODER Warengruppe: keins passt', () =>
    expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'], kategorieIds: ['k1'] }), 'aX', 'kX', mo18)).toBe(false))
})

describe('happyHourPreisCent / aktiverRabattProzent', () => {
  it('wendet den Rabatt an', () => expect(happyHourPreisCent(500, [mkRegel()], 'a1', null, mo18)).toBe(400))
  it('rundet kaufmännisch', () => expect(happyHourPreisCent(319, [mkRegel({ rabattProzent: 20 })], 'a1', null, mo18)).toBe(255)) // 255.2
  it('kein Rabatt außerhalb des Fensters', () => expect(happyHourPreisCent(500, [mkRegel()], 'a1', null, mo16)).toBe(500))
  it('größter passender Rabatt gewinnt', () =>
    expect(aktiverRabattProzent([mkRegel({ rabattProzent: 10 }), mkRegel({ rabattProzent: 30 })], 'a1', null, mo18)).toBe(30))
  it('Einzel-Artikel-Regel wirkt nur auf den Artikel', () => {
    const regeln = [mkRegel({ artikelIds: ['nudeln'], rabattProzent: 20 })]
    expect(happyHourPreisCent(1000, regeln, 'nudeln', 'speisen', mo18)).toBe(800)
    expect(happyHourPreisCent(1000, regeln, 'pizza',  'speisen', mo18)).toBe(1000)
  })
})
