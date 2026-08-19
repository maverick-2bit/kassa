/**
 * Integrationstest: öffentlicher Einrichtungs-Status (GET /api/setup/status).
 *
 * Anlass aus dem Feld: Auf einem frisch installierten Mac stand sofort die
 * Login-Seite, die Zugangsdaten einer ANDEREN Installation griffen natürlich
 * nicht — gemeldet wurde „Login kaputt". Die Login-Seite fragt jetzt diesen
 * Status ab und führt auf frischen Installationen sichtbar zur Ersteinrichtung.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SS-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Setup-Status (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer

  const status = () => srv.fastify.inject({ method: 'GET', url: '/api/setup/status' })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('meldet eine frische Installation als nicht eingerichtet — ohne Token', async () => {
    const res = await status()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ eingerichtet: false })
  })

  it('meldet nach dem Setup eingerichtet', async () => {
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Status GmbH',
        uid:        'ATU99999924',
        kassenId:   'SS-001',
        finanzOnline: { teilnehmerId: 'TID-SS', benutzerkennung: 'BID-SS', pin: 'PIN-SS' },
        umgebung: 'test',
        admin: { name: 'SS Admin', email: 'admin@setup-status.at', passwort: 'setup-status-passwort-1' },
      },
    })
    expect(setup.statusCode).toBe(201)

    const res = await status()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ eingerichtet: true })
  })
})
