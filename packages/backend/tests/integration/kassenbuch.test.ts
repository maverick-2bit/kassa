/**
 * Integrationstest: Kassenbuch gegen echtes PostgreSQL.
 *
 * Bar-Ein- und -Auszahlungen (nicht umsatzbezogen). Prüft: Buchungen anlegen,
 * Saldo-Aggregation (Einlagen − Entnahmen), Datumsbereichs-Filter, Validierung
 * und Mandanten-/Kassen-Scope.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { KassenbuchResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@kassenbuch.at'
const ADMIN_PASSWORT = 'kassenbuch-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Kassenbuch GmbH',
  uid:        'ATU99999911',
  kassenId:   'KB-001',
  finanzOnline: { teilnehmerId: 'TID-KB', benutzerkennung: 'BID-KB', pin: 'PIN-KB' },
  umgebung: 'test',
  admin: { name: 'KB Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

const TAG_A = '2026-06-17'
const TAG_B = '2026-06-10'

describe('Kassenbuch (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  const buchen = (typ: 'einlage' | 'entnahme', betragCent: number, datum: string, grund?: string) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/kassenbuch', headers: auth(),
      payload: { kasseId, typ, betragCent, datum, ...(grund && { grund }) },
    })

  const lesen = (von: string, bis: string) =>
    srv.fastify.inject({
      method: 'GET', url: `/api/kassenbuch?kasseId=${kasseId}&von=${von}&bis=${bis}`, headers: auth(),
    })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id

    // TAG_A: Einlage 10000 (Wechselgeld) + Entnahme 3000 (Bank) | TAG_B: Entnahme 500
    if ((await buchen('einlage', 10000, TAG_A, 'Wechselgeld')).statusCode !== 201) throw new Error('Einlage A')
    if ((await buchen('entnahme', 3000, TAG_A, 'Bankeinzahlung')).statusCode !== 201) throw new Error('Entnahme A')
    if ((await buchen('entnahme', 500, TAG_B, 'Trinkgeld-Auszahlung')).statusCode !== 201) throw new Error('Entnahme B')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert das Kassenbuch ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/kassenbuch?kasseId=${kasseId}&von=${TAG_A}&bis=${TAG_A}` })
    expect(res.statusCode).toBe(401)
  })

  it('aggregiert Einlagen, Entnahmen und Saldo für einen Tag', async () => {
    const res = await lesen(TAG_A, TAG_A)
    expect(res.statusCode).toBe(200)
    const kb = res.json() as KassenbuchResponse
    expect(kb.buchungen).toHaveLength(2)
    expect(kb.einlagenCent).toBe(10000)
    expect(kb.entnahmenCent).toBe(3000)
    expect(kb.saldoCent).toBe(7000)   // 10000 - 3000
  })

  it('summiert über einen mehrtägigen Bereich korrekt', async () => {
    const kb = (await lesen('2026-06-01', '2026-06-30')).json() as KassenbuchResponse
    expect(kb.buchungen).toHaveLength(3)
    expect(kb.einlagenCent).toBe(10000)
    expect(kb.entnahmenCent).toBe(3500)   // 3000 + 500
    expect(kb.saldoCent).toBe(6500)
  })

  it('grenzt nach Datumsbereich ab (nur der ältere Tag)', async () => {
    const kb = (await lesen(TAG_B, TAG_B)).json() as KassenbuchResponse
    expect(kb.buchungen).toHaveLength(1)
    expect(kb.einlagenCent).toBe(0)
    expect(kb.entnahmenCent).toBe(500)
    expect(kb.saldoCent).toBe(-500)
  })

  it('weist Betrag 0 ab (400)', async () => {
    const res = await buchen('einlage', 0, TAG_A)
    expect(res.statusCode).toBe(400)
  })

  it('liefert 404 für eine fremde Kasse', async () => {
    const res = await srv.fastify.inject({
      method: 'GET',
      url: `/api/kassenbuch?kasseId=11111111-1111-1111-1111-111111111111&von=${TAG_A}&bis=${TAG_A}`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(404)
  })
})
