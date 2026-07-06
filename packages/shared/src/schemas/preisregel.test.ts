import { describe, it, expect } from 'vitest'
import {
  imZeitfenster,
  imAnyZeitfenster,
  isoWochentag,
  datumISO,
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
  datumTage:     [],
  zeitfenster:   [{ von: '17:00', bis: '19:00' }],
  gueltigVon:    null,
  gueltigBis:    null,
  rabattProzent: 20,
  kategorieIds:  [],
  artikelIds:    [],
  createdAt:     '',
  updatedAt:     '',
  ...over,
})

// 6. Juli 2026 = Montag, 11. Juli 2026 = Samstag (lokale Zeit)
const mo18 = new Date(2026, 6, 6, 18, 0)
const mo16 = new Date(2026, 6, 6, 16, 0)
const mo13 = new Date(2026, 6, 6, 13, 0)
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

describe('imAnyZeitfenster / mehrere Fenster', () => {
  const fenster = [{ von: '12:00', bis: '14:00' }, { von: '18:00', bis: '20:00' }]
  it('erstes Fenster', () => expect(imAnyZeitfenster(fenster, mo13)).toBe(true))
  it('zweites Fenster', () => expect(imAnyZeitfenster(fenster, mo18)).toBe(true))
  it('zwischen den Fenstern', () => expect(imAnyZeitfenster(fenster, mo16)).toBe(false))
})

describe('isoWochentag / datumISO', () => {
  it('Montag = 1', () => expect(isoWochentag(mo18)).toBe(1))
  it('Samstag = 6', () => expect(isoWochentag(sa18)).toBe(6))
  it('datumISO lokal', () => expect(datumISO(mo18)).toBe('2026-07-06'))
})

describe('regelGiltJetzt — Zeit/Tag', () => {
  it('gilt Mo 18 Uhr', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, mo18)).toBe(true))
  it('gilt nicht Sa (nicht in wochentage)', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, sa18)).toBe(false))
  it('gilt nicht außerhalb der Zeit', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, mo16)).toBe(false))
  it('inaktive Regel gilt nie', () => expect(regelGiltJetzt(mkRegel({ aktiv: false }), 'a1', null, mo18)).toBe(false))
})

describe('regelGiltJetzt — mehrere Zeitfenster', () => {
  const r = mkRegel({ zeitfenster: [{ von: '12:00', bis: '14:00' }, { von: '18:00', bis: '20:00' }] })
  it('gilt im Mittagsfenster', () => expect(regelGiltJetzt(r, 'a1', null, mo13)).toBe(true))
  it('gilt im Abendfenster', () => expect(regelGiltJetzt(r, 'a1', null, mo18)).toBe(true))
  it('gilt nicht dazwischen', () => expect(regelGiltJetzt(r, 'a1', null, mo16)).toBe(false))
})

describe('regelGiltJetzt — konkrete Kalendertage', () => {
  const r = mkRegel({ wochentage: [], datumTage: ['2026-07-11'] }) // nur Sa 11.7.
  it('gilt am konkreten Datum', () => expect(regelGiltJetzt(r, 'a1', null, sa18)).toBe(true))
  it('gilt nicht an anderem Datum', () => expect(regelGiltJetzt(r, 'a1', null, mo18)).toBe(false))
  it('Wochentag ODER Datum', () => {
    const r2 = mkRegel({ wochentage: [1], datumTage: ['2026-07-11'] })
    expect(regelGiltJetzt(r2, 'a1', null, mo18)).toBe(true) // Montag
    expect(regelGiltJetzt(r2, 'a1', null, sa18)).toBe(true) // konkretes Datum
  })
})

describe('regelGiltJetzt — Aktionszeitraum', () => {
  it('innerhalb des Zeitraums', () =>
    expect(regelGiltJetzt(mkRegel({ gueltigVon: '2026-07-01', gueltigBis: '2026-07-31' }), 'a1', null, mo18)).toBe(true))
  it('vor dem Zeitraum', () =>
    expect(regelGiltJetzt(mkRegel({ gueltigVon: '2026-08-01' }), 'a1', null, mo18)).toBe(false))
  it('nach dem Zeitraum', () =>
    expect(regelGiltJetzt(mkRegel({ gueltigBis: '2026-06-30' }), 'a1', null, mo18)).toBe(false))
})

describe('regelGiltJetzt — Geltungsbereich', () => {
  it('leer+leer gilt für alle Artikel', () => expect(regelGiltJetzt(mkRegel(), 'aX', 'kX', mo18)).toBe(true))
  it('Warengruppe: passende Kategorie', () => expect(regelGiltJetzt(mkRegel({ kategorieIds: ['k1'] }), 'a1', 'k1', mo18)).toBe(true))
  it('Warengruppe: andere Kategorie', () => expect(regelGiltJetzt(mkRegel({ kategorieIds: ['k1'] }), 'a1', 'k2', mo18)).toBe(false))
  it('Einzel-Artikel: passender Artikel', () => expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'] }), 'a1', 'k9', mo18)).toBe(true))
  it('Einzel-Artikel: anderer Artikel', () => expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'] }), 'a2', 'k9', mo18)).toBe(false))
})

describe('happyHourPreisCent / aktiverRabattProzent', () => {
  it('wendet den Rabatt an', () => expect(happyHourPreisCent(500, [mkRegel()], 'a1', null, mo18)).toBe(400))
  it('rundet kaufmännisch', () => expect(happyHourPreisCent(319, [mkRegel({ rabattProzent: 20 })], 'a1', null, mo18)).toBe(255)) // 255.2
  it('kein Rabatt außerhalb', () => expect(happyHourPreisCent(500, [mkRegel()], 'a1', null, mo16)).toBe(500))
  it('größter passender Rabatt gewinnt', () =>
    expect(aktiverRabattProzent([mkRegel({ rabattProzent: 10 }), mkRegel({ rabattProzent: 30 })], 'a1', null, mo18)).toBe(30))
})
