/**
 * Tests für SHA-256-Chaining (SigVorbeleg-Berechnung)
 */

import { describe, it, expect } from 'vitest'
import {
  startbelegVorSignatur,
  folgebelegVorSignatur,
  pruefeKette,
} from '../src/crypto/chain.js'

describe('startbelegVorSignatur', () => {
  it('ist deterministisch', () => {
    expect(startbelegVorSignatur()).toBe(startbelegVorSignatur())
  })

  it('ist ein gültiger base64url-String', () => {
    const val = startbelegVorSignatur()
    expect(val).toMatch(/^[A-Za-z0-9_-]+=*$/)
  })

  it('entspricht SHA-256 von 32 Null-Bytes (BMF-Spezifikation)', () => {
    // SHA-256(0x00 × 32) = 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
    // base64url davon:
    const erwartet = Buffer
      .from('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925', 'hex')
      .toString('base64url')
    expect(startbelegVorSignatur()).toBe(erwartet)
  })
})

describe('folgebelegVorSignatur', () => {
  it('erzeugt konsistente Werte', () => {
    const sigVor = 'abc123def456'
    expect(folgebelegVorSignatur(sigVor)).toBe(folgebelegVorSignatur(sigVor))
  })

  it('unterscheidet sich vom Startbeleg-Wert', () => {
    const start = startbelegVorSignatur()
    const folge = folgebelegVorSignatur('irgendeinWert')
    expect(start).not.toBe(folge)
  })

  it('unterschiedliche Eingaben → unterschiedliche Ausgaben', () => {
    const f1 = folgebelegVorSignatur('sig1')
    const f2 = folgebelegVorSignatur('sig2')
    expect(f1).not.toBe(f2)
  })
})

describe('pruefeKette', () => {
  it('leere Liste ist gültig', () => {
    expect(pruefeKette([])).toBe(true)
  })

  it('valide Kette mit einem Beleg', () => {
    const sig = 'ersteSig'
    const kette = [{ signaturwert: sig, sigVorbeleg: startbelegVorSignatur() }]
    expect(pruefeKette(kette)).toBe(true)
  })

  it('valide Kette mit zwei Belegen', () => {
    const sig1 = 'ersterSignaturwert'
    const sig2 = 'zweiterSignaturwert'
    const kette = [
      { signaturwert: sig1, sigVorbeleg: startbelegVorSignatur() },
      { signaturwert: sig2, sigVorbeleg: folgebelegVorSignatur(sig1) },
    ]
    expect(pruefeKette(kette)).toBe(true)
  })

  it('erkennt falschen Startbeleg-SigVorbeleg', () => {
    const kette = [{ signaturwert: 'sig', sigVorbeleg: 'falscherWert' }]
    expect(pruefeKette(kette)).toBe(false)
  })

  it('erkennt unterbrochene Kette', () => {
    const sig1 = 'sig1'
    const kette = [
      { signaturwert: sig1, sigVorbeleg: startbelegVorSignatur() },
      { signaturwert: 'sig2', sigVorbeleg: 'nichtKorrektAbgeleitet' },
    ]
    expect(pruefeKette(kette)).toBe(false)
  })

  it('valide Kette mit drei Belegen', () => {
    const s1 = 'sigA', s2 = 'sigB', s3 = 'sigC'
    const kette = [
      { signaturwert: s1, sigVorbeleg: startbelegVorSignatur() },
      { signaturwert: s2, sigVorbeleg: folgebelegVorSignatur(s1) },
      { signaturwert: s3, sigVorbeleg: folgebelegVorSignatur(s2) },
    ]
    expect(pruefeKette(kette)).toBe(true)
  })
})
