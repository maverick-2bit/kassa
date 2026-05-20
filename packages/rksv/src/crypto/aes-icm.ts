/**
 * AES-256-ICM (Integer Counter Mode) für den RKSV-Umsatzzähler.
 *
 * Gemäß BMF Detailspezifikation §4 Abs. 2:
 *   Schlüssel  = SHA-256( BASE64_STD(DER-Zertifikat) ‖ KassenID )   [32 Byte]
 *   IV/Counter = Belegnummer als vorzeichenloser 128-Bit-Big-Endian  [16 Byte]
 *   Klartext   = Umsatzzähler als vorzeichenbehafteter Int64 Big-Endian [8 Byte]
 *
 * AES-256-ICM und AES-256-CTR sind dasselbe Verfahren (unterschiedliche Benennung).
 * Node.js crypto stellt 'aes-256-ctr' bereit.
 */

import { createCipheriv, createHash } from 'node:crypto'

/**
 * Leitet den AES-Schlüssel aus Zertifikat und Kassen-ID ab.
 * @param zertifikatDER  DER-kodiertes X.509-Zertifikat (public certificate)
 * @param kassenId       Kassen-Identifikationsnummer
 */
export function deriveAesKey(zertifikatDER: Buffer, kassenId: string): Buffer {
  const certBase64 = zertifikatDER.toString('base64') // Standard Base64 (kein URL-safe)
  return createHash('sha256')
    .update(certBase64 + kassenId, 'utf8')
    .digest()
}

/**
 * Kodiert die Belegnummer als 128-Bit-Big-Endian-IV (16 Byte).
 * Die Nummer sitzt in den unteren 8 Byte, die oberen 8 Byte sind 0.
 */
export function belegNummerZuIV(belegNummer: number): Buffer {
  const iv = Buffer.alloc(16, 0)
  iv.writeBigUInt64BE(BigInt(belegNummer), 8)
  return iv
}

/**
 * Verschlüsselt den Umsatzzähler (Int64) mit AES-256-ICM.
 * @returns  8 Byte verschlüsselte Daten
 */
export function verschluesselUmsatzzaehler(
  zaehlerCent: bigint,
  zertifikatDER: Buffer,
  kassenId: string,
  belegNummer: number,
): Buffer {
  const key = deriveAesKey(zertifikatDER, kassenId)
  const iv  = belegNummerZuIV(belegNummer)

  const cipher    = createCipheriv('aes-256-ctr', key, iv)
  const plaintext = Buffer.alloc(8)
  plaintext.writeBigInt64BE(zaehlerCent)

  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * Entschlüsselt den Umsatzzähler (nur für Prüfzwecke / Finanzprüfung).
 */
export function entschluesselUmsatzzaehler(
  verschluesselt: Buffer,
  zertifikatDER: Buffer,
  kassenId: string,
  belegNummer: number,
): bigint {
  // CTR-Mode: Entschlüsselung = erneute Verschlüsselung
  const key = deriveAesKey(zertifikatDER, kassenId)
  const iv  = belegNummerZuIV(belegNummer)

  const decipher = createCipheriv('aes-256-ctr', key, iv)
  const plain    = Buffer.concat([decipher.update(verschluesselt), decipher.final()])
  return plain.readBigInt64BE(0)
}
