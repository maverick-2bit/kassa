/**
 * Verschlüsselung der TOTP-Geheimnisse in der Datenbank (AES-256-GCM).
 *
 * Wer nur die Datenbank besitzt (Sicherung, Dump), kann damit keine Codes erzeugen; dafür braucht es zusätzlich
 * PORTAL_MASTER_KEY. GCM schützt auch gegen Verändern: ein manipulierter Eintrag lässt sich nicht entschlüsseln.
 *
 * Format: `v1.<iv>.<tag>.<verschlüsselt>`, alles base64url.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const VERSION = 'v1'
const SALZ = 'kassa-portal/totp/v1'

/** Aus dem Master-Schlüssel der Konfiguration den 32-Byte-AES-Schlüssel ableiten (einmal beim Start). */
export function leiteSchluesselAb(masterKey: string): Buffer {
  return scryptSync(masterKey, SALZ, 32)
}

export function verschluessele(klartext: string, schluessel: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', schluessel, iv)
  const daten = Buffer.concat([cipher.update(klartext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), daten.toString('base64url')].join('.')
}

/** Wirft bei falschem Schlüssel, verändertem Eintrag oder unbekanntem Format. */
export function entschluessele(paket: string, schluessel: Buffer): string {
  const teile = paket.split('.')
  if (teile.length !== 4 || teile[0] !== VERSION) throw new Error('Unbekanntes Format des verschlüsselten Werts')
  const iv = Buffer.from(teile[1]!, 'base64url')
  const tag = Buffer.from(teile[2]!, 'base64url')
  const daten = Buffer.from(teile[3]!, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', schluessel, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(daten), decipher.final()]).toString('utf8')
}
