/**
 * Tests für AES-256-ICM (Umsatzzähler-Verschlüsselung, BMF-Detailspezifikation):
 * eigenständiger 32-Byte-Schlüssel, IV = erste 16 Byte SHA-256(kassenId ‖ belegNummer).
 */

import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  generiereAesSchluessel,
  berechneIV,
  verschluesselUmsatzzaehler,
  entschluesselUmsatzzaehler,
} from '../src/crypto/aes-icm.js'

describe('generiereAesSchluessel', () => {
  it('erzeugt einen 32-Byte-Schlüssel', () => {
    expect(generiereAesSchluessel()).toHaveLength(32)
  })

  it('erzeugt bei jedem Aufruf einen anderen Schlüssel', () => {
    expect(generiereAesSchluessel().equals(generiereAesSchluessel())).toBe(false)
  })
})

describe('berechneIV', () => {
  it('entspricht den ersten 16 Byte von SHA-256(kassenId + belegNummer)', () => {
    const erwartet = createHash('sha256').update('KASSE-001' + '42', 'utf8').digest().subarray(0, 16)
    expect(berechneIV('KASSE-001', 42).equals(erwartet)).toBe(true)
  })

  it('erzeugt einen 16-Byte-IV', () => {
    expect(berechneIV('KASSE-001', 1)).toHaveLength(16)
  })

  it('unterscheidet sich bei verschiedenen Belegnummern', () => {
    expect(berechneIV('KASSE-001', 1).equals(berechneIV('KASSE-001', 2))).toBe(false)
  })

  it('unterscheidet sich bei anderer Kassen-ID', () => {
    expect(berechneIV('KASSE-001', 1).equals(berechneIV('KASSE-002', 1))).toBe(false)
  })
})

describe('verschluesselUmsatzzaehler / entschluesselUmsatzzaehler', () => {
  const key = generiereAesSchluessel()

  it('verschlüsselt und entschlüsselt korrekt (Roundtrip)', () => {
    const enc = verschluesselUmsatzzaehler(123456n, key, 'KASSE-001', 7)
    expect(entschluesselUmsatzzaehler(enc, key, 'KASSE-001', 7)).toBe(123456n)
  })

  it('Roundtrip mit negativem Wert (Storno)', () => {
    const enc = verschluesselUmsatzzaehler(-9999n, key, 'KASSE-001', 8)
    expect(entschluesselUmsatzzaehler(enc, key, 'KASSE-001', 8)).toBe(-9999n)
  })

  it('Roundtrip mit Nullwert', () => {
    const enc = verschluesselUmsatzzaehler(0n, key, 'KASSE-001', 1)
    expect(entschluesselUmsatzzaehler(enc, key, 'KASSE-001', 1)).toBe(0n)
  })

  it('ergibt 8 Byte verschlüsselte Daten (BASE64_STD: 12 Zeichen)', () => {
    const enc = verschluesselUmsatzzaehler(555n, key, 'KASSE-001', 3)
    expect(enc).toHaveLength(8)
    // Wie der Referenz-Beleg des BMF-Mustercodes: z. B. "4BMxCg==" (8 Byte → 12 Zeichen)
    expect(enc.toString('base64')).toHaveLength(12)
  })

  it('verschiedene Belegnummern erzeugen verschiedene Ciphertexte', () => {
    const a = verschluesselUmsatzzaehler(100n, key, 'KASSE-001', 1)
    const b = verschluesselUmsatzzaehler(100n, key, 'KASSE-001', 2)
    expect(a.equals(b)).toBe(false)
  })

  it('falscher Schlüssel bei Entschlüsselung liefert falschen Wert', () => {
    const enc = verschluesselUmsatzzaehler(777n, key, 'KASSE-001', 5)
    expect(entschluesselUmsatzzaehler(enc, generiereAesSchluessel(), 'KASSE-001', 5)).not.toBe(777n)
  })

  it('falsche Belegnummer bei Entschlüsselung liefert falschen Wert', () => {
    const enc = verschluesselUmsatzzaehler(777n, key, 'KASSE-001', 5)
    expect(entschluesselUmsatzzaehler(enc, key, 'KASSE-001', 6)).not.toBe(777n)
  })
})
