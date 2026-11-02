/**
 * Steuersatz 4,9 % (ausgewählte Nahrungsmittel, seit 1.7.2026).
 *
 * Rechtsgrundlage: RKSV Anlage 1 Z 4, geändert durch BGBl. II Nr. 134/2026 (in Kraft 1.7.2026):
 * „Betrag-Satz-Besonders (19 %, 4,9 %)". Der maschinenlesbare Code hat weiterhin FÜNF Betragsfelder;
 * der Satz 4,9 % teilt sich das Feld „Besonders" mit dem 19-%-Satz. Die Kassa rechnet und berichtet
 * getrennt (`ermaessigt3`) und fasst erst im Code (und damit im DEP) zusammen.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { generateSEE } from '../src/see.js'
import {
  berechneBetraege,
  erstelleStartbeleg,
  gesamtBetragCent,
  pruefeBelegSignatur,
  qrCodeZuJwsCompact,
  signiereBeleg,
  verifiziereQrCode,
  type VerifizierbarerBeleg,
} from '../src/beleg.js'
import { erstelleDEP131Export } from '../src/dep.js'
import { entschluesselUmsatzzaehler } from '../src/crypto/aes-icm.js'
import { MWST_PROZENT } from '../src/types.js'
import type { BelegPosition, MwStSatz, RawBeleg, SEEConfig, SignedBeleg } from '../src/types.js'

let see: SEEConfig

beforeAll(async () => {
  see = await generateSEE({ kassenId: 'S49-KASSE-1', uid: 'ATU12345678', firmenname: 'Satz 4,9 GmbH' })
})

const pos = (mwstSatz: MwStSatz, einzelpreisBreutto: number, menge = 1): BelegPosition =>
  ({ bezeichnung: 'Ware', menge, einzelpreisBreutto, mwstSatz })

async function signiere(positionen: BelegPosition[], belegTyp: RawBeleg['belegTyp'] = 'Barzahlungsbeleg') {
  const { kontext } = await erstelleStartbeleg('S49-KASSE-1', see)
  const beleg = await signiereBeleg({
    kassenId: 'S49-KASSE-1', belegNummer: 2, datumUhrzeit: new Date('2026-07-01T10:00:00Z'), belegTyp, positionen,
  }, kontext)
  return { beleg, kontext }
}

/** Die fünf Betragsfelder des Codes: Normal, Ermäßigt-1, Ermäßigt-2, Null, Besonders. */
function betragsFelder(code: string): string[] {
  const teile = code.split('_')
  expect(teile).toHaveLength(14)
  return teile.slice(5, 10)
}

describe('Satz 4,9 % — Rechnen', () => {
  it('der Satz heißt ermaessigt3 und rechnet mit 4,9', () => {
    expect(MWST_PROZENT.ermaessigt3).toBe(4.9)
    expect(MWST_PROZENT.besonders).toBe(19)
  })

  it('Positionen mit 4,9 % landen in ermaessigt3 — nicht in besonders, nicht in ermaessigt1', () => {
    const b = berechneBetraege([pos('ermaessigt3', 60, 3), pos('besonders', 777), pos('ermaessigt1', 350)])
    expect(b).toEqual({ normal: 0, ermaessigt1: 350, ermaessigt2: 0, ermaessigt3: 180, null: 0, besonders: 777 })
  })

  it('gesamtBetragCent zählt den Satz 4,9 % mit (Umsatzzähler)', () => {
    const b = berechneBetraege([pos('ermaessigt3', 60, 3), pos('normal', 100)])
    expect(gesamtBetragCent(b)).toBe(280n)
  })
})

describe('Satz 4,9 % — QR-Code und DEP (Betrag-Satz-Besonders)', () => {
  it('nur 4,9 %: der Betrag steht im Feld „Besonders", alle anderen Felder 0,00', async () => {
    const { beleg } = await signiere([pos('ermaessigt3', 60, 3)])
    expect(betragsFelder(beleg.maschinenlesbareCode)).toEqual(['0,00', '0,00', '0,00', '0,00', '1,80'])
    expect(beleg.betraege.ermaessigt3).toBe(180)      // intern getrennt …
    expect(beleg.betraege.besonders).toBe(0)
    expect(verifiziereQrCode(beleg.maschinenlesbareCode, see.zertifikatDER)).toBe(true)
  })

  it('19 % und 4,9 % in einem Beleg: ein Feld mit der SUMME, intern getrennt', async () => {
    const { beleg } = await signiere([pos('besonders', 777), pos('ermaessigt3', 389), pos('normal', 1000)])
    expect(betragsFelder(beleg.maschinenlesbareCode)).toEqual(['10,00', '0,00', '0,00', '0,00', '11,66'])
    expect(beleg.betraege).toMatchObject({ besonders: 777, ermaessigt3: 389, normal: 1000 })
  })

  it('der Code hat weiterhin genau 14 Teile (kein neues Feld, kein neuer Trenner)', async () => {
    const { beleg } = await signiere([pos('ermaessigt3', 123), pos('besonders', 456), pos('null', 99)])
    expect(beleg.maschinenlesbareCode.split('_')).toHaveLength(14)
    expect(beleg.maschinenlesbareCode).toMatch(/^_R1-AT0_S49-KASSE-1_2_2026-07-01T12:00:00_/)
  })

  it('der Umsatzzähler enthält den Satz 4,9 % (Summe aller Sätze)', async () => {
    const { beleg } = await signiere([pos('ermaessigt3', 389), pos('besonders', 777), pos('normal', 100)])
    const klar = entschluesselUmsatzzaehler(Buffer.from(beleg.umsatzzaehlerVerschluesselt, 'base64'), see.aesSchluessel, see.kassenId, 2)
    expect(klar).toBe(389n + 777n + 100n)
  })

  it('Storno eines gemischten Belegs: negative Summe im Feld „Besonders"', async () => {
    const { beleg } = await signiere([pos('besonders', -777), pos('ermaessigt3', -389)], 'Stornobeleg')
    expect(betragsFelder(beleg.maschinenlesbareCode)[4]).toBe('-11,66')
    expect(beleg.betraege).toMatchObject({ besonders: -777, ermaessigt3: -389 })
  })

  it('DEP7: der JWS trägt die Summe im Feld „Besonders" — der Satz 4,9 % ist von außen nicht zu unterscheiden', async () => {
    const { beleg } = await signiere([pos('ermaessigt3', 60, 3), pos('besonders', 20)])
    const jws = qrCodeZuJwsCompact(beleg.maschinenlesbareCode)
    const payload = Buffer.from(jws.split('.')[1]!, 'base64url').toString('utf8')
    expect(payload.split('_')[9]).toBe('2,00')
    expect(payload).toBe(beleg.maschinenlesbareCode.slice(0, beleg.maschinenlesbareCode.lastIndexOf('_')))
  })

  it('DEP131 (§ 131 BAO) führt beide Sätze GETRENNT', async () => {
    const { beleg } = await signiere([pos('ermaessigt3', 60, 3), pos('besonders', 20)])
    const dep = erstelleDEP131Export([{
      belegNummer: beleg.belegNummer, datumUhrzeit: beleg.datumUhrzeit, belegTyp: beleg.belegTyp,
      positionen: beleg.positionen, betraege: beleg.betraege, zahlung: { barCent: 200, karteCent: 0, sonstigeCent: 0 },
      maschinenlesbareCode: beleg.maschinenlesbareCode, signaturwert: beleg.signaturwert,
      umsatzzaehlerVerschluesselt: beleg.umsatzzaehlerVerschluesselt, zertifikatSN: beleg.zertifikatSN, sigVorbeleg: beleg.sigVorbeleg,
    }], 'S49-KASSE-1')
    expect(dep.Belege[0]!.Betraege).toMatchObject({ Ermaessigt3Cent: 180, BesondersCent: 20 })
    expect(dep.Belege[0]!.Positionen.map(p => p.MwStSatz)).toEqual(['ermaessigt3', 'besonders'])
  })

  it('Eigenschaft: für beliebige Positionen == Summe aus 19 % und 4,9 % im Code-Feld, alle fünf Felder zusammen == Beleg-Summe', async () => {
    const saetze = Object.keys(MWST_PROZENT) as MwStSatz[]
    let zustand = 12345
    const zufall = () => { zustand = (zustand * 1103515245 + 12345) & 0x7fffffff; return zustand / 0x7fffffff }
    for (let i = 0; i < 60; i++) {
      const positionen = Array.from({ length: 1 + Math.floor(zufall() * 6) }, () =>
        pos(saetze[Math.floor(zufall() * saetze.length)]!, Math.floor(zufall() * 5000), 1 + Math.floor(zufall() * 5)))
      const { beleg } = await signiere(positionen)
      const felder = betragsFelder(beleg.maschinenlesbareCode)
      const cent = (t: string) => Math.round(parseFloat(t.replace(',', '.')) * 100)
      expect(cent(felder[4]!), `Durchlauf ${i}`).toBe(beleg.betraege.besonders + beleg.betraege.ermaessigt3)
      expect(felder.reduce((s, f) => s + cent(f), 0), `Durchlauf ${i}`)
        .toBe(positionen.reduce((s, p) => s + Math.round(p.menge * p.einzelpreisBreutto), 0))
    }
  })
})

describe('Satz 4,9 % — Prüfung gespeicherter Belege', () => {
  const alsVerifizierbar = (b: SignedBeleg): VerifizierbarerBeleg => ({
    zdaId: see.zdaId, kassenId: b.kassenId, belegNummer: b.belegNummer, datumUhrzeit: b.datumUhrzeit, betraege: b.betraege,
    umsatzzaehlerVerschluesselt: b.umsatzzaehlerVerschluesselt, zertifikatSN: b.zertifikatSN, sigVorbeleg: b.sigVorbeleg,
    signaturwert: b.signaturwert, maschinenlesbareCode: b.maschinenlesbareCode,
  })

  it('ein Beleg mit 4,9 % und 19 % verifiziert aus den getrennt gespeicherten Beträgen', async () => {
    const { beleg } = await signiere([pos('besonders', 777), pos('ermaessigt3', 389)])
    expect(pruefeBelegSignatur(alsVerifizierbar(beleg), see.zertifikatDER)).toBe('gueltig')
  })

  it('ein gesenkter 4,9-%-Betrag wird erkannt (die Summe im Code ändert sich)', async () => {
    const { beleg } = await signiere([pos('ermaessigt3', 389), pos('normal', 100)])
    const gesenkt = { ...alsVerifizierbar(beleg), betraege: { ...beleg.betraege, ermaessigt3: 100 } }
    expect(pruefeBelegSignatur(gesenkt, see.zertifikatDER)).toBe('ungueltig')
  })

  it('Belege aus der Zeit vor dem Satz 4,9 % (Beträge ohne das Feld) verifizieren unverändert', async () => {
    const { beleg } = await signiere([pos('normal', 100), pos('besonders', 50)])
    const alt = alsVerifizierbar(beleg)
    const ohneFeld = { ...alt, betraege: { normal: 100, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 50 } as unknown as VerifizierbarerBeleg['betraege'] }
    expect(pruefeBelegSignatur(ohneFeld, see.zertifikatDER)).toBe('gueltig')
  })

  it('Hinweis zur Auslegung: Die Signatur deckt nur die SUMME aus 19 % und 4,9 % — die Aufteilung zwischen beiden ist kryptographisch nicht geschützt', async () => {
    // Das folgt aus der Vorgabe der RKSV (ein Feld für beide Sätze) und ist kein Fehler der Kassa: Die BMF-Auskunft
    // verweist für die Umsatzsteuer deshalb auf die Tages-/Monatsabschlüsse (§ 131 BAO), nicht auf das RKSV-Protokoll.
    const { beleg } = await signiere([pos('besonders', 777), pos('ermaessigt3', 389)])
    const umgebucht = { ...alsVerifizierbar(beleg), betraege: { ...beleg.betraege, besonders: 777 + 389, ermaessigt3: 0 } }
    expect(pruefeBelegSignatur(umgebucht, see.zertifikatDER)).toBe('gueltig')
  })
})
