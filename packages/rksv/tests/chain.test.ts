/**
 * Tests für den RKSV-Verkettungswert (BMF-Detailspezifikation):
 * BASE64_STD( erste 8 Byte von SHA-256(Input) );
 * Startbeleg-Input = Kassen-ID, Folgebeleg-Input = Vorbeleg-Code.
 */

import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  verkettungswertStartbeleg,
  verkettungswertFolgebeleg,
  pruefeKette,
} from '../src/crypto/chain.js'

/**
 * Referenz-Beleg aus dem BMF-Mustercode (Issue #385) — dient als Fixture
 * für Format-Eigenschaften des Verkettungswerts (8 Byte, Standard-Base64).
 */
const REFERENZ_VERKETTUNGSWERT = 'cg8hNU5ihto='

describe('verkettungswertStartbeleg', () => {
  it('ist deterministisch', () => {
    expect(verkettungswertStartbeleg('KASSE-1')).toBe(verkettungswertStartbeleg('KASSE-1'))
  })

  it('entspricht BASE64_STD der ersten 8 Byte von SHA-256(kassenId)', () => {
    const kassenId = 'DEMO-CASH-BOX'
    const erwartet = createHash('sha256').update(kassenId, 'utf8').digest().subarray(0, 8).toString('base64')
    expect(verkettungswertStartbeleg(kassenId)).toBe(erwartet)
  })

  it('hat das Referenz-Format: 12 Zeichen Standard-Base64 mit Padding (8 Byte)', () => {
    const wert = verkettungswertStartbeleg('KASSE-1')
    expect(wert).toHaveLength(REFERENZ_VERKETTUNGSWERT.length) // 12
    expect(wert.endsWith('=')).toBe(true)
    expect(wert).toMatch(/^[A-Za-z0-9+/]+=$/)                  // Standard-Base64, KEIN base64url
    expect(Buffer.from(wert, 'base64')).toHaveLength(8)
  })

  it('unterscheidet sich je Kassen-ID', () => {
    expect(verkettungswertStartbeleg('KASSE-1')).not.toBe(verkettungswertStartbeleg('KASSE-2'))
  })
})

describe('verkettungswertFolgebeleg', () => {
  it('hasht den kompletten Vorbeleg-Code', () => {
    const code = '_R1-AT0_KASSE-1_1_2026-01-01T10:00:00_0,00_0,00_0,00_0,00_0,00_QUJDREVGR0g=_1A2B_abcdefgh_c2ln'
    const erwartet = createHash('sha256').update(code, 'utf8').digest().subarray(0, 8).toString('base64')
    expect(verkettungswertFolgebeleg(code)).toBe(erwartet)
  })

  it('unterschiedliche Eingaben → unterschiedliche Ausgaben', () => {
    expect(verkettungswertFolgebeleg('code-a')).not.toBe(verkettungswertFolgebeleg('code-b'))
  })

  it('unterscheidet sich vom Startbeleg-Wert derselben Zeichenkette nicht (gleiche Funktion, gleicher Input)', () => {
    // Start- und Folgewert nutzen dieselbe Hash-Konstruktion — nur der Input unterscheidet sie
    expect(verkettungswertFolgebeleg('KASSE-1')).toBe(verkettungswertStartbeleg('KASSE-1'))
  })
})

describe('pruefeKette', () => {
  const KASSE = 'KETTE-KASSE-1'

  /** Baut eine synthetische, korrekt verkettete Belegfolge. */
  function baueKette(anzahl: number): { maschinenlesbareCode: string; sigVorbeleg: string }[] {
    const belege: { maschinenlesbareCode: string; sigVorbeleg: string }[] = []
    for (let i = 0; i < anzahl; i++) {
      const vorheriger = belege[i - 1]
      const sigVorbeleg = vorheriger === undefined
        ? verkettungswertStartbeleg(KASSE)
        : verkettungswertFolgebeleg(vorheriger.maschinenlesbareCode)
      belege.push({
        maschinenlesbareCode: `_R1-AT0_${KASSE}_${i + 1}_2026-01-01T10:00:0${i}_0,00_0,00_0,00_0,00_0,00_enc${i}=_SN_${sigVorbeleg}_sig${i}`,
        sigVorbeleg,
      })
    }
    return belege
  }

  it('leere Liste ist gültig', () => {
    expect(pruefeKette(KASSE, [])).toBe(true)
  })

  it('valide Kette mit einem Beleg', () => {
    expect(pruefeKette(KASSE, baueKette(1))).toBe(true)
  })

  it('valide Kette mit fünf Belegen', () => {
    expect(pruefeKette(KASSE, baueKette(5))).toBe(true)
  })

  it('erkennt falschen Startbeleg-Verkettungswert (falsche Kassen-ID)', () => {
    const kette = baueKette(2)
    expect(pruefeKette('ANDERE-KASSE', kette)).toBe(false)
  })

  it('erkennt manipulierten Vorbeleg-Code (Kettenbruch)', () => {
    const kette = baueKette(3)
    const zweiter = kette[1]!
    kette[1] = { ...zweiter, maschinenlesbareCode: zweiter.maschinenlesbareCode.replace('0,00', '9,99') }
    expect(pruefeKette(KASSE, kette)).toBe(false)
  })

  it('erkennt manipulierten Verkettungswert', () => {
    const kette = baueKette(3)
    const dritter = kette[2]!
    kette[2] = { ...dritter, sigVorbeleg: verkettungswertStartbeleg('FALSCH') }
    expect(pruefeKette(KASSE, kette)).toBe(false)
  })
})
