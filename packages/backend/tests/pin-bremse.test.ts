/**
 * Unit-Tests der PIN-Bremse (reine Logik, Uhr austauschbar — kein Warten).
 *
 * Kernpunkte: Sperre ab dem 8. Fehlversuch mit steigender Dauer, Abbau eines
 * Fehlversuchs je Intervall, Erfolg zählt nicht und setzt nicht zurück, und
 * gleichzeitige Anfragen bekommen nicht mehr Versuche als erlaubt.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  PinBremse,
  PIN_BREMSE_REGELN,
  PIN_SPERR_STUFEN_MS,
  toepfeFuerFreigabe,
  toepfeFuerGeraet,
  type Topf,
} from '../src/services/pin-bremse.js'

const MIN = 60_000
const KASSE_A: Topf = { art: 'kasse', id: 'kasse-a' }
const KASSE_B: Topf = { art: 'kasse', id: 'kasse-b' }
const MANDANT: Topf = { art: 'mandant', id: 'm1' }

describe('PinBremse', () => {
  let uhr: number
  let bremse: PinBremse

  beforeEach(() => {
    uhr = 1_800_000_000_000
    bremse = new PinBremse(() => uhr)
  })

  /** Ein Versuch, der fehlschlägt; liefert die ausgelösten Sperren (oder wirft, falls gesperrt). */
  function fehlversuch(toepfe: Topf[]) {
    const start = bremse.beginne(toepfe)
    if (!start.ok) throw new Error(`gesperrt (${start.wartenMs} ms)`)
    return start.versuch.fehlschlag()
  }

  it('sperrt erst beim 8. Fehlversuch — dann 30 s lang, auch für richtige PINs', () => {
    for (let i = 1; i <= 7; i++) expect(fehlversuch([KASSE_A])).toEqual([])
    const sperren = fehlversuch([KASSE_A])
    expect(sperren).toHaveLength(1)
    expect(sperren[0]).toMatchObject({ topf: KASSE_A, fehlversuche: 8, dauerMs: 30_000 })

    // Während der Sperre wird gar nicht geprüft — auch ein Erfolg käme nicht dran
    const gesperrt = bremse.beginne([KASSE_A])
    expect(gesperrt).toEqual({ ok: false, wartenMs: 30_000 })

    uhr += 29_999
    expect(bremse.beginne([KASSE_A]).ok).toBe(false)
    uhr += 1
    expect(bremse.beginne([KASSE_A]).ok).toBe(true)
  })

  it('jeder weitere Fehlversuch sperrt eine Stufe länger — bis 15 min, dann bleibt es dabei', () => {
    for (let i = 0; i < 8; i++) fehlversuch([KASSE_A])
    const dauern: number[] = [30_000]
    for (let i = 0; i < 8; i++) {
      uhr += dauern.at(-1)!          // Sperre abwarten, sofort weiterraten
      const [s] = fehlversuch([KASSE_A])
      dauern.push(s!.dauerMs)
    }
    // Der Abbau ruht während der Sperren — sonst pendelte es sich bei 10 min ein
    expect(dauern).toEqual([30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 15 * MIN, 15 * MIN, 15 * MIN])
    expect(PIN_SPERR_STUFEN_MS.at(-1)).toBe(15 * MIN)
  })

  it('nach einem Dauerangriff ist der Topf spätestens nach einer Stunde wieder frei', () => {
    for (let i = 0; i < 8; i++) fehlversuch([KASSE_A])
    let bis = bremse.stand(KASSE_A).gesperrtBis
    for (let i = 0; i < 20; i++) {    // stundenlang weiterraten
      uhr = bis
      fehlversuch([KASSE_A])
      bis = bremse.stand(KASSE_A).gesperrtBis
    }
    expect(bremse.stand(KASSE_A).fehlversuche).toBe(13)   // gedeckelt
    uhr = bis + 60 * MIN
    expect(bremse.stand(KASSE_A).fehlversuche).toBe(7)    // wieder unter der Grenze
    expect(fehlversuch([KASSE_A])).toHaveLength(1)        // nächster Tippfehler: kurze Sperre …
    expect(bremse.stand(KASSE_A).gesperrtBis - uhr).toBe(30_000) // … nur Stufe 1
  })

  it('alle 10 Minuten wird ein Fehlversuch vergessen — verteilte Tippfehler sperren nie', () => {
    // Ein Tippfehler alle 10 Minuten, einen ganzen Abend lang
    for (let i = 0; i < 60; i++) {
      expect(fehlversuch([KASSE_A])).toEqual([])
      uhr += PIN_BREMSE_REGELN.kasse.abbauMs
    }
    expect(bremse.stand(KASSE_A).fehlversuche).toBeLessThanOrEqual(1)
  })

  it('der Abbau läuft stückweise: nach 7 Fehlversuchen und 25 min stehen noch 5', () => {
    for (let i = 0; i < 7; i++) fehlversuch([KASSE_A])
    uhr += 25 * MIN
    expect(bremse.stand(KASSE_A).fehlversuche).toBe(5)
  })

  it('Erfolg zählt nicht und setzt nicht zurück (sonst leert die eigene PIN den Zähler)', () => {
    for (let i = 0; i < 7; i++) fehlversuch([KASSE_A])
    const start = bremse.beginne([KASSE_A])
    if (!start.ok) throw new Error('unerwartet gesperrt')
    start.versuch.erfolg()
    expect(bremse.stand(KASSE_A).fehlversuche).toBe(7)
    // der nächste Fehlversuch ist der 8. → Sperre
    expect(fehlversuch([KASSE_A])).toHaveLength(1)
  })

  it('abgebrochene Prüfung (z. B. DB-Fehler) zählt nicht und gibt die Buchung frei', () => {
    const start = bremse.beginne([KASSE_A])
    if (!start.ok) throw new Error('unerwartet gesperrt')
    start.versuch.abbrechen()
    expect(bremse.stand(KASSE_A)).toMatchObject({ fehlversuche: 0, laufend: 0 })
  })

  it('ein Versuch zählt nur einmal, auch wenn er doppelt beendet wird', () => {
    const start = bremse.beginne([KASSE_A])
    if (!start.ok) throw new Error('unerwartet gesperrt')
    start.versuch.fehlschlag()
    start.versuch.fehlschlag()
    start.versuch.erfolg()
    expect(bremse.stand(KASSE_A)).toMatchObject({ fehlversuche: 1, laufend: 0 })
  })

  it('gleichzeitige Anfragen bekommen nicht mehr Versuche, als bis zur Sperre übrig sind', () => {
    // 8 parallel sind erlaubt (Stand 0) — der 9. muss auf deren Ergebnis warten
    const laufend = Array.from({ length: 8 }, () => bremse.beginne([KASSE_A]))
    expect(laufend.every(s => s.ok)).toBe(true)
    const neunter = bremse.beginne([KASSE_A])
    expect(neunter.ok).toBe(false)

    // Alle 8 falsch → Sperre; danach genau EIN Versuch je Sperrablauf
    for (const s of laufend) if (s.ok) s.versuch.fehlschlag()
    uhr += 30_000
    const erster = bremse.beginne([KASSE_A])
    expect(erster.ok).toBe(true)
    expect(bremse.beginne([KASSE_A]).ok).toBe(false)   // zweiter paralleler: warten
    if (erster.ok) erster.versuch.erfolg()
    expect(bremse.beginne([KASSE_A]).ok).toBe(true)    // nach dem Ergebnis wieder frei
  })

  it('Kassen sind getrennt — eine gesperrte Kasse hält die andere nicht auf', () => {
    for (let i = 0; i < 8; i++) fehlversuch([KASSE_A])
    expect(bremse.beginne([KASSE_A]).ok).toBe(false)
    expect(bremse.beginne([KASSE_B]).ok).toBe(true)
  })

  it('der Mandanten-Topf sperrt alle Kassen, sobald 20 Fehlversuche zusammenkommen', () => {
    const toepfeA = [KASSE_A, MANDANT]
    const toepfeB = [KASSE_B, MANDANT]
    const kasseC: Topf[] = [{ art: 'kasse', id: 'kasse-c' }, MANDANT]
    for (let i = 0; i < 7; i++) fehlversuch(toepfeA)
    for (let i = 0; i < 7; i++) fehlversuch(toepfeB)
    for (let i = 0; i < 5; i++) fehlversuch(kasseC)
    const sperren = fehlversuch(kasseC)            // 20. im Mandanten
    expect(sperren.map(s => s.topf.art)).toEqual(['mandant'])
    expect(bremse.beginne(toepfeA).ok).toBe(false)  // Kasse A selbst ist nicht gesperrt …
    expect(bremse.stand(KASSE_A).gesperrtBis).toBe(0) // … aber der Mandant
  })

  it('Mandanten-Topf baut schneller ab (1 je 5 min)', () => {
    for (let i = 0; i < 10; i++) fehlversuch([MANDANT])
    uhr += 25 * MIN
    expect(bremse.stand(MANDANT).fehlversuche).toBe(5)
  })

  it('zuruecksetzen vergisst alles', () => {
    for (let i = 0; i < 8; i++) fehlversuch([KASSE_A])
    bremse.zuruecksetzen()
    expect(bremse.beginne([KASSE_A]).ok).toBe(true)
  })
})

describe('Töpfe', () => {
  it('fremdes Gerät: Kasse + Mandant; vertrautes Gerät: Gerät + Vertraut-Topf', () => {
    expect(toepfeFuerGeraet('m1', 'k1', null)).toEqual([
      { art: 'kasse', id: 'k1' }, { art: 'mandant', id: 'm1' },
    ])
    expect(toepfeFuerGeraet('m1', 'k1', { geraetId: 'g1', mandantId: 'm1' })).toEqual([
      { art: 'geraet', id: 'g1' }, { art: 'vertraut', id: 'm1' },
    ])
  })

  it('Freigabe: je Benutzer + Vertraut-Topf; ohne Anfrager nur der Vertraut-Topf', () => {
    expect(toepfeFuerFreigabe('m1', 'u1')).toEqual([
      { art: 'benutzer', id: 'u1' }, { art: 'vertraut', id: 'm1' },
    ])
    expect(toepfeFuerFreigabe('m1', null)).toEqual([{ art: 'vertraut', id: 'm1' }])
  })
})
