/**
 * Zugangs-Token der Boxen.
 *
 * Jede Box bekommt ein langes Zufalls-Token (32 Byte = 256 Bit). Das Portal speichert NUR dessen SHA-256 — wer die
 * Datenbank liest, kann sich damit nicht als Box ausgeben. Das Token wird genau einmal angezeigt (beim Anlegen bzw.
 * Erneuern). Bei so viel Zufall genügt ein schneller Hash; ein langsamer Passwort-Hash wäre hier nur Last.
 */

import { createHash, randomBytes } from 'node:crypto'

/** Erkennbares Präfix: Token lassen sich in Logs und Secret-Scannern wiederfinden. */
export const TOKEN_PRAEFIX = 'kpt_'

/** Form eines gültigen Tokens — alles andere wird gar nicht erst in der Datenbank gesucht. */
const TOKEN_FORM = /^kpt_[A-Za-z0-9_-]{43}$/

export interface NeuesBoxToken {
  /** Das Token im Klartext — nur jetzt verfügbar */
  token:   string
  /** SHA-256 in hex — das wird gespeichert */
  hash:    string
  /** Letzte vier Zeichen — zum Wiedererkennen */
  hinweis: string
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function erzeugeBoxToken(): NeuesBoxToken {
  const token = TOKEN_PRAEFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token), hinweis: token.slice(-4) }
}

/** Token aus dem Header `Authorization: Bearer …`; null, wenn nicht vorhanden oder nicht von der richtigen Form. */
export function tokenAusAuthorization(header: string | undefined): string | null {
  if (!header) return null
  const treffer = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = treffer?.[1]
  return token && TOKEN_FORM.test(token) ? token : null
}
