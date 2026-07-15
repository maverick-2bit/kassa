/**
 * ESC/POS Low-Level-Befehle.
 *
 * Spezifikation: Epson ESC/POS Command Reference
 *   - ESC = 0x1B (Escape)
 *   - GS  = 0x1D (Group Separator)
 *   - LF  = 0x0A (Line Feed)
 *
 * Unterstützt von praktisch allen Thermo-Bondruckern (Epson TM-Reihe, Star TSP,
 * Bixolon, Citizen, Sewoo etc.).
 */

import { Buffer } from 'node:buffer'

export const ESC = 0x1B
export const GS  = 0x1D
export const LF  = 0x0A

/** Drucker initialisieren — alle Einstellungen zurücksetzen */
export function init(): Buffer {
  return Buffer.from([ESC, 0x40])
}

/** Zeichensatz wählen (Codepage)
 *   0  = CP437 (USA, Standard)
 *   2  = CP850 (Multilingual)
 *  19  = CP858 (Multilingual + €)
 */
export function selectCodepage(n: number): Buffer {
  return Buffer.from([ESC, 0x74, n])
}

/** Internationalen Zeichensatz wählen (n=2 = Deutsch) */
export function selectInternational(n: number): Buffer {
  return Buffer.from([ESC, 0x52, n])
}

/** Ausrichtung: 0=links, 1=mittig, 2=rechts */
export function align(mode: 'left' | 'center' | 'right'): Buffer {
  const n = mode === 'left' ? 0 : mode === 'center' ? 1 : 2
  return Buffer.from([ESC, 0x61, n])
}

/** Zeichensatz-Stil (Bits können kombiniert werden) */
export interface FontOptions {
  bold?:         boolean
  doubleHeight?: boolean
  doubleWidth?:  boolean
  underline?:    boolean
}

export function font(opts: FontOptions = {}): Buffer {
  let n = 0
  if (opts.bold)         n |= 0b0000_1000
  if (opts.doubleHeight) n |= 0b0001_0000
  if (opts.doubleWidth)  n |= 0b0010_0000
  if (opts.underline)    n |= 0b1000_0000
  return Buffer.from([ESC, 0x21, n])
}

/** Fettdruck an/aus (alternativ zu font()) */
export function bold(on: boolean): Buffer {
  return Buffer.from([ESC, 0x45, on ? 1 : 0])
}

/** Newline */
export function newline(n = 1): Buffer {
  return Buffer.from(Array(n).fill(LF))
}

/** Drucker schneiden (Papier-Schnitt) mit ausreichendem Vorschub.
 *  WICHTIG: Bei der TM-T20IV sitzt der Druckkopf ~12–13 mm VOR dem Messer.
 *  Wird zu wenig vorgeschoben, bleibt das Bon-Ende im Gerät stecken (der Bon
 *  „kommt nicht raus"). Darum erst 4 Zeilen (~17 mm) vorschieben, dann Teil-Schnitt
 *  (GS V 66 0). GS V 66 n zählt n in PUNKTEN, nicht Zeilen — daher explizite LFs. */
export function cut(): Buffer {
  return Buffer.concat([newline(4), Buffer.from([GS, 0x56, 0x42, 0])])
}

/** Kassalade öffnen (Drawer-Kick auf Pin 2 oder 5) */
export function kickDrawer(pin: 2 | 5 = 2): Buffer {
  // ESC p m t1 t2 — m=0 → Pin 2, m=1 → Pin 5
  return Buffer.from([ESC, 0x70, pin === 2 ? 0 : 1, 25, 250])
}

// ---------------------------------------------------------------------------
// QR-Code (GS ( k mit Funktionsnummer 49)
// ---------------------------------------------------------------------------

/**
 * QR-Code drucken.
 * @param data    Inhalt (max. ~7000 Zeichen für H-Level)
 * @param size    Modulgröße 1..16 (typisch 4–8, default 6)
 * @param errLevel  L/M/Q/H Fehlerkorrektur (default L)
 */
export function qrCode(
  data:     string,
  size:     number = 6,
  errLevel: 'L' | 'M' | 'Q' | 'H' = 'L',
): Buffer {
  const errMap = { L: 48, M: 49, Q: 50, H: 51 } as const

  // (1) Modell: GS ( k 4 0 49 65 50 0 → Modell 2
  const model = Buffer.from([GS, 0x28, 0x6B, 4, 0, 49, 65, 50, 0])
  // (2) Modulgröße: GS ( k 3 0 49 67 n
  const sizeBuf = Buffer.from([GS, 0x28, 0x6B, 3, 0, 49, 67, size])
  // (3) Fehlerkorrektur: GS ( k 3 0 49 69 n
  const ecLevel = Buffer.from([GS, 0x28, 0x6B, 3, 0, 49, 69, errMap[errLevel]])
  // (4) Daten speichern: GS ( k pL pH 49 80 48 d1...dn
  const dataBytes = Buffer.from(data, 'utf-8')
  const dataLen   = dataBytes.length + 3
  const pL        = dataLen & 0xFF
  const pH        = (dataLen >> 8) & 0xFF
  const store     = Buffer.concat([
    Buffer.from([GS, 0x28, 0x6B, pL, pH, 49, 80, 48]),
    dataBytes,
  ])
  // (5) Drucken: GS ( k 3 0 49 81 48
  const print = Buffer.from([GS, 0x28, 0x6B, 3, 0, 49, 81, 48])

  return Buffer.concat([model, sizeBuf, ecLevel, store, print])
}

// ---------------------------------------------------------------------------
// Text-Encoding für deutsche Umlaute (CP858)
// ---------------------------------------------------------------------------

const CP858_MAP: Record<string, number> = {
  'ä': 0x84, 'ö': 0x94, 'ü': 0x81, 'ß': 0xE1,
  'Ä': 0x8E, 'Ö': 0x99, 'Ü': 0x9A,
  '€': 0xD5,
  'á': 0xA0, 'é': 0x82, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3, 'ñ': 0xA4,
  '°': 0xF8,
}

/**
 * Kodiert einen UTF-8-String nach CP858.
 * Nicht-darstellbare Zeichen werden durch '?' ersetzt.
 */
export function encodeText(s: string): Buffer {
  const bytes: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) {
      bytes.push(cp)
    } else if (CP858_MAP[ch] !== undefined) {
      bytes.push(CP858_MAP[ch])
    } else {
      bytes.push(0x3F) // ?
    }
  }
  return Buffer.from(bytes)
}

/** Convenience: encodeText + newline */
export function textLine(s: string): Buffer {
  return Buffer.concat([encodeText(s), Buffer.from([LF])])
}
