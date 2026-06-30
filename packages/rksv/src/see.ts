/**
 * SEE – Signaturerstellungseinheit (Software-Implementierung).
 *
 * Die österreichische RKSV erlaubt Software-Zertifikate (kein Hardware-HSM erforderlich).
 * Verwendet ECDSA P-256 mit SHA-256 (Algorithmus-Kennung: ES256).
 *
 * Zertifikat-Anforderungen laut BMF:
 *   - Selbstsigniert oder von einer öffentlichen CA ausgestellt
 *   - Schlüssellänge: mind. 256 Bit (ECDSA P-256 erfüllt dies)
 *   - Gültigkeit: empfohlen 5 Jahre (gesetzl. Aufbewahrung 7 Jahre)
 */

import {
  generateKeyPairSync,
  createSign,
  createVerify,
  createPrivateKey,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import type { SEEConfig, SEEInfo } from './types.js'

// ---------------------------------------------------------------------------
// Schlüssel & Zertifikat erzeugen
// ---------------------------------------------------------------------------

export interface SEEGenerierungsOptionen {
  kassenId: string
  uid: string
  firmenname: string
  /** Gültigkeitsdauer in Tagen (Standard: 1826 = 5 Jahre) */
  gueltigkeitTage?: number
}

/**
 * Generiert ein neues ECDSA-P256-Schlüsselpaar und ein selbstsigniertes X.509-Zertifikat.
 * Das Zertifikat wird für die Registrierung bei FinanzOnline verwendet.
 *
 * Für produktive Umgebungen kann stattdessen ein Zertifikat einer akkreditierten CA
 * (z. B. A-Trust) verwendet werden — die API ist identisch.
 */
export async function generateSEE(opts: SEEGenerierungsOptionen): Promise<SEEConfig> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })

  const gueltigkeitTage = opts.gueltigkeitTage ?? 1826
  const jetzt           = new Date()
  const ablauf          = new Date(jetzt.getTime() + gueltigkeitTage * 24 * 60 * 60 * 1000)

  // Node.js ≥22 unterstützt X509Certificate.generate() — für ältere Versionen verwenden
  // wir einen minimalen self-signed Cert über den privaten Schlüssel.
  // Da Node.js keine native Zertifikatsgenerierung bietet, nutzen wir eine
  // eigene minimale DER-Kodierung (nur für self-signed, RFC5280-konform).
  const certDER = buildSelfSignedCert({
    subject: {
      commonName:   `RKSV-SEE-${opts.kassenId}`,
      organization: opts.firmenname,
      country:      'AT',
    },
    uid:        opts.uid,
    kassenId:   opts.kassenId,
    notBefore:  jetzt,
    notAfter:   ablauf,
    privateKey,
    publicKey,
  })

  const privateKeyDER = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer

  return {
    kassenId:      opts.kassenId,
    zertifikatDER: certDER,
    privateKeyDER,
  }
}

// ---------------------------------------------------------------------------
// SEE laden und Informationen abrufen
// ---------------------------------------------------------------------------

export function ladeSeInfo(config: SEEConfig): SEEInfo {
  const cert = new X509Certificate(config.zertifikatDER)
  return {
    kassenId:     config.kassenId,
    zertifikatSN: cert.serialNumber,
    gueltigAb:    new Date(cert.validFrom),
    gueltigBis:   new Date(cert.validTo),
    algorithmus:  'ES256',
  }
}

// ---------------------------------------------------------------------------
// Signieren
// ---------------------------------------------------------------------------

/**
 * Signiert eine UTF-8-kodierte Zeichenkette mit ECDSA-P256-SHA256.
 * @returns  base64url-kodierte DER-Signatur (IEEE P1363 Format für RKSV)
 */
export function signiere(daten: string, config: SEEConfig): string {
  const privKey = createPrivateKey({
    key:    config.privateKeyDER,
    format: 'der',
    type:   'pkcs8',
  })

  const sign = createSign('SHA256')
  sign.update(daten, 'utf8')

  // DER-Signatur → in P1363-Format (r ‖ s, je 32 Byte) umwandeln für kompakteren QR-Code
  const derSig = sign.sign(privKey)
  return derZuP1363(derSig).toString('base64url')
}

/**
 * Verifiziert eine RKSV-Signatur (für Tests und Finanzprüfung).
 */
export function verifiziere(daten: string, signaturBase64url: string, config: SEEConfig): boolean {
  try {
    // zertifikatDER ist ein vollständiges X.509-Zertifikat (siehe generateSEE);
    // der öffentliche Schlüssel wird daraus extrahiert.
    const pubKey = new X509Certificate(config.zertifikatDER).publicKey

    const verify = createVerify('SHA256')
    verify.update(daten, 'utf8')

    const p1363Sig = Buffer.from(signaturBase64url, 'base64url')
    const derSig   = p1363ZuDer(p1363Sig)
    return verify.verify(pubKey, derSig)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Zertifikats-Seriennummer
// ---------------------------------------------------------------------------

export function zertifikatSN(zertifikatDER: Buffer): string {
  const cert = new X509Certificate(zertifikatDER)
  return cert.serialNumber
}

// ---------------------------------------------------------------------------
// Signaturformat-Konvertierungen
// ---------------------------------------------------------------------------

/**
 * Konvertiert eine ECDSA-P256-DER-Signatur (ASN.1 SEQUENCE r,s) in
 * das P1363-Format (r ‖ s, je 32 Byte = 64 Byte gesamt).
 * Das P1363-Format ist kompakter und für RKSV QR-Codes besser geeignet.
 */
export function derZuP1363(derSig: Buffer): Buffer {
  // DER SEQUENCE: 30 <len> 02 <rLen> <r> 02 <sLen> <s>
  let offset = 2 // überspringe 0x30 und Länge
  if (derSig[1] === 0x81) offset = 3 // Long-Form-Länge

  offset++ // 0x02
  const rLen = derSig[offset++] as number
  const r    = derSig.subarray(offset, offset + rLen)
  offset += rLen

  offset++ // 0x02
  const sLen = derSig[offset++] as number
  const s    = derSig.subarray(offset, offset + sLen)

  // Führende Null-Bytes (ASN.1 Vorzeichen) entfernen, auf 32 Byte padden
  const result = Buffer.alloc(64, 0)
  r.subarray(r.length - 32).copy(result, 0)
  s.subarray(s.length - 32).copy(result, 32)
  return result
}

/** P1363 → DER (für verify) */
export function p1363ZuDer(p1363: Buffer): Buffer {
  const r = trimLeadingZeros(p1363.subarray(0, 32))
  const s = trimLeadingZeros(p1363.subarray(32, 64))

  // ASN.1-Vorzeichen: führende 0x00 wenn High-Bit gesetzt
  const rPad = (r[0] !== undefined && r[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), r]) : r
  const sPad = (s[0] !== undefined && s[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), s]) : s

  const seqLen = 2 + rPad.length + 2 + sPad.length
  return Buffer.concat([
    Buffer.from([0x30, seqLen, 0x02, rPad.length]),
    rPad,
    Buffer.from([0x02, sPad.length]),
    sPad,
  ])
}

function trimLeadingZeros(buf: Buffer): Buffer {
  let start = 0
  while (start < buf.length - 1 && buf[start] === 0) start++
  return buf.subarray(start)
}

// ---------------------------------------------------------------------------
// Self-signed Certificate (minimale RFC5280-Implementierung)
// ---------------------------------------------------------------------------

interface CertSubject {
  commonName:   string
  organization: string
  country:      string
}

interface CertParams {
  subject:    CertSubject
  uid:        string
  kassenId:   string
  notBefore:  Date
  notAfter:   Date
  privateKey: KeyObject
  publicKey:  KeyObject
}

function buildSelfSignedCert(params: CertParams): Buffer {
  // Public Key als SubjectPublicKeyInfo (SPKI) DER
  const spkiDer = params.publicKey.export({ type: 'spki', format: 'der' }) as Buffer

  // Seriennummer: aktueller Timestamp als positive Integer
  const serialNumber = BigInt(Date.now())
  const serialBytes  = bigintToMinimalBytes(serialNumber)

  // Gültigkeitszeitraum als UTCTime / GeneralizedTime
  const notBeforeBytes = encodeGeneralizedTime(params.notBefore)
  const notAfterBytes  = encodeGeneralizedTime(params.notAfter)

  // Subject / Issuer (identisch bei self-signed)
  const dnBytes = encodeDN(params.subject)

  // TBSCertificate bauen
  const version        = asn1Tag(0xa0, asn1Tag(0x02, Buffer.from([0x02]))) // v3
  const serialAsn1     = asn1Tag(0x02, serialBytes)
  const algorithmAsn1  = encodeEcdsaSha256AlgorithmId()
  const validityAsn1   = asn1Tag(0x30, Buffer.concat([notBeforeBytes, notAfterBytes]))
  const spkiAsn1       = spkiDer

  // SubjectAltName Extension mit Kassen-ID als URI
  const sanExt = buildSANExtension(`urn:at:bmf:rksv:${params.kassenId}`)

  const tbsCert = asn1Tag(0x30, Buffer.concat([
    version,
    serialAsn1,
    algorithmAsn1,
    dnBytes,      // issuer
    validityAsn1,
    dnBytes,      // subject
    spkiAsn1,
    sanExt,
  ]))

  // Signatur über TBSCertificate
  const privKey = createPrivateKey({
    key:    params.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    format: 'der',
    type:   'pkcs8',
  })
  const signer = createSign('SHA256')
  signer.update(tbsCert)
  const sigDer = signer.sign(privKey)

  // Certificate = SEQUENCE { tbsCert, algorithmId, BIT STRING { sig } }
  const bitString = Buffer.concat([Buffer.from([0x00]), sigDer]) // 0x00 = keine unused bits
  return asn1Tag(0x30, Buffer.concat([
    tbsCert,
    algorithmAsn1,
    asn1Tag(0x03, bitString),
  ]))
}

// ---------------------------------------------------------------------------
// ASN.1 Hilfsfunktionen (minimale Implementierung für Zertifikatsbau)
// ---------------------------------------------------------------------------

function asn1Tag(tag: number, content: Buffer): Buffer {
  const lenBytes = encodeLength(content.length)
  return Buffer.concat([Buffer.from([tag]), lenBytes, content])
}

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  if (len < 0x100) return Buffer.from([0x81, len])
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff])
}

function bigintToMinimalBytes(n: bigint): Buffer {
  const hex = n.toString(16).padStart(2, '0')
  const buf = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex')
  // Führende 0x00 für positives Integer in ASN.1
  if (buf[0] !== undefined && buf[0] & 0x80) return Buffer.concat([Buffer.from([0x00]), buf])
  return buf
}

function encodeGeneralizedTime(d: Date): Buffer {
  const pad  = (n: number, l = 2): string => String(n).padStart(l, '0')
  const str  = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
               `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return asn1Tag(0x18, Buffer.from(str, 'ascii')) // GeneralizedTime
}

function encodeOID(oid: string): Buffer {
  const parts = oid.split('.').map(Number)
  if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`Ungültige OID: ${oid}`)
  }
  const bytes: number[] = [parts[0] * 40 + parts[1]]
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i] as number
    const encoded: number[] = []
    encoded.unshift(val & 0x7f)
    val >>= 7
    while (val > 0) {
      encoded.unshift((val & 0x7f) | 0x80)
      val >>= 7
    }
    bytes.push(...encoded)
  }
  return asn1Tag(0x06, Buffer.from(bytes))
}

function encodeUtf8String(s: string): Buffer {
  return asn1Tag(0x0c, Buffer.from(s, 'utf8'))
}

function encodeDN(subject: CertSubject): Buffer {
  const encodeRDN = (oid: string, value: string): Buffer =>
    asn1Tag(0x31, asn1Tag(0x30, Buffer.concat([encodeOID(oid), encodeUtf8String(value)])))

  return asn1Tag(0x30, Buffer.concat([
    encodeRDN('2.5.4.6',  subject.country),       // countryName
    encodeRDN('2.5.4.10', subject.organization),   // organizationName
    encodeRDN('2.5.4.3',  subject.commonName),     // commonName
  ]))
}

function encodeEcdsaSha256AlgorithmId(): Buffer {
  // AlgorithmIdentifier { ecdsa-with-SHA256 (1.2.840.10045.4.3.2), NULL }
  return asn1Tag(0x30, encodeOID('1.2.840.10045.4.3.2'))
}

function buildSANExtension(uri: string): Buffer {
  // SubjectAltName Extension: OID 2.5.29.17, URI GeneralName [6]
  const uriBytes    = asn1Tag(0x86, Buffer.from(uri, 'ascii')) // [6] IMPLICIT IA5String
  const sanValue    = asn1Tag(0x30, uriBytes)
  const extValue    = asn1Tag(0x04, sanValue)                  // OCTET STRING
  const extSeq      = asn1Tag(0x30, Buffer.concat([encodeOID('2.5.29.17'), extValue]))
  const extensions  = asn1Tag(0x30, extSeq)
  return asn1Tag(0xa3, extensions)                             // [3] EXPLICIT Extensions
}
