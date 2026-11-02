/**
 * Maschinenlesbarer Code im Einzelnen: jedes Feld mit festen Erwartungswerten.
 *
 * Anlass (Mutationstest, siehe PRUEFSTRECKE.md): Die schnelle Suite prüfte den Code nur auf Präfix, Signatur und Kette —
 * das Format der Beträge (Dezimalkomma, Vorzeichen bei Stornos, führende Nullen der Cent) konnte sich unbemerkt ändern.
 * Die Erwartungen folgen RKSV Anlage 1 Z 4 und dem Muster der BMF-Beispieldaten (z. B. `120,34`, `-37,11`, `0,00`).
 *
 * Bewusst NICHT geprüft: der genaue Wert von Datum/Uhrzeit (hängt an der Zeitzone, siehe zeit-matrix.test.ts) — nur das Format.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { berechneIV } from '../src/crypto/aes-icm.js'
import {
  Umsatzzaehler, erstelleNullbeleg, signiereBeleg, verifiziereBelegSignatur, verifiziereBelegSignaturAltDer,
  type SignierungsKontext,
} from '../src/beleg.js'
import { generateSEE, p1363ZuDer, zertifikatSN } from '../src/see.js'
import type { BelegPosition, BelegTyp, MwStSatz, SEEConfig, SignedBeleg } from '../src/types.js'
import { zerlegeQr } from './helpers/pruef-export.js'

const KASSE = 'FELDER-1'
let see: SEEConfig

beforeAll(async () => { see = await generateSEE({ kassenId: KASSE, uid: 'ATU12345678', firmenname: 'Felder GmbH' }) })

const pos = (preisCent: number, mwstSatz: MwStSatz, menge = 1): BelegPosition => ({ bezeichnung: 'Ware', menge, einzelpreisBreutto: preisCent, mwstSatz })

async function signiere(positionen: BelegPosition[], belegTyp: BelegTyp = 'Barzahlungsbeleg', kontext?: SignierungsKontext, nr = 2) {
  const k = kontext ?? { see, umsatzzaehler: new Umsatzzaehler(0n) }
  const beleg = await signiereBeleg({ kassenId: KASSE, belegNummer: nr, datumUhrzeit: new Date(2026, 5, 15, 10, 30, 45), belegTyp, positionen }, k)
  return { beleg, k, felder: zerlegeQr(beleg.maschinenlesbareCode) }
}

/** Zähler aus dem Beleg entschlüsseln (8 Byte, Zweierkomplement) — unabhängig von entschluesselUmsatzzaehler() */
function zaehlerVon(beleg: SignedBeleg): bigint {
  const klar = createDecipheriv('aes-256-ctr', see.aesSchluessel, berechneIV(KASSE, beleg.belegNummer)).update(Buffer.from(beleg.umsatzzaehlerVerschluesselt, 'base64'))
  return klar.readBigInt64BE(0)
}

describe('Beträge im Code', () => {
  it('fünf Felder in der Reihenfolge Normal, Ermäßigt 1, Ermäßigt 2, Null, Besonders', async () => {
    const { felder } = await signiere([pos(1050, 'normal'), pos(300, 'ermaessigt1'), pos(13, 'ermaessigt2'), pos(0, 'null'), pos(-5, 'besonders')])
    expect(felder.betraege).toEqual(['10,50', '3,00', '0,13', '0,00', '-0,05'])
  })

  it.each([
    [0,       '0,00'],
    [1,       '0,01'],
    [5,       '0,05'],
    [99,      '0,99'],
    [100,     '1,00'],
    [1050,    '10,50'],
    [123456,  '1234,56'],
    [-1,      '-0,01'],
    [-99,     '-0,99'],
    [-100,    '-1,00'],
    [-12345,  '-123,45'],
  ])('%i Cent erscheinen als %s', async (cent, text) => {
    const { felder } = await signiere([pos(cent, 'normal')])
    expect(felder.betraege[0]).toBe(text)
    expect(felder.betraege.slice(1)).toEqual(['0,00', '0,00', '0,00', '0,00'])
  })

  it('Rundung: 1,5 × 3,33 € = 4,995 € → 5,00 €, der Storno −5,00 € (Betrag und Vorzeichen im Code)', async () => {
    const original = await signiere([pos(333, 'normal', 1.5)])
    const storno = await signiere([pos(-333, 'normal', 1.5)], 'Stornobeleg')
    expect(original.felder.betraege[0]).toBe('5,00')
    expect(storno.felder.betraege[0]).toBe('-5,00')
  })

  it('mehrere Positionen desselben Satzes werden je Position gerundet und addiert', async () => {
    const { felder } = await signiere([pos(333, 'normal', 1.5), pos(333, 'normal', 1.5), pos(1, 'normal', 0.4)])
    expect(felder.betraege[0]).toBe('10,00')            // 5,00 + 5,00 + 0,00 (0,4 Cent → 0)
  })
})

describe('übrige Felder', () => {
  it('Suite/ZDA, Kassen-ID, Belegnummer, Zeitformat, 14 Teile', async () => {
    const { felder, beleg } = await signiere([pos(100, 'normal')], 'Barzahlungsbeleg', undefined, 7)
    expect(beleg.maschinenlesbareCode.split('_')).toHaveLength(14)
    expect(felder.suite).toBe('R1-AT0')
    expect(felder.kassenId).toBe(KASSE)
    expect(felder.belegNummer).toBe('7')
    expect(felder.datum).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  })

  it('Zertifikat-Seriennummer im Code = Seriennummer des Zertifikats (hexadezimal)', async () => {
    const { felder } = await signiere([pos(100, 'normal')])
    expect(felder.seriennummer).toBe(zertifikatSN(see.zertifikatDER))
  })

  it('Signatur: 64 Byte (r‖s) in Standard-Base64, entspricht signaturwert', async () => {
    const { felder, beleg } = await signiere([pos(100, 'normal')])
    expect(Buffer.from(felder.signatur, 'base64')).toHaveLength(64)
    expect(felder.signatur).toBe(beleg.signaturwert)
  })

  it('Umsatzzähler im Code = laufende Summe (mit Storno), 8 Byte Zweierkomplement', async () => {
    const k: SignierungsKontext = { see, umsatzzaehler: new Umsatzzaehler(0n) }
    const a = await signiere([pos(1050, 'normal'), pos(300, 'ermaessigt1')], 'Barzahlungsbeleg', k, 2)
    expect(zaehlerVon(a.beleg)).toBe(1350n)
    const b = await signiere([pos(-500, 'normal')], 'Stornobeleg', k, 3)
    expect(zaehlerVon(b.beleg)).toBe(850n)
    const c = await signiere([pos(-2000, 'normal')], 'Stornobeleg', k, 4)
    expect(zaehlerVon(c.beleg)).toBe(-1150n)                       // darf negativ werden
    expect(Buffer.from(c.felder.zaehler, 'base64')).toHaveLength(8)
  })

  it('der Zähler ändert sich nur bei Bar- und Stornobelegen', async () => {
    const k: SignierungsKontext = { see, umsatzzaehler: new Umsatzzaehler(0n) }
    await signiere([pos(1000, 'normal')], 'Barzahlungsbeleg', k, 2)
    for (const [typ, nr] of [['Nullbeleg', 3], ['Monatsbeleg', 4], ['Jahresbeleg', 5], ['Startbeleg', 6], ['Schlussbeleg', 7], ['Trainingsbeleg', 8]] as const) {
      const r = await signiere(typ === 'Trainingsbeleg' ? [pos(777, 'normal')] : [], typ, k, nr)
      expect(zaehlerVon(r.beleg), typ).toBe(1000n)
    }
  })
})

describe('Nullbeleg und Umsatzzähler-Hilfen', () => {
  it('erstelleNullbeleg: alle Beträge 0,00, Zähler unverändert, Kontext wandert zum neuen Beleg', async () => {
    const k: SignierungsKontext = { see, umsatzzaehler: new Umsatzzaehler(0n) }
    await signiere([pos(2500, 'normal')], 'Barzahlungsbeleg', k, 2)
    const beleg = await erstelleNullbeleg(KASSE, 3, k)
    expect(beleg.belegTyp).toBe('Nullbeleg')
    expect(beleg.positionen).toEqual([])
    expect(zerlegeQr(beleg.maschinenlesbareCode).betraege).toEqual(['0,00', '0,00', '0,00', '0,00', '0,00'])
    expect(zaehlerVon(beleg)).toBe(2500n)
    expect(k.letzterBelegCode).toBe(beleg.maschinenlesbareCode)
  })

  it('Umsatzzaehler: setze, addiere (auch negativ), aktuell, toJSON', () => {
    const z = new Umsatzzaehler()
    expect(z.aktuell).toBe(0n)
    z.setze(5n)
    expect(z.aktuell).toBe(5n)
    expect(z.addiere(-8n)).toBe(-3n)
    expect(z.toJSON()).toBe('-3')
  })
})

describe('Alt-Format (DER) vor dem P1363-Fix', () => {
  async function verifizierbar(signaturwert: string, beleg: SignedBeleg, datum: Date) {
    return {
      zdaId: see.zdaId, kassenId: KASSE, belegNummer: beleg.belegNummer, datumUhrzeit: datum, betraege: beleg.betraege,
      umsatzzaehlerVerschluesselt: beleg.umsatzzaehlerVerschluesselt, zertifikatSN: beleg.zertifikatSN, sigVorbeleg: beleg.sigVorbeleg, signaturwert,
    }
  }

  it('P1363 wird vom Normalprüfer akzeptiert, DER nur vom Alt-Prüfer — und umgekehrt nicht', async () => {
    const { beleg } = await signiere([pos(1234, 'normal')])
    const neu = await verifizierbar(beleg.signaturwert, beleg, beleg.datumUhrzeit)
    const alt = await verifizierbar(p1363ZuDer(Buffer.from(beleg.signaturwert, 'base64')).toString('base64'), beleg, beleg.datumUhrzeit)

    expect(verifiziereBelegSignatur(neu, see.zertifikatDER)).toBe(true)
    expect(verifiziereBelegSignaturAltDer(neu, see.zertifikatDER)).toBe(false)
    expect(verifiziereBelegSignatur(alt, see.zertifikatDER)).toBe(false)
    expect(verifiziereBelegSignaturAltDer(alt, see.zertifikatDER)).toBe(true)
  })

  it('ein verändertes Feld bricht auch die Alt-Prüfung', async () => {
    const { beleg } = await signiere([pos(1234, 'normal')])
    const alt = await verifizierbar(p1363ZuDer(Buffer.from(beleg.signaturwert, 'base64')).toString('base64'), beleg, beleg.datumUhrzeit)
    expect(verifiziereBelegSignaturAltDer({ ...alt, betraege: { ...alt.betraege, normal: alt.betraege.normal + 1 } }, see.zertifikatDER)).toBe(false)
  })
})

describe('Konstanten', () => {
  it('Verkettungswert des Startbelegs = Hash der Kassen-ID (Referenz: BMF-Mustercode `cg8hNU5ihto=` für CASHBOX-DEMO-1)', () => {
    expect(createHash('sha256').update('CASHBOX-DEMO-1').digest().subarray(0, 8).toString('base64')).toBe('cg8hNU5ihto=')
  })
})
