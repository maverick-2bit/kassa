/**
 * AES-256-ICM (Integer Counter Mode) für den RKSV-Umsatzzähler.
 *
 * Gemäß BMF-Detailspezifikation:
 *   Schlüssel  = EIGENSTÄNDIGER AES-256-Schlüssel (32 Byte, vom Betreiber
 *                erzeugt; wird bei der FON-Kassenregistrierung als base64
 *                gemeldet — NICHT aus dem Zertifikat abgeleitet)
 *   IV/Counter = erste 16 Byte von SHA-256( kassenId ‖ belegNummer )
 *   Klartext   = Umsatzzähler als vorzeichenbehafteter Int64 Big-Endian [8 Byte]
 *
 * AES-256-ICM und AES-256-CTR sind dasselbe Verfahren (unterschiedliche Benennung).
 * Node.js crypto stellt 'aes-256-ctr' bereit.
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto'

/** Erzeugt einen neuen zufälligen AES-256-Schlüssel (32 Byte) für eine Kasse. */
export function generiereAesSchluessel(): Buffer {
  return randomBytes(32)
}

/**
 * IV gemäß Detailspezifikation: erste 16 Byte von SHA-256(kassenId ‖ belegNummer).
 * Die Belegnummer geht als Dezimal-String in die Konkatenation ein.
 */
export function berechneIV(kassenId: string, belegNummer: number): Buffer {
  return createHash('sha256')
    .update(kassenId + String(belegNummer), 'utf8')
    .digest()
    .subarray(0, 16)
}

/**
 * Verschlüsselt den Umsatzzähler (Int64) mit AES-256-ICM.
 * @returns  8 Byte verschlüsselte Daten
 */
export function verschluesselUmsatzzaehler(
  zaehlerCent: bigint,
  aesSchluessel: Buffer,
  kassenId: string,
  belegNummer: number,
): Buffer {
  const iv = berechneIV(kassenId, belegNummer)

  const cipher    = createCipheriv('aes-256-ctr', aesSchluessel, iv)
  const plaintext = Buffer.alloc(8)
  plaintext.writeBigInt64BE(zaehlerCent)

  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * Entschlüsselt den Umsatzzähler (nur für Prüfzwecke / Finanzprüfung).
 */
export function entschluesselUmsatzzaehler(
  verschluesselt: Buffer,
  aesSchluessel: Buffer,
  kassenId: string,
  belegNummer: number,
): bigint {
  // CTR-Mode: Entschlüsselung = erneute Verschlüsselung
  const iv = berechneIV(kassenId, belegNummer)

  const decipher = createCipheriv('aes-256-ctr', aesSchluessel, iv)
  const plain    = Buffer.concat([decipher.update(verschluesselt), decipher.final()])
  return plain.readBigInt64BE(0)
}
