/**
 * Signaturkarte (a.sign RK CHIP) über den APDU-Simulator: Kartentyp, Zertifikat, Signatur,
 * PIN-Schutz und Fehlerklassen. Der Echttest mit einer Karte läuft über ops/kartenbruecke.
 */

import { describe, it, expect } from 'vitest'
import { createHash, X509Certificate } from 'node:crypto'
import {
  APDU, KartenError, SignaturkartenEinheit, SimulierteSignaturkarte, SIMULATOR_ATR,
  erkenneKartentyp, findeKarte, klassifiziereSeeFehler, leseZertifikat, pinBlockFormat2,
  signiereMitKarte, generateSEE, verifiziere, verifiziereQrCode, erstelleStartbeleg,
  jwsSigningInput, p1363ZuDer, KartenbrueckeTransport,
} from '../src/index.js'
import { createVerify } from 'node:crypto'

const fehler = async (p: Promise<unknown>): Promise<KartenError> => {
  try { await p } catch (e) { if (e instanceof KartenError) return e; throw e }
  throw new Error('kein KartenError geworfen')
}

describe('Kartentyp am ATR', () => {
  it('ACOS-ID 4.1 ist zugelassen, ältere Generationen sind tauschpflichtig', () => {
    expect(erkenneKartentyp('3BDF97008131FE4680319052410464050401AC73D622C0F9')).toMatchObject({ bezeichnung: 'A-Trust ACOS-ID 4.1', pinReferenz: 0x8a, tauschpflichtig: false })
    expect(erkenneKartentyp('3bdf97008131fe4680319052410364050201ac73d622c0f8')).toMatchObject({ bezeichnung: 'A-Trust ACOS-ID 2.1', tauschpflichtig: true })
    expect(erkenneKartentyp('3BDF18008131FE588031B05202046405C903AC73B7B1D422')).toMatchObject({ pinReferenz: 0x81, tauschpflichtig: true })
  })

  it('andere Karten (Windows Hello, Bankkarte) sind keine Signaturkarte', () => {
    expect(erkenneKartentyp('3B8D0180FBA000000397425446590401CF')).toBeNull()
    expect(erkenneKartentyp('')).toBeNull()
  })
})

describe('PIN-Block Format 2', () => {
  it('6 Stellen: 26 12 34 56 FF FF FF FF', () => {
    expect(pinBlockFormat2('123456').toString('hex').toUpperCase()).toBe('26123456FFFFFFFF')
  })
  it('5 und 12 Stellen', () => {
    expect(pinBlockFormat2('12345').toString('hex').toUpperCase()).toBe('2512345FFFFFFFFF')
    expect(pinBlockFormat2('123456789012').toString('hex').toUpperCase()).toBe('2C123456789012FF')
  })
  it('keine Ziffern / zu kurz / zu lang → pin_fehlt, ohne Kartenzugriff', () => {
    for (const pin of ['', '123', '12a456', '1234567890123']) {
      expect(() => pinBlockFormat2(pin)).toThrow(KartenError)
    }
  })
})

describe('APDUs (wie im A-Trust-Beispielcode)', () => {
  it('Befehle byte-genau', () => {
    expect(APDU.selectMf.toString('hex')).toBe('00a4000c023f00')
    expect(APDU.selectDfSig.toString('hex')).toBe('00a4000c02df01')
    expect(APDU.selectEfZert.toString('hex')).toBe('00a4000c02c000')
    expect(APDU.leseBinaer(0x0300).toString('hex')).toBe('00b0030000')
    expect(APDU.verify(0x8a, pinBlockFormat2('123456')).toString('hex')).toBe('0020008a0826123456ffffffff')
    const hash = Buffer.alloc(32, 0xab)
    expect(APDU.signiere(hash).toString('hex')).toBe(`002a9e9a20${'ab'.repeat(32)}40`)
  })
})

describe('Simulierte Karte', () => {
  it('findet die Signaturkarte und übergeht andere Leser', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge({
      weitereLeser: [{ name: 'Windows Hello for Business 1', atr: '3B8D0180FBA000000397425446590401CF' }],
    })
    const gefunden = await findeKarte(karte)
    expect(gefunden).toMatchObject({ leser: karte.leserName, atr: SIMULATOR_ATR })
  })

  it('liest das ganze Zertifikat (mehrere 256-Byte-Blöcke) ohne PIN', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge()
    const zert = await leseZertifikat(karte, await findeKarte(karte))
    expect(zert.equals(karte.zertifikatDer)).toBe(true)
    expect(new X509Certificate(zert).publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(karte.pinPruefungen).toBe(0)
  })

  it('signiert: 64 Byte r‖s, die zum Zertifikat passen (ES256 über den JWS-Signing-Input)', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge()
    const input = jwsSigningInput('_R1-AT1_K1_1_2026-11-18T10:00:00_0,00_0,00_0,00_0,00_0,00_abc=_7B12CDA4_xyz=')
    const sig = await signiereMitKarte(karte, await findeKarte(karte), input, '123456')
    expect(sig).toHaveLength(64)
    expect(verifiziere(input, sig, karte.zertifikatDer)).toBe(true)
    // Gegenprobe ohne eigene Hilfsfunktion: Node prüft den Hash der Eingabe
    const v = createVerify('SHA256'); v.update(input, 'utf8')
    expect(v.verify(new X509Certificate(karte.zertifikatDer).publicKey, p1363ZuDer(sig))).toBe(true)
    expect(createHash('sha256').update(input).digest()).toHaveLength(32)
  })

  it('PIN falsch: bricht ab und meldet die Restversuche; die richtige PIN setzt den Zähler zurück', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge({ maxVersuche: 3 })
    const k = await findeKarte(karte)
    const e = await fehler(signiereMitKarte(karte, k, 'x.y', '654321'))
    expect(e).toMatchObject({ art: 'pin_falsch', restVersuche: 2 })
    expect(e.message).toMatch(/noch 2 Versuche/)
    expect(karte.signaturen).toBe(0)
    await signiereMitKarte(karte, k, 'x.y', '123456')
    expect(karte.restVersuche).toBe(3)
  })

  it('letzter Fehlversuch sperrt; danach 6983 auch mit der richtigen PIN', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge({ maxVersuche: 1 })
    const k = await findeKarte(karte)
    expect(await fehler(signiereMitKarte(karte, k, 'x.y', '000000'))).toMatchObject({ art: 'pin_gesperrt', restVersuche: 0 })
    expect(await fehler(signiereMitKarte(karte, k, 'x.y', '123456'))).toMatchObject({ art: 'pin_gesperrt' })
  })

  it('Signieren ohne PIN-Prüfung verweigert die Karte (6982)', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge()
    const k = await findeKarte(karte)
    const antworten = await karte.sende(k.leser, [APDU.selectMf, APDU.selectDfSig, APDU.signiere(Buffer.alloc(32))])
    expect(antworten[2]!.subarray(-2).toString('hex')).toBe('6982')
  })
})

describe('SignaturkartenEinheit', () => {
  it('Startbeleg mit der Karte: ZDA AT1, Seriennummer der Karte, Signatur besteht die Gegenprobe', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge()
    const einheit = new SignaturkartenEinheit({ transport: karte, pin: '123456', erwartetesZertifikat: karte.zertifikatDer })
    expect(await einheit.zdaId()).toBe('AT1')
    const zert = await einheit.zertifikat()
    expect(Buffer.from(zert.derBase64, 'base64').equals(karte.zertifikatDer)).toBe(true)

    const see = { ...(await generateSEE({ kassenId: 'K1', uid: 'ATU00000000', firmenname: 'T' })), zertifikatDER: karte.zertifikatDer, zdaId: 'AT1' }
    const { beleg } = await erstelleStartbeleg('K1', see, einheit)
    expect(beleg.maschinenlesbareCode).toMatch(/^_R1-AT1_K1_/)
    expect(verifiziereQrCode(beleg.maschinenlesbareCode, karte.zertifikatDer)).toBe(true)
    expect(karte.signaturen).toBe(1)
  })

  it('ohne PIN: kein Kartenzugriff, Fehlerklasse Konfiguration', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge()
    const e = await fehler(new SignaturkartenEinheit({ transport: karte }).signiereBelegzeile('_R1-AT1_K1'))
    expect(e.art).toBe('pin_fehlt')
    expect(klassifiziereSeeFehler(e)).toBe('konfiguration')
    expect(karte.pinPruefungen).toBe(0)
  })

  it('andere Karte gesteckt: Abbruch VOR der PIN-Prüfung (kein Fehlversuch auf der fremden Karte)', async () => {
    const eingerichtet = await SimulierteSignaturkarte.erzeuge()
    const andere = await SimulierteSignaturkarte.erzeuge({ pin: '999999' })
    const einheit = new SignaturkartenEinheit({ transport: andere, pin: '123456', erwartetesZertifikat: eingerichtet.zertifikatDer })
    const e = await fehler(einheit.signiereBelegzeile('_R1-AT1_K1'))
    expect(e.art).toBe('falsche_karte')
    expect(klassifiziereSeeFehler(e)).toBe('konfiguration')
    expect(andere.pinPruefungen).toBe(0)
  })

  it('Karte gezogen / Brücke weg → Ausfall (vorübergehend)', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge()
    const einheit = new SignaturkartenEinheit({ transport: karte, pin: '123456' })
    karte.gesteckt = false
    const gezogen = await fehler(einheit.signiereBelegzeile('_R1-AT1_K1'))
    expect(gezogen.art).toBe('keine_karte')
    expect(klassifiziereSeeFehler(gezogen)).toBe('ausfall')
    karte.gesteckt = true
    karte.erreichbar = false
    const weg = await fehler(einheit.signiereBelegzeile('_R1-AT1_K1'))
    expect(weg.art).toBe('nicht_erreichbar')
    expect(klassifiziereSeeFehler(weg)).toBe('ausfall')
  })

  it('PIN falsch und gesperrt → Konfiguration (kein stilles Weiterlaufen im Ausfallmodus)', async () => {
    const karte = await SimulierteSignaturkarte.erzeuge()
    const e = await fehler(new SignaturkartenEinheit({ transport: karte, pin: '111111' }).signiereBelegzeile('_R1-AT1_K1'))
    expect(klassifiziereSeeFehler(e)).toBe('konfiguration')
    expect(klassifiziereSeeFehler(new KartenError('x', 'pin_gesperrt', 0))).toBe('konfiguration')
    expect(klassifiziereSeeFehler(new KartenError('x', 'zugang_abgewiesen'))).toBe('konfiguration')
  })
})

describe('KartenbrueckeTransport', () => {
  it('nicht erreichbare Brücke → nicht_erreichbar (Ausfall), nach Zeitlimit', async () => {
    const t = new KartenbrueckeTransport({ url: 'http://127.0.0.1:9', schluessel: 'x', timeoutMs: 1_000 })
    const e = await fehler(t.leser())
    expect(e.art).toBe('nicht_erreichbar')
  })
})
