import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagesRegel, updateMandantTagesRegel } from './auth'
import {
  addTage,
  datumKurz,
  endeDesMonats,
  geschaeftstagVonZeitpunkt,
  gesternGeschaeftstag,
  heuteGeschaeftstag,
  heuteKalendertag,
  montagDerWoche,
  tagMonat,
} from './geschaeftstag'

/** Minimaler localStorage für die Node-Testumgebung */
function installiereSpeicher(): Map<string, string> {
  const daten = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem:    (k: string) => daten.get(k) ?? null,
    setItem:    (k: string, v: string) => { daten.set(k, v) },
    removeItem: (k: string) => { daten.delete(k) },
  })
  return daten
}

/** Anmeldung so ablegen, wie setAuth() sie speichert */
function meldeAn(daten: Map<string, string>, mandant: Record<string, unknown>): void {
  daten.set('kassa:token', 'test-token')
  daten.set('kassa:auth', JSON.stringify({ user: { rolle: 'admin' }, mandant: { id: 'm1', ...mandant }, kassen: [] }))
}

describe('Geschäftstag im Frontend', () => {
  let speicher: Map<string, string>

  beforeEach(() => {
    speicher = installiereSpeicher()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // 03.10.2026 02:00 Wiener Zeit (MESZ) = 00:00 UTC
  const zweiUhrNachts = new Date('2026-10-03T00:00:00Z')
  // 03.10.2026 07:00 Wiener Zeit = 05:00 UTC
  const siebenUhr = new Date('2026-10-03T05:00:00Z')

  it('ohne Anmeldung und ohne Regel: Geschäftstag = Wiener Kalendertag (Standard 00:00)', () => {
    vi.setSystemTime(zweiUhrNachts)
    expect(tagesRegel()).toEqual([])
    expect(heuteGeschaeftstag()).toBe('2026-10-03')
    expect(heuteKalendertag()).toBe('2026-10-03')
  })

  it('ältere gespeicherte Anmeldung ohne tagesRegel verhält sich wie Standard', () => {
    meldeAn(speicher, { firmenname: 'Alt GmbH' })
    vi.setSystemTime(zweiUhrNachts)
    expect(tagesRegel()).toEqual([])
    expect(heuteGeschaeftstag()).toBe('2026-10-03')
  })

  it('Tagesbeginn 06:00: um 02:00 nachts ist „heute" noch der Vortag, um 07:00 der neue Tag', () => {
    meldeAn(speicher, { tagesRegel: [{ gueltigAb: '2020-01-01', beginn: '06:00' }] })
    vi.setSystemTime(zweiUhrNachts)
    expect(heuteGeschaeftstag()).toBe('2026-10-02')
    expect(gesternGeschaeftstag()).toBe('2026-10-01')
    // der reine Kalendertag bleibt der Kalendertag
    expect(heuteKalendertag()).toBe('2026-10-03')

    vi.setSystemTime(siebenUhr)
    expect(heuteGeschaeftstag()).toBe('2026-10-03')
  })

  it('Stichtag: vor dem Stichtag gilt noch 00:00', () => {
    meldeAn(speicher, { tagesRegel: [{ gueltigAb: '2026-10-04', beginn: '06:00' }] })
    vi.setSystemTime(zweiUhrNachts)
    expect(heuteGeschaeftstag()).toBe('2026-10-03')   // 03.10. liegt VOR dem Stichtag
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z')) // 04.10. 02:00 — Stichtag, Beginn 06:00
    expect(heuteGeschaeftstag()).toBe('2026-10-03')
  })

  it('geschaeftstagVonZeitpunkt rechnet mit derselben Regel (Schicht-/Belegzeitpunkt)', () => {
    meldeAn(speicher, { tagesRegel: [{ gueltigAb: '2020-01-01', beginn: '06:00' }] })
    expect(geschaeftstagVonZeitpunkt('2026-10-03T00:00:00Z')).toBe('2026-10-02')
    expect(geschaeftstagVonZeitpunkt(new Date('2026-10-03T04:00:00Z'))).toBe('2026-10-03')   // 06:00 MESZ
  })

  it('der Merker folgt dem gespeicherten Stand (neue Anmeldung/Abgleich wirkt sofort)', () => {
    meldeAn(speicher, {})
    vi.setSystemTime(zweiUhrNachts)
    expect(heuteGeschaeftstag()).toBe('2026-10-03')
    meldeAn(speicher, { tagesRegel: [{ gueltigAb: '2020-01-01', beginn: '06:00' }] })
    expect(heuteGeschaeftstag()).toBe('2026-10-02')
  })

  it('kaputte Daten im Speicher werfen nicht, sondern gelten als Standard', () => {
    speicher.set('kassa:token', 'x')
    speicher.set('kassa:auth', '{kein json')
    expect(tagesRegel()).toEqual([])
    meldeAn(speicher, { tagesRegel: [{ gueltigAb: 'quatsch', beginn: '99:99' }] })
    expect(tagesRegel()).toEqual([])
  })

  it('updateMandantTagesRegel schreibt nur bei Änderung und sortiert', () => {
    meldeAn(speicher, { tagesRegel: [] })
    const setItem = vi.spyOn(localStorage, 'setItem')

    updateMandantTagesRegel([])
    expect(setItem).not.toHaveBeenCalled()

    updateMandantTagesRegel([
      { gueltigAb: '2026-12-01', beginn: '00:00' },
      { gueltigAb: '2026-01-01', beginn: '06:00' },
    ])
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(tagesRegel()).toEqual([
      { gueltigAb: '2026-01-01', beginn: '06:00' },
      { gueltigAb: '2026-12-01', beginn: '00:00' },
    ])

    // gleicher Stand (andere Reihenfolge) → kein weiterer Schreibvorgang
    updateMandantTagesRegel([
      { gueltigAb: '2026-12-01', beginn: '00:00' },
      { gueltigAb: '2026-01-01', beginn: '06:00' },
    ])
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('updateMandantTagesRegel ohne Anmeldung tut nichts', () => {
    updateMandantTagesRegel([{ gueltigAb: '2026-01-01', beginn: '06:00' }])
    expect(speicher.size).toBe(0)
  })
})

describe('Kalender-Hilfen (rein kalendarisch, ohne Zeitzonen-Effekte)', () => {
  it('addTage über Monats-, Jahres- und Zeitumstellungsgrenzen', () => {
    expect(addTage('2026-03-28', 1)).toBe('2026-03-29')
    expect(addTage('2026-03-29', 1)).toBe('2026-03-30')
    expect(addTage('2026-10-25', -1)).toBe('2026-10-24')
    expect(addTage('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('montagDerWoche', () => {
    expect(montagDerWoche('2025-10-05')).toBe('2025-09-29')   // Sonntag
    expect(montagDerWoche('2025-10-06')).toBe('2025-10-06')   // Montag
    expect(montagDerWoche('2025-10-12')).toBe('2025-10-06')   // Sonntag
    expect(montagDerWoche('2026-01-01')).toBe('2025-12-29')   // Jahreswechsel
  })

  it('endeDesMonats inkl. Schaltjahr', () => {
    expect(endeDesMonats('2026-02-10')).toBe('2026-02-28')
    expect(endeDesMonats('2028-02-10')).toBe('2028-02-29')
    expect(endeDesMonats('2026-10-02')).toBe('2026-10-31')
    expect(endeDesMonats('2026-12-15')).toBe('2026-12-31')
  })

  it('Anzeige', () => {
    expect(datumKurz('2026-10-02')).toBe('02.10.2026')
    expect(tagMonat('2026-10-02')).toBe('02.10.')
  })
})
