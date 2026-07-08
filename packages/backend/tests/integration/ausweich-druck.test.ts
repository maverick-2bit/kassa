/**
 * Integrationstest: Ausweich-Druck („Nicht akzeptiert" im Digital-Modus).
 *
 * Kasse auf belegModus 'digital' → normaler Reprint ist geblockt (409, Digital-Gate),
 * aber mit { ausweich: true } wird der Kassa-Bondrucker erzwungen (Druckversuch;
 * mit Dummy-IP schlägt der Socket fehl → 502, beweist: Config aufgelöst + gedruckt).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@ausweich.at'
const ADMIN_PASSWORT = 'ausweich-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'AW-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Ausweich Test GmbH',
  uid:        'ATU99999904',
  kassenId:   'AW-001',
  finanzOnline: { teilnehmerId: 'TID-AW', benutzerkennung: 'BID-AW', pin: 'PIN-AW' },
  umgebung: 'test',
  admin: { name: 'AW Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Ausweich-Druck (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let belegId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    const bon = (await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Testartikel', preisBruttoCent: 500, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 },
      },
    })).json()
    belegId = bon.id

    // Kasse: Digital-Modus + Ausweich-Bondrucker (Dummy-IP, kurzer Timeout)
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(),
      payload: { belegModus: 'digital', druckerAktiv: true, druckerIp: '127.0.0.1', druckerPort: 9999, druckerTimeoutSek: 1 },
    })
    if (patch.statusCode !== 200) throw new Error(`Drucker-PATCH (${patch.statusCode}): ${patch.body}`)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('normaler Reprint im Digital-Modus ist geblockt (409)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/belege/${belegId}/drucken`, headers: auth(), payload: {},
    })
    expect(res.statusCode).toBe(409)
  })

  it('Ausweich-Druck (ausweich:true) erzwingt den Druck — Config aufgelöst, Socket-Fehler statt 409', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/belege/${belegId}/drucken`, headers: auth(), payload: { ausweich: true },
    })
    // NICHT 409 (Config wurde aufgelöst); Dummy-Drucker nicht erreichbar → 502 (Drucker-Fehler)
    expect(res.statusCode).not.toBe(409)
    expect(res.statusCode).toBe(502)
  })
})
