/**
 * EXTERNE GEGENPROBE: Kassa-Code gegen Belege, die der BMF-Mustercode erzeugt hat.
 *
 * Die anderen Tests prüfen den Code gegen sich selbst (z. B. chain.test.ts rechnet SHA-256 nach, mit derselben
 * Lesart wie der Produktivcode). Hier laufen die Funktionen der Kassa über Daten, die ein unabhängiger
 * Generator des BMF (mit A-SIT Plus) erzeugt hat — Fixtures in tests/fixtures/bmf-mustercode, Herkunft dort.
 *
 * BEFUND A (kritisch): Die Verkettung der Folgebelege ist falsch. RKSV Anlage 1 Z 4 und alle 1284 Folgebelege der
 * 16 BMF-Szenarien hashen die JWS-Compact-Form des Vorbelegs (header.payload.signatur, base64url); die Kassa
 * hasht die QR-Form (Signatur in Standard-Base64). Die Tests dazu sind als `it.fails` festgehalten — sie laufen
 * grün, solange der Fehler besteht, und werden rot („Expect test to fail"), sobald er behoben ist: dann das
 * `.fails` entfernen.
 */

import { createDecipheriv, createHash, X509Certificate } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { berechneIV } from '../src/crypto/aes-icm.js'
import { pruefeKette, verkettungswertFolgebeleg, verkettungswertStartbeleg } from '../src/crypto/chain.js'
import { erstelleStartbeleg, qrCodeZuJwsCompact, signiereBeleg, verifiziereQrCode } from '../src/beleg.js'
import { derZuP1363, generateSEE, p1363ZuDer, zertifikatSN } from '../src/see.js'
import { ladeBmfSzenario, zerlegeQr, type BmfSzenario } from './helpers/pruef-export.js'

const sha8 = (eingabe: string): string => createHash('sha256').update(eingabe, 'utf8').digest().subarray(0, 8).toString('base64')

const AUSFALL_TEXT = 'Sicherheitseinrichtung ausgefallen'

/** Zweierkomplement, N Byte, big-endian (RKSV Anlage 1 Z 9) */
function ganzzahl(bytes: Buffer): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  const bits = BigInt(bytes.length * 8)
  return v >= (1n << (bits - 1n)) ? v - (1n << bits) : v
}

const cent = (text: string): bigint => {
  const neg = text.startsWith('-')
  const [euro, ct] = text.replace('-', '').split(',')
  return (neg ? -1n : 1n) * (BigInt(euro!) * 100n + BigInt(ct!))
}

for (const name of ['closed-system-1', 'open-system-1'] as const) {
  describe(`BMF-Referenzdaten: ${name}`, () => {
    const s: BmfSzenario = ladeBmfSzenario(name)
    const felder = s.qr.map(zerlegeQr)
    const kid = felder[0]!.kassenId

    it('enthält 81 Belege, QR- und JWS-Darstellung gleich viele', () => {
      expect(s.qr).toHaveLength(81)
      expect(s.jws).toHaveLength(81)
    })

    it('qrCodeZuJwsCompact macht aus jedem QR-Code genau die JWS-Form des BMF', () => {
      s.qr.forEach((code, i) => expect(qrCodeZuJwsCompact(code), `Beleg ${i + 1}`).toBe(s.jws[i]))
    })

    it('Startbeleg: Verkettungswert = Hash der Kassen-ID (stimmt mit dem BMF überein)', () => {
      expect(verkettungswertStartbeleg(kid)).toBe(felder[0]!.vorbeleg)
    })

    it('verkettungswertFolgebeleg(JWS des Vorbelegs) liefert den Wert des BMF für alle 80 Folgebelege', () => {
      for (let i = 1; i < s.jws.length; i++) {
        expect(verkettungswertFolgebeleg(s.jws[i - 1]!), `Beleg ${i + 1}`).toBe(felder[i]!.vorbeleg)
      }
    })

    it('… aber NICHT, wenn man ihr die QR-Form gibt (so ruft die Kassa sie heute auf): 0 von 80 Treffern', () => {
      let treffer = 0
      for (let i = 1; i < s.qr.length; i++) {
        if (verkettungswertFolgebeleg(s.qr[i - 1]!) === felder[i]!.vorbeleg) treffer++
      }
      expect(treffer).toBe(0)
    })

    it.fails('BEFUND A  pruefeKette akzeptiert die BMF-Kette (sie erwartet die QR-Form im Vorbeleg-Hash)', () => {
      const kette = s.qr.map((code, i) => ({ maschinenlesbareCode: code, sigVorbeleg: felder[i]!.vorbeleg }))
      expect(pruefeKette(kid, kette)).toBe(true)
    })

    it('Umsatzzähler: berechneIV + AES-256-CTR entschlüsseln alle 764 Zähler zur laufenden Summe (Training zählt nicht, Storno schon)', () => {
      const aes = Buffer.from(s.container.base64AESKey, 'base64')
      let summe = 0n
      let geprueft = 0
      felder.forEach((f, i) => {
        const betrag = f.betraege.reduce((a, b) => a + cent(b), 0n)
        const chiffre = Buffer.from(f.zaehler, 'base64')
        if (chiffre.toString('latin1') === 'TRA') return                // Klartext-Marker: Training, zählt nicht
        summe += betrag                                                  // 'STO': Storno zählt in den Folgebelegen mit
        if (chiffre.toString('latin1') === 'STO') return
        // Die Belegnummer des BMF ist Text („CASHBOX-DEMO-1-Receipt-ID-1"); berechneIV macht daraus String(belegNummer).
        const iv = berechneIV(kid, f.belegNummer as unknown as number)
        const klar = Buffer.concat([createDecipheriv('aes-256-ctr', aes, iv).update(chiffre)])
        expect(ganzzahl(klar), `Beleg ${i + 1}`).toBe(summe)
        geprueft++
      })
      expect(geprueft).toBeGreaterThan(40)
    })

    it('P1363 ↔ DER: alle BMF-Signaturen überstehen die Umwandlung verlustfrei', () => {
      let n = 0
      for (const f of felder) {
        const sig = Buffer.from(f.signatur, 'base64')
        if (sig.toString('utf8') === AUSFALL_TEXT) continue
        expect(sig).toHaveLength(64)
        expect(derZuP1363(p1363ZuDer(sig)).equals(sig)).toBe(true)
        n++
      }
      expect(n).toBeGreaterThan(40)
    })
  })
}

describe('BMF-Referenzdaten: Signaturen mit unserer Prüfung (offenes System, Zertifikate im Container)', () => {
  const s = ladeBmfSzenario('open-system-1')
  const eintraege = s.container.certificateOrPublicKeyMap

  it('verifiziereQrCode bestätigt jede nicht ausgefallene Signatur des BMF', () => {
    let geprueft = 0
    for (const code of s.qr) {
      const f = zerlegeQr(code)
      if (Buffer.from(f.signatur, 'base64').toString('utf8') === AUSFALL_TEXT) continue
      const eintrag = eintraege[f.seriennummer]
      expect(eintrag, `Zertifikat zu ${f.seriennummer}`).toBeDefined()
      expect(verifiziereQrCode(code, Buffer.from(eintrag!.signatureCertificateOrPublicKey, 'base64')), f.belegNummer).toBe(true)
      geprueft++
    }
    expect(geprueft).toBe(57)
  })

  it('Gegenprobe: ein verändertes Zeichen im Code bricht die Signatur', () => {
    const code = s.qr.find(c => Buffer.from(zerlegeQr(c).signatur, 'base64').toString('utf8') !== AUSFALL_TEXT)!
    const f = zerlegeQr(code)
    const zert = Buffer.from(eintraege[f.seriennummer]!.signatureCertificateOrPublicKey, 'base64')
    expect(verifiziereQrCode(code, zert)).toBe(true)
    expect(verifiziereQrCode(code.replace(f.datum, f.datum.replace(/.$/, c => (c === '0' ? '1' : '0'))), zert)).toBe(false)
  })

  it('Seriennummer im Beleg ↔ Zertifikat: das BMF-Beispiel trägt das Zweierkomplement (Eigenheit des Generators), wir tragen die Seriennummer', () => {
    // Zweierkomplement der 64-Bit-Seriennummer statt der Seriennummer selbst: nur im Beispiel-Generator des BMF.
    const f = zerlegeQr(s.qr[0]!)
    const serie = BigInt('0x' + new X509Certificate(Buffer.from(eintraege[f.seriennummer]!.signatureCertificateOrPublicKey, 'base64')).serialNumber)
    expect((BigInt('0x' + f.seriennummer) + serie) === (1n << 64n)).toBe(true)
  })
})

describe('Produktivpfad: wie verkettet die Kassa tatsächlich? (BEFUND A)', () => {
  async function dreiBelege() {
    const see = await generateSEE({ kassenId: 'KETTE-1', uid: 'ATU12345678', firmenname: 'Kette GmbH' })
    const { beleg: start, kontext } = await erstelleStartbeleg('KETTE-1', see)
    kontext.letzterBelegCode = start.maschinenlesbareCode
    const zwei = await signiereBeleg({ kassenId: 'KETTE-1', belegNummer: 2, datumUhrzeit: new Date(), belegTyp: 'Nullbeleg', positionen: [] }, kontext)
    kontext.letzterBelegCode = zwei.maschinenlesbareCode
    const drei = await signiereBeleg({ kassenId: 'KETTE-1', belegNummer: 3, datumUhrzeit: new Date(), belegTyp: 'Nullbeleg', positionen: [] }, kontext)
    return { start, zwei, drei, see }
  }

  it('Startbeleg: Hash der Kassen-ID (wie beim BMF)', async () => {
    const { start } = await dreiBelege()
    expect(start.sigVorbeleg).toBe(sha8('KETTE-1'))
  })

  it.fails('BEFUND A  Folgebeleg verkettet über die JWS-Compact-Form des Vorbelegs (RKSV Anlage 1 Z 4)', async () => {
    const { start, zwei, drei } = await dreiBelege()
    expect(zwei.sigVorbeleg).toBe(sha8(start.jwsCompact))
    expect(drei.sigVorbeleg).toBe(sha8(zwei.jwsCompact))
  })

  it('Ist-Zustand: die Kassa hasht die QR-Form (payload_signatur in Standard-Base64)', async () => {
    const { start, zwei } = await dreiBelege()
    expect(zwei.sigVorbeleg).toBe(sha8(start.maschinenlesbareCode))
    expect(zwei.sigVorbeleg).not.toBe(sha8(start.jwsCompact))
  })

  it('Seriennummer im Beleg = Seriennummer des Zertifikats (hexadezimal)', async () => {
    const { start, see } = await dreiBelege()
    expect(zerlegeQr(start.maschinenlesbareCode).seriennummer).toBe(zertifikatSN(see.zertifikatDER))
  })
})
