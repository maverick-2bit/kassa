/**
 * Das selbstsignierte Zertifikat der Software-SEE (see.ts, eigene minimale ASN.1-Kodierung).
 *
 * Anlass (Mutationstest, siehe PRUEFSTRECKE.md): Die bisherigen Tests prüften nur, dass Node das Zertifikat lesen kann und
 * Signaturen verifizieren. Ob die Selbstsignatur stimmt, wie lange das Zertifikat gilt, ob Name und Seriennummer richtig
 * kodiert sind — das konnte sich unbemerkt ändern.
 */

import { X509Certificate } from 'node:crypto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateSEE, ladeSeInfo, zertifikatSN } from '../src/see.js'

const TAG = 24 * 60 * 60 * 1000

afterEach(() => vi.restoreAllMocks())

describe('Zertifikat der Software-SEE', () => {
  it('die Selbstsignatur stimmt (Aussteller = Inhaber, Signatur über das TBS-Zertifikat gültig)', async () => {
    const see = await generateSEE({ kassenId: 'ZERT-1', uid: 'ATU12345678', firmenname: 'Zert GmbH' })
    const cert = new X509Certificate(see.zertifikatDER)
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.ca).toBe(false)
  })

  it('Name: Land AT, Organisation, CN = RKSV-SEE-<Kassen-ID>; Alternativname mit der Kassen-ID', async () => {
    const see = await generateSEE({ kassenId: 'ZERT-2', uid: 'ATU12345678', firmenname: 'Mühle & Söhne OG' })
    const cert = new X509Certificate(see.zertifikatDER)
    const teile = cert.subject.split('\n')
    expect(teile).toContain('C=AT')
    expect(teile).toContain('O=Mühle & Söhne OG')
    expect(teile).toContain('CN=RKSV-SEE-ZERT-2')
    expect(cert.subjectAltName).toBe('URI:urn:at:bmf:rksv:ZERT-2')
  })

  it('Gültigkeit: ab jetzt, Standard 1826 Tage (5 Jahre); eigene Dauer wird übernommen', async () => {
    const vorher = Date.now()
    const standard = new X509Certificate((await generateSEE({ kassenId: 'ZERT-3', uid: 'ATU1', firmenname: 'X' })).zertifikatDER)
    const kurz = new X509Certificate((await generateSEE({ kassenId: 'ZERT-3', uid: 'ATU1', firmenname: 'X', gueltigkeitTage: 30 })).zertifikatDER)
    for (const [cert, tage] of [[standard, 1826], [kurz, 30]] as const) {
      const von = Date.parse(cert.validFrom), bis = Date.parse(cert.validTo)
      expect(Math.abs(von - vorher), `validFrom ${cert.validFrom}`).toBeLessThan(10_000)
      expect(Math.abs((bis - von) - tage * TAG), `Dauer ${tage} Tage`).toBeLessThan(5_000)
    }
  })

  it('ladeSeInfo liefert Kassen-ID, Seriennummer, Gültigkeit und Algorithmus des Zertifikats', async () => {
    const see = await generateSEE({ kassenId: 'ZERT-4', uid: 'ATU1', firmenname: 'X', gueltigkeitTage: 400 })
    const cert = new X509Certificate(see.zertifikatDER)
    const info = ladeSeInfo(see)
    expect(info).toEqual({
      kassenId: 'ZERT-4', zertifikatSN: cert.serialNumber,
      gueltigAb: new Date(cert.validFrom), gueltigBis: new Date(cert.validTo), algorithmus: 'ES256',
    })
    expect(zertifikatSN(see.zertifikatDER)).toBe(cert.serialNumber)
    expect(info.zertifikatSN).toMatch(/^[0-9A-F]+$/)
  })

  it('ZDA-Kennung der Software-SEE ist AT0, der AES-Schlüssel 32 Byte und je SEE verschieden', async () => {
    const a = await generateSEE({ kassenId: 'ZERT-5', uid: 'ATU1', firmenname: 'X' })
    const b = await generateSEE({ kassenId: 'ZERT-5', uid: 'ATU1', firmenname: 'X' })
    expect(a.zdaId).toBe('AT0')
    expect(a.aesSchluessel).toHaveLength(32)
    expect(a.aesSchluessel.equals(b.aesSchluessel)).toBe(false)
    expect(a.privateKeyDER.equals(b.privateKeyDER)).toBe(false)
  })
})

describe('ASN.1-Kodierung (Längen und Seriennummer)', () => {
  it.each([[10], [127], [128], [200], [255], [256], [1000]])('Organisationsname mit %i Zeichen: Kurz- und Langform der Länge', async n => {
    const name = 'O'.repeat(n)
    const cert = new X509Certificate((await generateSEE({ kassenId: 'ZERT-6', uid: 'ATU1', firmenname: name })).zertifikatDER)
    expect(cert.subject.split('\n')).toContain(`O=${name}`)
    expect(cert.verify(cert.publicKey)).toBe(true)
  })

  it.each([
    ['gerade Anzahl Hex-Stellen, höchstes Bit frei', 0x7f12345678n],
    ['ungerade Anzahl Hex-Stellen',                  0x123456789n],
    ['höchstes Bit gesetzt (braucht Vorzeichen-Byte 0x00)', 0x8000000000n],
    ['kleine Seriennummer',                          0x42n],
  ])('Seriennummer: %s', async (_name, wert) => {
    vi.spyOn(Date, 'now').mockReturnValue(Number(wert))
    const see = await generateSEE({ kassenId: 'ZERT-7', uid: 'ATU1', firmenname: 'X' })
    const cert = new X509Certificate(see.zertifikatDER)
    expect(BigInt('0x' + cert.serialNumber)).toBe(wert)            // positiv und unverändert
    expect(cert.verify(cert.publicKey)).toBe(true)
  })
})
