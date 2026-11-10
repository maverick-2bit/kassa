/**
 * Integrationstest: Modul „Sprachbestellung" (Flag je Mandant) gegen echtes PostgreSQL.
 *
 * Kern: Standard = AUS (heutiges Verhalten, nichts wird geladen), Toggle über
 * /mandanten/module, Flag erscheint im Login-Payload (so erfährt die Kellner-App davon),
 * andere Module bleiben unberührt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL = 'admin@sprache.at', ADMIN_PASSWORT = 'sprache-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SP-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Sprache GmbH', uid: 'ATU99999905', kassenId: 'SP-001',
  finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
  admin: { name: 'SP Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Modul Sprachbestellung (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const holeModule = async () =>
    (await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/module', headers: auth() })).json()
  const login = async () =>
    (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })).json()

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    token = (await login()).token
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('ist standardmäßig AUS (Modul-Endpunkt und Login-Payload)', async () => {
    expect((await holeModule()).modulSpracheAktiv).toBe(false)
    expect((await login()).mandant.modulSpracheAktiv).toBe(false)
  })

  it('lässt sich über /mandanten/module einschalten und erscheint im Login-Payload', async () => {
    const patch = await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulSpracheAktiv: true } })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().modulSpracheAktiv).toBe(true)
    expect((await holeModule()).modulSpracheAktiv).toBe(true)
    expect((await login()).mandant.modulSpracheAktiv).toBe(true)
  })

  it('berührt andere Module nicht und lässt sich wieder ausschalten', async () => {
    const vorher = await holeModule()
    const patch = await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulSpracheAktiv: false } })
    expect(patch.statusCode).toBe(200)
    const nachher = await holeModule()
    expect(nachher.modulSpracheAktiv).toBe(false)
    expect({ ...nachher, modulSpracheAktiv: true }).toEqual({ ...vorher, modulSpracheAktiv: true })
  })
})
