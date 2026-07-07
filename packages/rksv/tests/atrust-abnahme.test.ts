/**
 * ECHTER Test gegen die A-Trust-Abnahme-Umgebung (hs-abnahme.a-trust.at).
 *
 * Läuft nur mit gesetzter Umgebungsvariable, da er das Netz braucht:
 *   ATRUST_ABNAHME=1 pnpm test
 * Optional eigener Zugang via ATRUST_BENUTZER / ATRUST_PASSWORT
 * (Default: der öffentliche Doku-Testbenutzer).
 */

import { describe, it, expect } from 'vitest'
import {
  ATrustHsmEinheit,
  ATRUST_ABNAHME_BASIS_URL,
  jwsSigningInput,
  verifiziere,
} from '../src/index.js'

const aktiv    = process.env.ATRUST_ABNAHME === '1'
const benutzer = process.env.ATRUST_BENUTZER ?? 'u123456789'
const passwort = process.env.ATRUST_PASSWORT ?? '123456789'
/**
 * Signieren ist auf der Abnahme-Umgebung nur mit einem persönlich von A-Trust
 * vergebenen Testzugang möglich (der öffentliche Doku-Benutzer darf nur
 * Zertifikat/ZDA lesen; POST /Sign wird von der WAF mit 403 geblockt —
 * live verifiziert am 2026-07-08). Eigenen Zugang via env setzen.
 */
const signAktiv = aktiv && process.env.ATRUST_BENUTZER != null && process.env.ATRUST_PASSWORT != null

describe.skipIf(!aktiv)('A-Trust Abnahme-Umgebung (echtes Netz)', () => {
  const einheit = new ATrustHsmEinheit({
    basisUrl: ATRUST_ABNAHME_BASIS_URL,
    benutzer,
    passwort,
    timeoutMs: 10_000,
  })

  it('liefert ZDA-Kennung und Zertifikat', async () => {
    const zda  = await einheit.zdaId()
    const zert = await einheit.zertifikat()
    console.log(`A-Trust Abnahme: ZDA=${zda}, SN=${zert.seriennummerHex}`)
    expect(zda).toMatch(/^AT\d$/)
    expect(zert.derBase64.length).toBeGreaterThan(100)
    expect(zert.seriennummerHex).toMatch(/^[0-9A-Fa-f]+$/)
  })

  it.skipIf(!signAktiv)('signiert eine Belegzeile, die lokal gegen das A-Trust-Zertifikat verifiziert', async () => {
    const belegzeile =
      '_R1-AT1_ABNAHME-KASSE_1_2026-07-08T12:00:00_0,00_0,00_0,00_0,00_0,00_QUJDREVGR0g=_1A2B3C_dGVzdHZrdw=='
    const sig  = await einheit.signiereBelegzeile(belegzeile)
    const zert = await einheit.zertifikat()

    expect(sig).toHaveLength(64)
    expect(verifiziere(jwsSigningInput(belegzeile), sig, Buffer.from(zert.derBase64, 'base64'))).toBe(true)
  }, 20_000)
})
