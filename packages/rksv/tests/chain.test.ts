/**
 * Tests für den RKSV-Verkettungswert (RKSV Anlage 1 Z 4/Z 6, BMF-Detailspezifikation):
 * BASE64_STD( erste 8 Byte von SHA-256(Input) );
 * Startbeleg-Input = Kassen-ID, Folgebeleg-Input = JWS-Compact-Form des Vorbelegs.
 *
 * Diese Tests rechnen mit derselben Lesart wie der Produktivcode. Dass die Lesart stimmt, beweisen nur Daten, die ein
 * anderer erzeugt hat: bmf-referenz.test.ts (BMF-Mustercode, 1284 Folgebelege) und die externen Prüfer.
 */

import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  verkettungswertStartbeleg,
  verkettungswertFolgebeleg,
  verkettungswertAusJwsCompact,
  pruefeKette,
  analysiereKette,
} from '../src/crypto/chain.js'
import { JWS_HEADER_B64URL, qrCodeZuJwsCompact } from '../src/crypto/jws.js'
import { SEE_AUSFALL_SIGNATUR } from '../src/beleg.js'

/**
 * Referenz-Beleg aus dem BMF-Mustercode (Issue #385) — dient als Fixture
 * für Format-Eigenschaften des Verkettungswerts (8 Byte, Standard-Base64).
 */
const REFERENZ_VERKETTUNGSWERT = 'cg8hNU5ihto='

const sha8 = (eingabe: string): string =>
  createHash('sha256').update(eingabe, 'utf8').digest().subarray(0, 8).toString('base64')

/** QR-Code mit Standard-Base64-Signatur (`+`, `/`, `=` kommen vor — in der JWS-Form base64url ohne Padding). */
const QR_CODE = '_R1-AT0_KASSE-1_1_2026-01-01T10:00:00_0,00_0,00_0,00_0,00_0,00_QUJDREVGR0g=_1A2B_abcdefgh=_+/+/Pz8/Pz4+Pj4='

describe('verkettungswertStartbeleg', () => {
  it('ist deterministisch', () => {
    expect(verkettungswertStartbeleg('KASSE-1')).toBe(verkettungswertStartbeleg('KASSE-1'))
  })

  it('entspricht BASE64_STD der ersten 8 Byte von SHA-256(kassenId)', () => {
    const kassenId = 'DEMO-CASH-BOX'
    expect(verkettungswertStartbeleg(kassenId)).toBe(sha8(kassenId))
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

describe('verkettungswertAusJwsCompact', () => {
  it('hasht die JWS-Compact-Form des Vorbelegs unverändert', () => {
    const jws = qrCodeZuJwsCompact(QR_CODE)
    expect(verkettungswertAusJwsCompact(jws)).toBe(sha8(jws))
  })

  it('unterschiedliche Eingaben → unterschiedliche Ausgaben', () => {
    expect(verkettungswertAusJwsCompact('a.b.c')).not.toBe(verkettungswertAusJwsCompact('a.b.d'))
  })

  it('unterscheidet sich vom Startbeleg-Wert derselben Zeichenkette nicht (gleiche Hash-Konstruktion, nur der Input unterscheidet sie)', () => {
    expect(verkettungswertAusJwsCompact('KASSE-1')).toBe(verkettungswertStartbeleg('KASSE-1'))
  })
})

describe('verkettungswertFolgebeleg (Eingabe: gespeicherter QR-Code des Vorbelegs)', () => {
  it('rechnet den QR-Code in die JWS-Compact-Form um und hasht diese', () => {
    const jws = qrCodeZuJwsCompact(QR_CODE)
    expect(jws.split('.')).toHaveLength(3)
    expect(jws.startsWith(`${JWS_HEADER_B64URL}.`)).toBe(true)
    expect(verkettungswertFolgebeleg(QR_CODE)).toBe(sha8(jws))
    expect(verkettungswertFolgebeleg(QR_CODE)).toBe(verkettungswertAusJwsCompact(jws))
  })

  it('ist NICHT der Hash des QR-Codes (so hat die Kassa vor der Korrektur verkettet — Befund A)', () => {
    expect(verkettungswertFolgebeleg(QR_CODE)).not.toBe(sha8(QR_CODE))
  })

  it('JWS-Signaturteil ist base64url (kein Padding, kein + oder /)', () => {
    const signaturteil = qrCodeZuJwsCompact(QR_CODE).split('.')[2]!
    expect(signaturteil).toBe(Buffer.from('+/+/Pz8/Pz4+Pj4=', 'base64').toString('base64url'))
    expect(signaturteil).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('Ausfall-Beleg als Vorbeleg: der Marker „Sicherheitseinrichtung ausgefallen" steht base64url im Signaturteil', () => {
    const ausfall = `_R1-AT0_KASSE-1_2_2026-01-01T10:05:00_0,00_0,00_0,00_0,00_0,00_QUJDREVGR0g=_1A2B_abcdefgh=_${SEE_AUSFALL_SIGNATUR}`
    const erwartet = [
      JWS_HEADER_B64URL,
      Buffer.from(ausfall.slice(0, ausfall.lastIndexOf('_')), 'utf8').toString('base64url'),
      Buffer.from('Sicherheitseinrichtung ausgefallen', 'utf8').toString('base64url'),
    ].join('.')
    expect(verkettungswertFolgebeleg(ausfall)).toBe(sha8(erwartet))
  })
})

const KASSE = 'KETTE-KASSE-1'

type Form = 'spez' | 'alt'
type KetteBeleg = { maschinenlesbareCode: string; sigVorbeleg: string }

/**
 * Baut eine synthetische Belegfolge (Codes in QR-Form, wie sie gespeichert werden). `form(i)` bestimmt, wie Beleg i (ab 1) mit seinem
 * Vorgänger verkettet ist: 'spez' = JWS-Form nach Spezifikation, 'alt' = Hash des QR-Codes (Programmversionen vor der Korrektur).
 */
function baueKette(anzahl: number, form: (i: number) => Form = () => 'spez', signatur = (i: number) => Buffer.from(`signatur-${i}`, 'utf8').toString('base64')): KetteBeleg[] {
  const belege: KetteBeleg[] = []
  for (let i = 0; i < anzahl; i++) {
    const vorheriger = belege[i - 1]
    const sigVorbeleg = vorheriger === undefined
      ? verkettungswertStartbeleg(KASSE)
      : form(i) === 'alt' ? sha8(vorheriger.maschinenlesbareCode) : verkettungswertFolgebeleg(vorheriger.maschinenlesbareCode)
    belege.push({
      maschinenlesbareCode: `_R1-AT0_${KASSE}_${i + 1}_2026-01-01T10:00:${String(i).padStart(2, '0')}_0,00_0,00_0,00_0,00_0,00_enc${i}=_SN_${sigVorbeleg}_${signatur(i)}`,
      sigVorbeleg,
    })
  }
  return belege
}

describe('pruefeKette', () => {
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

  it('erkennt manipulierten Signaturwert des Vorbelegs (er geht in die JWS-Form ein)', () => {
    const kette = baueKette(3)
    const zweiter = kette[1]!
    const idx = zweiter.maschinenlesbareCode.lastIndexOf('_')
    kette[1] = { ...zweiter, maschinenlesbareCode: `${zweiter.maschinenlesbareCode.slice(0, idx)}_${Buffer.from('gefaelscht').toString('base64')}` }
    expect(pruefeKette(KASSE, kette)).toBe(false)
  })

  it('erkennt manipulierten Verkettungswert', () => {
    const kette = baueKette(3)
    const dritter = kette[2]!
    kette[2] = { ...dritter, sigVorbeleg: verkettungswertStartbeleg('FALSCH') }
    expect(pruefeKette(KASSE, kette)).toBe(false)
  })

  it('die alte Lesart (Hash des QR-Codes statt der JWS-Form) ist keine gültige Verkettung mehr', () => {
    const alt = baueKette(3, () => 'alt')                              // wie vor der Korrektur: QR-Code gehasht
    expect(alt[0]!.sigVorbeleg).toBe(verkettungswertStartbeleg(KASSE)) // der Startbeleg war immer richtig
    expect(pruefeKette(KASSE, alt.slice(0, 1))).toBe(true)
    expect(pruefeKette(KASSE, alt)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// analysiereKette — bestehende Ketten erkennen (Altform vor der Korrektur), echte Brüche weiter melden
// ---------------------------------------------------------------------------------------------------------------------
describe('analysiereKette', () => {
  const sauber = { ok: true, altformat: 0, ersterAltformatIndex: null, letzterAltformatIndex: null, gemischt: false, ersterBruchIndex: null }

  it('leere Folge und der Startbeleg allein: in Ordnung, kein Altformat', () => {
    expect(analysiereKette(KASSE, [])).toEqual(sauber)
    expect(analysiereKette(KASSE, baueKette(1))).toEqual(sauber)
  })

  it('Kette nach Spezifikation: in Ordnung, kein Altformat (wie pruefeKette)', () => {
    const kette = baueKette(6)
    expect(analysiereKette(KASSE, kette)).toEqual(sauber)
    expect(pruefeKette(KASSE, kette)).toBe(true)
  })

  it('Bestandskasse nach dem Update: Belege 2…5 im Altformat, ab Beleg 6 nach Spezifikation — in Ordnung, Altstrecke ausgewiesen', () => {
    const kette = baueKette(9, i => (i <= 4 ? 'alt' : 'spez'))        // Index 1…4 = Belege 2…5
    expect(analysiereKette(KASSE, kette)).toEqual({ ...sauber, altformat: 4, ersterAltformatIndex: 1, letzterAltformatIndex: 4 })
    expect(pruefeKette(KASSE, kette)).toBe(false)                     // streng nach Spezifikation ist die Altstrecke keine Verkettung
  })

  it('der Übergang ist nahtlos: der erste Beleg nach der Korrektur stimmt auf einen alt verketteten Vorgänger', () => {
    const kette = baueKette(6, i => (i <= 3 ? 'alt' : 'spez'))
    expect(kette[4]!.sigVorbeleg).toBe(verkettungswertFolgebeleg(kette[3]!.maschinenlesbareCode))
    expect(kette[3]!.sigVorbeleg).not.toBe(verkettungswertFolgebeleg(kette[2]!.maschinenlesbareCode))
    expect(analysiereKette(KASSE, kette).ok).toBe(true)
  })

  it('Kasse, die seit dem Update keinen Beleg mehr signiert hat (z. B. stillgelegt): die ganze Folge ist Altformat', () => {
    expect(analysiereKette(KASSE, baueKette(5, () => 'alt'))).toEqual({ ...sauber, altformat: 4, ersterAltformatIndex: 1, letzterAltformatIndex: 4 })
  })

  it('Altformat NACH einem Beleg nach Spezifikation (ältere Programmversion eingespielt): kein Bruch, aber „gemischt"', () => {
    const kette = baueKette(7, i => (i === 4 || i === 5 ? 'alt' : 'spez'))
    expect(analysiereKette(KASSE, kette)).toEqual({ ...sauber, altformat: 2, ersterAltformatIndex: 4, letzterAltformatIndex: 5, gemischt: true })
  })

  it('Altstrecke ohne Rückfall ist nicht „gemischt"', () => {
    expect(analysiereKette(KASSE, baueKette(8, i => (i <= 3 ? 'alt' : 'spez'))).gemischt).toBe(false)
  })

  it('gelöschter Beleg in der Altstrecke: Kettenbruch am Beleg danach', () => {
    const kette = baueKette(8, i => (i <= 5 ? 'alt' : 'spez'))
    kette.splice(3, 1)                                                // Beleg 4 fehlt
    const a = analysiereKette(KASSE, kette)
    expect(a.ok).toBe(false)
    expect(a.ersterBruchIndex).toBe(3)                                // der frühere Beleg 5 steht jetzt auf Index 3
    expect(a.altformat).toBe(2)                                       // Belege 2 und 3 waren noch in Ordnung
  })

  it('gelöschter Beleg in der neuen Strecke: Kettenbruch, auch wenn davor Altformat steht', () => {
    const kette = baueKette(9, i => (i <= 3 ? 'alt' : 'spez'))
    kette.splice(6, 1)
    const a = analysiereKette(KASSE, kette)
    expect(a.ok).toBe(false)
    expect(a.ersterBruchIndex).toBe(6)
  })

  it('manipulierter Vorbeleg in der Altstrecke (Nutzlast oder Signatur): Kettenbruch', () => {
    for (const aendere of [
      (c: string) => c.replace('0,00', '9,99'),
      (c: string) => `${c.slice(0, c.lastIndexOf('_') + 1)}${Buffer.from('gefaelscht').toString('base64')}`,
    ]) {
      const kette = baueKette(6, i => (i <= 3 ? 'alt' : 'spez'))
      kette[2] = { ...kette[2]!, maschinenlesbareCode: aendere(kette[2]!.maschinenlesbareCode) }
      const a = analysiereKette(KASSE, kette)
      expect(a.ok).toBe(false)
      expect(a.ersterBruchIndex).toBe(3)
    }
  })

  it('weder Altform noch Spezifikation (fremder Wert): Kettenbruch', () => {
    const kette = baueKette(5, i => (i <= 2 ? 'alt' : 'spez'))
    kette[3] = { ...kette[3]!, sigVorbeleg: verkettungswertStartbeleg('FALSCH') }
    expect(analysiereKette(KASSE, kette)).toMatchObject({ ok: false, ersterBruchIndex: 3, altformat: 2 })
  })

  it('falscher Startbeleg: Bruch am ersten Beleg, auch bei einer Altstrecke', () => {
    expect(analysiereKette('ANDERE-KASSE', baueKette(4, () => 'alt'))).toMatchObject({ ok: false, ersterBruchIndex: 0, altformat: 0 })
  })

  it('Ausfallbeleg (Marker statt Signatur) in der Altstrecke: wird in der Altform wie in der neuen Form verkettet', () => {
    const kette = baueKette(6, i => (i <= 3 ? 'alt' : 'spez'), i => (i === 2 ? SEE_AUSFALL_SIGNATUR : Buffer.from(`signatur-${i}`, 'utf8').toString('base64')))
    expect(analysiereKette(KASSE, kette)).toMatchObject({ ok: true, altformat: 3, gemischt: false })
  })
})
