/**
 * Unit-Tests des Geräte-Merkmals der PIN-Bremse.
 *
 * Es darf nur vom eigenen Backend stammen, nur für den eigenen Mandanten gelten
 * und muss irgendwann ablaufen — und es darf nie wie ein Anmelde-JWT aussehen.
 */

import { describe, it, expect } from 'vitest'
import { erstelleGeraetVertrauen, GERAET_VERTRAUEN_TAGE } from '../src/auth/geraet-vertrauen.js'

const GEHEIM   = 'test-jwt-secret-key-very-long-and-secret-12345'
const MANDANT  = '10000000-0000-0000-0000-000000000001'
const ANDERER  = '10000000-0000-0000-0000-000000000002'
const GERAET   = '30000000-0000-4000-8000-000000000001'

describe('Geräte-Vertrauen', () => {
  it('stellt aus und erkennt das eigene Merkmal wieder', () => {
    const v = erstelleGeraetVertrauen(GEHEIM)
    const token = v.ausstellen(MANDANT)
    const geprueft = v.pruefen(token, MANDANT)
    expect(geprueft?.mandantId).toBe(MANDANT)
    expect(geprueft?.geraetId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('verlängern behält das Gerät — sonst gäbe jede Anmeldung einen frischen Topf', () => {
    const v = erstelleGeraetVertrauen(GEHEIM)
    const neu = v.ausstellen(MANDANT, GERAET)
    expect(v.pruefen(neu, MANDANT)?.geraetId).toBe(GERAET)
  })

  it('ist kein JWT (zwei statt drei Teile)', () => {
    const token = erstelleGeraetVertrauen(GEHEIM).ausstellen(MANDANT)
    expect(token.split('.')).toHaveLength(2)
  })

  it('lehnt fremde Mandanten, fremde Schlüssel und Manipulation ab', () => {
    const v = erstelleGeraetVertrauen(GEHEIM)
    const token = v.ausstellen(MANDANT, GERAET)
    expect(v.pruefen(token, ANDERER)).toBeNull()
    expect(erstelleGeraetVertrauen('ein-ganz-anderes-geheimnis-mit-genug-laenge').pruefen(token, MANDANT)).toBeNull()

    // Rumpf auf den anderen Mandanten umschreiben, Signatur behalten
    const [rumpf, signatur] = token.split('.') as [string, string]
    const daten = JSON.parse(Buffer.from(rumpf, 'base64url').toString('utf8'))
    const gefaelscht = Buffer.from(JSON.stringify({ ...daten, m: ANDERER })).toString('base64url')
    expect(v.pruefen(`${gefaelscht}.${signatur}`, ANDERER)).toBeNull()
    // Signatur verändert
    expect(v.pruefen(`${rumpf}.${signatur.slice(0, -2)}xx`, MANDANT)).toBeNull()
  })

  it('läuft nach 180 Tagen ab', () => {
    let uhr = 1_800_000_000_000
    const v = erstelleGeraetVertrauen(GEHEIM, () => uhr)
    const token = v.ausstellen(MANDANT)
    uhr += (GERAET_VERTRAUEN_TAGE * 86_400 - 60) * 1000
    expect(v.pruefen(token, MANDANT)).not.toBeNull()
    uhr += 120_000
    expect(v.pruefen(token, MANDANT)).toBeNull()
  })

  it('verkraftet Müll ohne Ausnahme', () => {
    const v = erstelleGeraetVertrauen(GEHEIM)
    for (const muell of [undefined, null, 42, '', 'abc', 'a.b.c', '.', 'x'.repeat(600), {}]) {
      expect(v.pruefen(muell, MANDANT)).toBeNull()
    }
  })
})
