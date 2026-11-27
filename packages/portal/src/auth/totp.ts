/**
 * TOTP (RFC 6238) für die Anmeldung mit Authenticator-App — ohne Fremdbibliothek, rein auf node:crypto.
 *
 * 6 Stellen, 30-Sekunden-Schritte, HMAC-SHA1 (das beherrschen alle Authenticator-Apps). Ein Code gilt nur
 * einmal: der zuletzt benutzte Schritt wird gespeichert, kleinere oder gleiche Schritte werden abgelehnt.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const TOTP_SCHRITT_SEKUNDEN = 30
export const TOTP_STELLEN = 6

/** Base32 (RFC 4648) ohne Auffüllzeichen. */
export function base32Kodiere(daten: Buffer): string {
  let bits = 0
  let wert = 0
  let ergebnis = ''
  for (const byte of daten) {
    wert = (wert << 8) | byte
    bits += 8
    while (bits >= 5) {
      ergebnis += ALPHABET[(wert >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) ergebnis += ALPHABET[(wert << (5 - bits)) & 31]
  return ergebnis
}

/** Base32 lesen; Groß-/Kleinschreibung, Leerzeichen und `=` am Ende sind egal. Ungültige Zeichen werfen. */
export function base32Dekodiere(text: string): Buffer {
  const sauber = text.replace(/[\s=]+/g, '').toUpperCase()
  let bits = 0
  let wert = 0
  const bytes: number[] = []
  for (const zeichen of sauber) {
    const index = ALPHABET.indexOf(zeichen)
    if (index === -1) throw new Error(`Ungültiges Base32-Zeichen: ${zeichen}`)
    wert = (wert << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((wert >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** HOTP (RFC 4226): Code für einen Zähler. `stellen` ist nur zum Prüfen gegen die RFC-Testwerte (8) veränderbar. */
export function hotp(geheimnis: Buffer, zaehler: number, stellen: number = TOTP_STELLEN): string {
  const block = Buffer.alloc(8)
  block.writeBigUInt64BE(BigInt(zaehler))
  const mac = createHmac('sha1', geheimnis).update(block).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const zahl =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!
  return String(zahl % 10 ** stellen).padStart(stellen, '0')
}

/** Der 30-Sekunden-Schritt eines Zeitpunkts. */
export function totpSchritt(jetztMs: number = Date.now()): number {
  return Math.floor(jetztMs / 1000 / TOTP_SCHRITT_SEKUNDEN)
}

/** Neues zufälliges Geheimnis (20 Byte, Base32) — so lang wie von RFC 4226 empfohlen. */
export function erzeugeTotpGeheimnis(): string {
  return base32Kodiere(randomBytes(20))
}

/** Adresse für den QR-Code der Authenticator-App. */
export function otpauthUrl(geheimnisBase32: string, konto: string, aussteller = 'Kassa Serviceportal'): string {
  const label = `${encodeURIComponent(aussteller)}:${encodeURIComponent(konto)}`
  const parameter = new URLSearchParams({
    secret:    geheimnisBase32,
    issuer:    aussteller,
    algorithm: 'SHA1',
    digits:    String(TOTP_STELLEN),
    period:    String(TOTP_SCHRITT_SEKUNDEN),
  })
  return `otpauth://totp/${label}?${parameter.toString()}`
}

export type TotpPruefung = { gueltig: true; schritt: number } | { gueltig: false }

export interface TotpPruefOptionen {
  /** Zeitpunkt in ms (für Tests); Standard: jetzt */
  jetztMs?: number
  /** Zuletzt benutzter Schritt dieses Benutzers; dieser und ältere Schritte werden abgelehnt */
  letzterSchritt?: number | null
  /** Wie viele Schritte vor/nach dem aktuellen noch gelten (Uhrabweichung des Handys). Standard 1 = ±30 s. */
  fenster?: number
}

/** Prüft einen 6-stelligen Code gegen das Geheimnis. Zeitkonstant im Vergleich, einmal verwendbar. */
export function pruefeTotp(geheimnisBase32: string, code: string, opt: TotpPruefOptionen = {}): TotpPruefung {
  if (!/^\d{6}$/.test(code)) return { gueltig: false }
  const geheimnis = base32Dekodiere(geheimnisBase32)
  const jetzt = totpSchritt(opt.jetztMs)
  const fenster = opt.fenster ?? 1
  const gegeben = Buffer.from(code)

  let treffer: number | null = null
  for (let delta = -fenster; delta <= fenster; delta++) {
    const schritt = jetzt + delta
    if (opt.letzterSchritt != null && schritt <= opt.letzterSchritt) continue
    const erwartet = Buffer.from(hotp(geheimnis, schritt))
    // Alle Schritte vergleichen (nicht beim ersten Treffer abbrechen), damit die Dauer nichts verrät
    if (timingSafeEqual(gegeben, erwartet) && treffer === null) treffer = schritt
  }
  return treffer === null ? { gueltig: false } : { gueltig: true, schritt: treffer }
}
