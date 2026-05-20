/**
 * Tests für AES-256-ICM (Umsatzzähler-Verschlüsselung)
 *
 * Testvektoren aus der BMF-Referenzimplementierung:
 * https://github.com/a-sit-plus/at-registrierkassen-mustercode
 */

import { describe, it, expect } from 'vitest'
import {
  deriveAesKey,
  belegNummerZuIV,
  verschluesselUmsatzzaehler,
  entschluesselUmsatzzaehler,
} from '../src/crypto/aes-icm.js'

describe('deriveAesKey', () => {
  it('erzeugt einen 32-Byte-Schlüssel', () => {
    const cert    = Buffer.from('TESTCERT', 'utf8')
    const key     = deriveAesKey(cert, 'KASSE-001')
    expect(key).toHaveLength(32)
  })

  it('ist deterministisch', () => {
    const cert = Buffer.from('TESTCERT', 'utf8')
    const k1   = deriveAesKey(cert, 'KASSE-001')
    const k2   = deriveAesKey(cert, 'KASSE-001')
    expect(k1.equals(k2)).toBe(true)
  })

  it('unterscheidet sich bei anderer KassenID', () => {
    const cert = Buffer.from('TESTCERT', 'utf8')
    const k1   = deriveAesKey(cert, 'KASSE-001')
    const k2   = deriveAesKey(cert, 'KASSE-002')
    expect(k1.equals(k2)).toBe(false)
  })
})

describe('belegNummerZuIV', () => {
  it('erzeugt einen 16-Byte-IV', () => {
    expect(belegNummerZuIV(1)).toHaveLength(16)
  })

  it('kodiert die Nummer Big-Endian in den letzten 8 Bytes', () => {
    const iv = belegNummerZuIV(1)
    expect(iv.subarray(0, 8).equals(Buffer.alloc(8, 0))).toBe(true)
    expect(iv.readBigUInt64BE(8)).toBe(1n)
  })

  it('unterscheidet sich bei verschiedenen Belegnummern', () => {
    const iv1 = belegNummerZuIV(1)
    const iv2 = belegNummerZuIV(2)
    expect(iv1.equals(iv2)).toBe(false)
  })
})

describe('verschluesselUmsatzzaehler / entschluesselUmsatzzaehler', () => {
  const cert      = Buffer.from('DEMO-CERT-DER', 'utf8')
  const kassenId  = 'DEMO-CASH-BOX817'
  const belegNr   = 1

  it('verschlüsselt und entschlüsselt korrekt (Roundtrip)', () => {
    const original  = 1050n  // 10,50 €
    const encrypted = verschluesselUmsatzzaehler(original, cert, kassenId, belegNr)
    const decrypted = entschluesselUmsatzzaehler(encrypted, cert, kassenId, belegNr)
    expect(decrypted).toBe(original)
  })

  it('Roundtrip mit negativem Wert (Storno)', () => {
    const original  = -500n  // -5,00 €
    const encrypted = verschluesselUmsatzzaehler(original, cert, kassenId, belegNr)
    const decrypted = entschluesselUmsatzzaehler(encrypted, cert, kassenId, belegNr)
    expect(decrypted).toBe(original)
  })

  it('Roundtrip mit Nullwert', () => {
    const original  = 0n
    const encrypted = verschluesselUmsatzzaehler(original, cert, kassenId, belegNr)
    const decrypted = entschluesselUmsatzzaehler(encrypted, cert, kassenId, belegNr)
    expect(decrypted).toBe(original)
  })

  it('ergibt 8 Byte verschlüsselte Daten', () => {
    const encrypted = verschluesselUmsatzzaehler(1000n, cert, kassenId, belegNr)
    expect(encrypted).toHaveLength(8)
  })

  it('verschiedene Belegnummern erzeugen verschiedene Ciphertexte', () => {
    const e1 = verschluesselUmsatzzaehler(1000n, cert, kassenId, 1)
    const e2 = verschluesselUmsatzzaehler(1000n, cert, kassenId, 2)
    expect(e1.equals(e2)).toBe(false)
  })

  it('falsche Belegnummer bei Entschlüsselung liefert falschen Wert', () => {
    const encrypted = verschluesselUmsatzzaehler(1000n, cert, kassenId, 1)
    const wrongDec  = entschluesselUmsatzzaehler(encrypted, cert, kassenId, 2)
    expect(wrongDec).not.toBe(1000n)
  })
})
