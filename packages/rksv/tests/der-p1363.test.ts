/**
 * Regressionstests für die DER ↔ IEEE-P1363-Signaturkonvertierung.
 *
 * Hintergrund (Produktbug, gefunden über den CI-Flake in see-ausfall.test.ts):
 * DER kodiert die ECDSA-Komponenten r und s minimal. Beginnt eine Komponente
 * mathematisch mit einem Null-Byte, ist ihr INTEGER nur 31 (oder weniger)
 * Bytes lang — das trifft ~1 von 128 Signaturen. Die alte Konvertierung
 * rechnete dann `subarray(31 - 32)` = `subarray(-1)` (zählt vom Ende!) und
 * produzierte eine zerstörte, nie verifizierbare Signatur.
 */

import { describe, it, expect } from 'vitest'
import { generateSEE, signiereRoh, verifiziere, derZuP1363, p1363ZuDer } from '../src/see.js'

/** Baut eine DER-SEQUENCE aus gegebenen r/s-INTEGER-Inhalten (bereits minimal kodiert). */
function baueDer(r: Buffer, s: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ])
}

/** 32-Byte-Puffer, der mit `fuehrendeNullen` 0x00-Bytes beginnt, danach 0xab..., letztes Byte `letztes`. */
function komponente(fuehrendeNullen: number, letztes: number): Buffer {
  const b = Buffer.alloc(32, 0xab)
  b.fill(0x00, 0, fuehrendeNullen)
  b[31] = letztes
  // High-Bit des ersten Nicht-Null-Bytes löschen, damit die minimale
  // DER-Kodierung KEIN 0x00-Padding braucht (0xab → 0x2b)
  if (fuehrendeNullen < 32) b[fuehrendeNullen] = 0x2b
  return b
}

/** Minimale DER-INTEGER-Kodierung eines 32-Byte-P1363-Werts. */
function minimalDerInteger(v32: Buffer): Buffer {
  let start = 0
  while (start < 31 && v32[start] === 0) start++
  const trimmed = v32.subarray(start)
  return (trimmed[0]! & 0x80) ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed
}

describe('derZuP1363 — minimale DER-INTEGER (führende Null-Bytes)', () => {
  const faelle: Array<{ name: string; rNullen: number; sNullen: number }> = [
    { name: 'r und s voll (32 Byte)',            rNullen: 0, sNullen: 0 },
    { name: 'r mit 1 führenden Null-Byte (31)',  rNullen: 1, sNullen: 0 },
    { name: 's mit 1 führenden Null-Byte (31)',  rNullen: 0, sNullen: 1 },
    { name: 'r mit 2 führenden Null-Bytes (30)', rNullen: 2, sNullen: 0 },
    { name: 'r UND s verkürzt',                  rNullen: 1, sNullen: 3 },
  ]

  for (const f of faelle) {
    it(f.name, () => {
      const rVoll = komponente(f.rNullen, 0x11)
      const sVoll = komponente(f.sNullen, 0x22)
      const der   = baueDer(minimalDerInteger(rVoll), minimalDerInteger(sVoll))

      const p1363 = derZuP1363(der)
      expect(p1363.length).toBe(64)
      // Rechtsbündig gepaddet: exakt die ursprünglichen 32-Byte-Komponenten
      expect(p1363.subarray(0, 32).equals(rVoll)).toBe(true)
      expect(p1363.subarray(32, 64).equals(sVoll)).toBe(true)
    })
  }

  it('33-Byte-INTEGER (0x00-Vorzeichen-Padding bei gesetztem High-Bit) wird gestrippt', () => {
    const rVoll = Buffer.alloc(32, 0xab) // 0xab: High-Bit gesetzt → DER paddet
    const sVoll = Buffer.alloc(32, 0xcd)
    const der   = baueDer(
      Buffer.concat([Buffer.from([0x00]), rVoll]),
      Buffer.concat([Buffer.from([0x00]), sVoll]),
    )
    const p1363 = derZuP1363(der)
    expect(p1363.subarray(0, 32).equals(rVoll)).toBe(true)
    expect(p1363.subarray(32, 64).equals(sVoll)).toBe(true)
  })

  it('Roundtrip p1363ZuDer(derZuP1363(der)) reproduziert die minimale DER-Kodierung', () => {
    for (const [rN, sN] of [[0, 0], [1, 0], [0, 1], [2, 2]] as const) {
      const der = baueDer(
        minimalDerInteger(komponente(rN, 0x33)),
        minimalDerInteger(komponente(sN, 0x44)),
      )
      expect(p1363ZuDer(derZuP1363(der)).equals(der)).toBe(true)
    }
  })
})

describe('signiereRoh + verifiziere — Ende-zu-Ende über viele Signaturen', () => {
  it('1500 Signaturen verifizieren ausnahmslos (deckt kurze r/s-Komponenten statistisch ab)', async () => {
    const see = await generateSEE({
      kassenId:   'DER-P1363-KASSE',
      uid:        'ATU12345678',
      firmenname: 'Konvertierungs GmbH',
    })

    let kurzeKomponenten = 0
    for (let i = 0; i < 1500; i++) {
      const daten = `_R1-AT0_DER-P1363-KASSE_${i}_2026-07-26T10:00:00_0,00_0,00_0,00_0,00_0,00_x_y_z`
      const sig   = signiereRoh(daten, see)
      expect(sig.length).toBe(64)
      if (sig[0] === 0 || sig[32] === 0) kurzeKomponenten++
      if (!verifiziere(daten, sig, see.zertifikatDER)) {
        throw new Error(
          `Signatur ${i} verifiziert nicht (r[0]=${sig[0]}, s[0]=${sig[32]}) — DER↔P1363-Konvertierung defekt?`,
        )
      }
    }
    // Statistik-Log: bei 1500 Signaturen sind im Mittel ~11 Komponenten verkürzt.
    // Kein hartes Assert (Restwahrscheinlichkeit 0 wäre ein neuer Mini-Flake) —
    // die deterministischen DER-Fixtures oben garantieren die Fallabdeckung.
    console.info(`kurze r/s-Komponenten in 1500 Signaturen: ${kurzeKomponenten}`)
  })
})
