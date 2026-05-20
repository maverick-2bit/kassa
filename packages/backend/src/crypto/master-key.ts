/**
 * Master-Key-Verschlüsselung für SEE-Private-Keys.
 *
 * Verfahren: AES-256-GCM (authenticated encryption)
 *   - Schlüssel:  scrypt(MASTER_PASSPHRASE, salt) — 32 Byte
 *   - Nonce/IV:   12 Byte, zufällig pro Verschlüsselung
 *   - Auth-Tag:   16 Byte (GCM)
 *   - Format:     base64( salt[16] | iv[12] | tag[16] | ciphertext )
 *
 * Warum salt-per-record: erlaubt es, die Passphrase zu rotieren ohne alle
 * Schlüssel auf einmal neu zu verschlüsseln (späteres Feature).
 *
 * WICHTIG: Bei Verlust der MASTER_PASSPHRASE sind alle SEE-Schlüssel verloren
 *          und alle Kassen müssen neu eingerichtet werden.
 */

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto'

const SALT_LEN = 16
const IV_LEN   = 12
const TAG_LEN  = 16
const KEY_LEN  = 32

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 16384, r: 8, p: 1 })
}

/**
 * Verschlüsselt einen privaten Schlüssel (oder beliebige Bytes).
 * @returns base64-kodierter Container
 */
export function encryptPrivateKey(plaintext: Buffer, passphrase: string): string {
  const salt = randomBytes(SALT_LEN)
  const iv   = randomBytes(IV_LEN)
  const key  = deriveKey(passphrase, salt)

  const cipher    = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag       = cipher.getAuthTag()

  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64')
}

/**
 * Entschlüsselt einen verschlüsselten Schlüssel.
 * @throws Error wenn Auth-Tag-Verifikation fehlschlägt (Manipulation oder falsche Passphrase)
 */
export function decryptPrivateKey(encrypted: string, passphrase: string): Buffer {
  const buf  = Buffer.from(encrypted, 'base64')
  if (buf.length < SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('Verschlüsselter Container zu kurz')
  }

  const salt       = buf.subarray(0, SALT_LEN)
  const iv         = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag        = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN)

  const key      = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
