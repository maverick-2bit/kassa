/**
 * Passwort-Verschlüsselung der Übergabedatei (.kuep) für den Mandanten-Transfer.
 *
 * Format: "KUEP2" | salt[16] | iv[12] | tag[16] | AES-256-GCM(gzip(JSON))
 * Schlüssel: scrypt(Passwort, salt), 32 Byte. Falsches Passwort und manipulierte Datei
 * sind für GCM nicht unterscheidbar → eine gemeinsame Fehlermeldung.
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

const MAGIC = Buffer.from('KUEP2', 'ascii')
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

export const MIN_PASSWORT_LAENGE = 10

export class UebergabeDateiError extends Error {}

function schluessel(passwort: string, salt: Buffer): Buffer {
  return scryptSync(passwort, salt, 32, SCRYPT)
}

export function verschluesselePaket(klar: Buffer, passwort: string): Buffer {
  if (passwort.length < MIN_PASSWORT_LAENGE) throw new UebergabeDateiError(`Das Übergabe-Passwort braucht mindestens ${MIN_PASSWORT_LAENGE} Zeichen.`)
  const salt = randomBytes(16)
  const iv   = randomBytes(12)
  const c    = createCipheriv('aes-256-gcm', schluessel(passwort, salt), iv)
  const enc  = Buffer.concat([c.update(gzipSync(klar)), c.final()])
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc])
}

export function entschluesselePaket(paket: Buffer, passwort: string): Buffer {
  const kopf = MAGIC.length + 16 + 12 + 16
  if (paket.length <= kopf || !paket.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new UebergabeDateiError('Das ist keine Kassa-Übergabedatei.')
  }
  const salt = paket.subarray(MAGIC.length, MAGIC.length + 16)
  const iv   = paket.subarray(MAGIC.length + 16, MAGIC.length + 28)
  const tag  = paket.subarray(MAGIC.length + 28, kopf)
  try {
    const d = createDecipheriv('aes-256-gcm', schluessel(passwort, salt), iv)
    d.setAuthTag(tag)
    return gunzipSync(Buffer.concat([d.update(paket.subarray(kopf)), d.final()]))
  } catch {
    throw new UebergabeDateiError('Falsches Passwort oder die Datei ist beschädigt.')
  }
}
