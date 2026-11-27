/**
 * Passwörter der Portal-Benutzer (bcrypt) und ihre Regeln.
 */

import bcrypt from 'bcryptjs'
import { PASSWORT_MIN_LAENGE } from '@kassa/shared'

export const BCRYPT_KOSTEN = 12

/** bcrypt liest nur die ersten 72 Byte — alles darüber würde stillschweigend ignoriert. */
export const PASSWORT_MAX_BYTES = 72

/**
 * Hash eines Passworts, das zu keinem Benutzer gehört. Bei unbekannter E-Mail wird trotzdem gegen diesen Hash geprüft,
 * damit die Antwortzeit nicht verrät, ob es die E-Mail im Portal gibt.
 */
const HASH_OHNE_BENUTZER = '$2a$12$leZzJADcpUIRkzEHXSOqZ.5L3UsQfAZjLo/MKR2jmV95kgOKYzVJ2'

export async function hashPasswort(passwort: string): Promise<string> {
  return bcrypt.hash(passwort, BCRYPT_KOSTEN)
}

export async function pruefePasswort(passwort: string, hash: string): Promise<boolean> {
  return bcrypt.compare(passwort, hash)
}

/** Zeitaufwand wie eine echte Prüfung, Ergebnis immer „falsch". */
export async function scheinPruefung(passwort: string): Promise<false> {
  await bcrypt.compare(passwort, HASH_OHNE_BENUTZER)
  return false
}

/** Regeln für ein NEUES Passwort. Gibt eine verständliche Meldung zurück, oder null wenn es passt. */
export function pruefePasswortRegel(passwort: string, email?: string): string | null {
  if (passwort.length < PASSWORT_MIN_LAENGE) return `Das Passwort braucht mindestens ${PASSWORT_MIN_LAENGE} Zeichen.`
  if (Buffer.byteLength(passwort, 'utf8') > PASSWORT_MAX_BYTES) return `Das Passwort darf höchstens ${PASSWORT_MAX_BYTES} Byte lang sein.`
  if (new Set(passwort).size < 4) return 'Das Passwort ist zu einfach (zu wenige verschiedene Zeichen).'
  if (email) {
    const kern = email.split('@')[0]?.toLowerCase() ?? ''
    if (kern.length >= 4 && passwort.toLowerCase().includes(kern)) return 'Das Passwort darf nicht die E-Mail-Adresse enthalten.'
  }
  return null
}
