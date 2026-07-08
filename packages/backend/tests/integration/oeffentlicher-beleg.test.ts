/**
 * Integrationstest: GET /api/oeffentlich/beleg/:belegId (digitaler Beleg).
 *
 * Der öffentliche Beleg-Endpoint liefert einen Beleg OHNE Auth (der Gast scannt
 * einen QR) und OHNE Kunde-Block (Privatsphäre). Fake-IDs → 404.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@oeffentlich.at'
const ADMIN_PASSWORT = 'oeffentlich-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'OB-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Öffentlicher Beleg GmbH',
  uid:        'ATU99999903',
  kassenId:   'OB-001',
  finanzOnline: { teilnehmerId: 'TID-OB', benutzerkennung: 'BID-OB', pin: 'PIN-OB' },
  umgebung: 'test',
  admin: { name: 'OB Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Öffentlicher Beleg (Integration, echtes PostgreSQL)', () => {
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

    // Barzahlungsbeleg erzeugen → dessen id ist der öffentliche Zugang
    const bon = (await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Testartikel', preisBruttoCent: 500, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 },
      },
    })).json()
    belegId = bon.id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('liefert den Beleg OHNE Auth-Header + ohne Kunde-Block', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/oeffentlich/beleg/${belegId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.firmenname).toBe('Öffentlicher Beleg GmbH')
    expect(body.uid).toBe('ATU99999903')
    expect(body.beleg.id).toBe(belegId)
    expect(body.beleg.belegTyp).toBe('Barzahlungsbeleg')
    expect(body.beleg.maschinenlesbareCode).toBeTruthy()
    expect(body.beleg.gesamtbetragCent).toBe(500)
    // Privatsphäre: kein Kunde-Block im öffentlichen Beleg
    expect(body.beleg.kunde).toBeUndefined()
  })

  it('gibt 404 bei unbekannter (aber gültiger) Beleg-UUID', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/oeffentlich/beleg/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(404)
  })

  it('gibt 400 bei ungültiger Beleg-ID', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/oeffentlich/beleg/keine-uuid' })
    expect(res.statusCode).toBe(400)
  })
})
