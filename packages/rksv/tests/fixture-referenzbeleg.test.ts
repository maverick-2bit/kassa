/**
 * Fixture-Test gegen einen ECHTEN Referenz-Beleg aus dem BMF-Mustercode
 * (GlobalTrust-Demo, RK-Suite R1-AT2; Quelle: BMF-RKSV-Technik Issue #385).
 *
 * Beweist, dass unser Code-Verständnis (Feldreihenfolge, Kodierungen) mit
 * real existierenden RKSV-Belegen übereinstimmt — die Signatur selbst kann
 * ohne das GlobalTrust-Zertifikat nicht geprüft werden, wohl aber Struktur,
 * Encodings und die JWS-Umrechnung.
 */

import { describe, it, expect } from 'vitest'
import { qrCodeZuJwsCompact, JWS_HEADER_B64URL } from '../src/beleg.js'

const REFERENZ_BELEG =
  '_R1-AT2_CASHBOX-DEMO-1_CASHBOX-DEMO-1-Receipt-ID-1_2016-03-11T03:57:08_0,00_0,00_0,00_0,00_0,00_4BMxCg==_011388844D20A02C087A4BE257_cg8hNU5ihto=_RFvjH0H5TKIxkgl3D/j90CIFcDrCDmRyrsW5ayeSPEidLLuca5v1S3yB4zWoKXSKUKY6JkfUx6zd8KUMFx86Ew=='

describe('Referenz-Beleg (BMF-Mustercode, R1-AT2)', () => {
  const felder = REFERENZ_BELEG.split('_').slice(1) // führendes '_' → leeres erstes Element

  it('hat 13 Felder in Spec-Reihenfolge', () => {
    expect(felder).toHaveLength(13)
    expect(felder[0]).toBe('R1-AT2')                      // Suite + ZDA
    expect(felder[1]).toBe('CASHBOX-DEMO-1')              // Kassen-ID
    expect(felder[3]).toBe('2016-03-11T03:57:08')         // ISO-Datum ohne Zeitzone
    expect(felder[4]).toBe('0,00')                        // Beträge mit Komma
  })

  it('verschlüsselter Umsatzzähler: Standard-Base64, variable Byte-Länge', () => {
    // Die Spec verlangt MINDESTENS 5 Byte (Länge variabel; wir verwenden fix 8).
    // Dieser historische Demo-Beleg trägt 4 Byte — er stammt aus einem
    // Prüf-Fehler-Issue und dient hier nur als Encoding-/Struktur-Referenz.
    const enc = felder[9]!
    expect(enc).toBe('4BMxCg==')
    expect(enc).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(Buffer.from(enc, 'base64').length).toBeGreaterThanOrEqual(4)
  })

  it('Zertifikats-Seriennummer ist hexadezimal', () => {
    expect(felder[10]).toMatch(/^[0-9A-F]+$/)
  })

  it('Verkettungswert: 8 Byte, Standard-Base64', () => {
    const vk = felder[11]!
    expect(vk).toBe('cg8hNU5ihto=')
    expect(Buffer.from(vk, 'base64')).toHaveLength(8)
  })

  it('Signatur: 64 Byte P1363, Standard-Base64 (enthält +/= Zeichen-Klasse)', () => {
    const sig = felder[12]!
    expect(Buffer.from(sig, 'base64')).toHaveLength(64)
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  it('lässt sich in die JWS-Compact-Repräsentation umrechnen (und zurück)', () => {
    const jws = qrCodeZuJwsCompact(REFERENZ_BELEG)
    const [header, payload, sig] = jws.split('.')

    expect(header).toBe(JWS_HEADER_B64URL)
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ alg: 'ES256' })

    // Payload = Code ohne Signatur
    const codeOhneSig = REFERENZ_BELEG.slice(0, REFERENZ_BELEG.lastIndexOf('_'))
    expect(Buffer.from(payload!, 'base64url').toString('utf8')).toBe(codeOhneSig)

    // Signatur base64url ↔ base64 verlustfrei
    expect(Buffer.from(sig!, 'base64url').toString('base64')).toBe(felder[12])
  })
})
