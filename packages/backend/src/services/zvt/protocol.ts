/**
 * ZVT-Protokoll — minimale Implementation für Hobex/Payroc & kompatible.
 *
 * Paketformat:
 *   [CLA] [INS] [LEN] [DATA...]
 *
 * Wichtigste Befehle:
 *   06 01 — Authorization (Kassa → Terminal): Zahlung starten
 *   06 0F — Completion    (Terminal → Kassa): Erfolg + Detail-TLV
 *   06 1E — Abort         (Terminal → Kassa): Vorgang abgebrochen
 *   06 B0 — Abort         (Kassa → Terminal): Vorgang vom Kassier abbrechen
 *   06 D1 — Print Line    (Terminal → Kassa): Bon-Zeile drucken
 *   04 0F — Status Info   (Terminal → Kassa): Statusmeldung
 *   80 00 — Positive-ACK
 *   84 xx — Negative-ACK
 */

import { Buffer } from 'node:buffer'

export interface ZvtPacket {
  cla:  number
  ins:  number
  data: Buffer
}

/**
 * Liest so viele vollständige Pakete wie möglich aus einem Buffer.
 * Restbytes (unvollständiges Paket) verbleiben.
 */
export function parsePackets(buffer: Buffer): { packets: ZvtPacket[]; rest: Buffer } {
  const packets: ZvtPacket[] = []
  let pos = 0
  while (buffer.length - pos >= 3) {
    const len = buffer[pos + 2]!
    if (buffer.length - pos < 3 + len) break
    packets.push({
      cla:  buffer[pos]!,
      ins:  buffer[pos + 1]!,
      data: buffer.subarray(pos + 3, pos + 3 + len),
    })
    pos += 3 + len
  }
  return { packets, rest: buffer.subarray(pos) }
}

/** 6-Byte BCD-codierter Cent-Betrag, Big-Endian. */
export function encodeBcdAmount(cent: number): Buffer {
  const out = Buffer.alloc(6)
  let v = Math.max(0, Math.floor(cent))
  for (let i = 5; i >= 0; i--) {
    const low  = v % 10; v = Math.floor(v / 10)
    const high = v % 10; v = Math.floor(v / 10)
    out[i] = ((high << 4) | low) & 0xff
  }
  return out
}

/** Authorization-Paket (06 01) mit Betrag + EUR-Währung. */
export function buildAuthorization(betragCent: number, passwort?: string): Buffer {
  const teile: Buffer[] = []
  if (passwort && /^\d{6}$/.test(passwort)) {
    // 3 Byte BCD Passwort (manche Terminals erwarten es)
    const pw = Buffer.alloc(3)
    pw[0] = ((parseInt(passwort[0]!) << 4) | parseInt(passwort[1]!)) & 0xff
    pw[1] = ((parseInt(passwort[2]!) << 4) | parseInt(passwort[3]!)) & 0xff
    pw[2] = ((parseInt(passwort[4]!) << 4) | parseInt(passwort[5]!)) & 0xff
    teile.push(pw)
  }
  // Tag 04 Amount (6 Byte BCD)
  teile.push(Buffer.from([0x04]), encodeBcdAmount(betragCent))
  // Tag 49 Currency = EUR (0978 BCD)
  teile.push(Buffer.from([0x49, 0x09, 0x78]))

  const data = Buffer.concat(teile)
  return Buffer.concat([Buffer.from([0x06, 0x01, data.length]), data])
}

export const PAKET_ACK_POSITIV = Buffer.from([0x80, 0x00, 0x00])
export const PAKET_ABBRUCH     = Buffer.from([0x06, 0xB0, 0x00])

// ---------------------------------------------------------------------------
// Lightweight TLV-Parser für Completion (06 0F)
// — extrahiert was sinnvoll für die UI ist; unbekannte Tags werden geskippt.
// ---------------------------------------------------------------------------

export interface CompletionInfo {
  traceNummer?:   string
  belegnummer?:   string
  kartenmarke?:   string
  autorisierung?: string
}

export function parseCompletion(data: Buffer): CompletionInfo {
  const info: CompletionInfo = {}
  let pos = 0
  while (pos < data.length) {
    const tag = data[pos]!
    pos++
    // Tag-spezifische feste Längen — was wir nicht kennen, skippen wir defensiv
    switch (tag) {
      case 0x27: // Result code
        pos += 1; break
      case 0x04: // Amount
        pos += 6; break
      case 0x49: // Currency
        pos += 2; break
      case 0x29: // Trace number (4 BCD)
        info.traceNummer = bcdToDigits(data.subarray(pos, pos + 4))
        pos += 4; break
      case 0x0B: // Trace number (3 BCD)
        if (!info.traceNummer) info.traceNummer = bcdToDigits(data.subarray(pos, pos + 3))
        pos += 3; break
      case 0x87: // Receipt number (2 BCD)
        info.belegnummer = bcdToDigits(data.subarray(pos, pos + 2))
        pos += 2; break
      case 0x3B: // Date/Time (3 BCD)
        pos += 3; break
      case 0x8A: // Card type code
        pos += 1; break
      case 0x8C: { // Card type name (string, null-terminated oder LL-prefixed)
        const len = data[pos]!
        // Heuristik: Wenn pos+1+len ≤ length und Bytes printable → LL-Form
        if (len < 30 && pos + 1 + len <= data.length) {
          info.kartenmarke = data.subarray(pos + 1, pos + 1 + len).toString('latin1').trim()
          pos += 1 + len
        } else {
          pos += 1
        }
        break
      }
      case 0x60: // Result code (alt)
        pos += 1; break
      default:
        pos += 1  // unbekannt — defensiv 1 Byte überspringen
    }
  }
  return info
}

/** Status-Info-Paket (04 0F) → kurze deutsche Statusmeldung wenn möglich. */
export function statusMeldung(data: Buffer): string | undefined {
  // Erstes Byte ist häufig der Result-Code
  const code = data[0]
  const map: Record<number, string> = {
    0x00: 'Bitte Karte einstecken',
    0x65: 'Karte eingesteckt — PIN-Eingabe',
    0x67: 'Autorisierung läuft',
    0x6C: 'Bitte unterschreiben',
  }
  return code !== undefined ? map[code] : undefined
}

function bcdToDigits(buf: Buffer): string {
  let s = ''
  for (const b of buf) {
    s += String((b >> 4) & 0x0f) + String(b & 0x0f)
  }
  return s
}
