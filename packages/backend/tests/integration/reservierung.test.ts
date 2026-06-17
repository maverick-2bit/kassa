/**
 * Integrationstest: Tischreservierungen gegen echtes PostgreSQL.
 *
 * Prüft den CRUD-Lebenszyklus: anlegen (Status bestaetigt), nach Kasse/Datum
 * listen, Status/Personenzahl aktualisieren, löschen, Mandanten-/Kassen-Scope
 * und Eingabe-Validierung.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { ReservierungResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@reservierung.at'
const ADMIN_PASSWORT = 'reservierung-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Reservierung GmbH',
  uid:        'ATU99999915',
  kassenId:   'RV-001',
  finanzOnline: { teilnehmerId: 'TID-RV', benutzerkennung: 'BID-RV', pin: 'PIN-RV' },
  umgebung: 'test',
  admin: { name: 'RV Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

const DATUM = '2026-07-01'

describe('Reservierungen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  const liste = (datum = DATUM) =>
    srv.fastify.inject({
      method: 'GET', url: `/api/reservierungen?kasseId=${kasseId}&datumVon=${datum}&datumBis=${datum}`, headers: auth(),
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
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  async function anlegen(overrides: Record<string, unknown> = {}): Promise<ReservierungResponse> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/reservierungen', headers: auth(),
      payload: { kasseId, datum: DATUM, zeitVon: '19:30', personenAnzahl: 4, name: 'Familie Huber', ...overrides },
    })
    if (r.statusCode !== 201) throw new Error(`Reservierung (${r.statusCode}): ${r.body}`)
    return r.json() as ReservierungResponse
  }

  it('verweigert Reservierungen ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/reservierungen?kasseId=${kasseId}` })
    expect(res.statusCode).toBe(401)
  })

  it('legt eine interne Reservierung an (Status bestaetigt)', async () => {
    const r = await anlegen()
    expect(r.status).toBe('bestaetigt')
    expect(r.datum).toBe(DATUM)
    expect(r.personenAnzahl).toBe(4)
    expect(r.name).toBe('Familie Huber')
  })

  it('listet Reservierungen nach Kasse und Datum', async () => {
    const r = await anlegen({ name: 'Tisch Müller', zeitVon: '20:00' })
    const res = await liste()
    expect(res.statusCode).toBe(200)
    expect((res.json() as ReservierungResponse[]).some(x => x.id === r.id)).toBe(true)
  })

  it('aktualisiert Status und Personenzahl', async () => {
    const r = await anlegen()
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/reservierungen/${r.id}`, headers: auth(),
      payload: { status: 'erschienen', personenAnzahl: 5 },
    })
    expect(patch.statusCode).toBe(200)
    const aktualisiert = patch.json() as ReservierungResponse
    expect(aktualisiert.status).toBe('erschienen')
    expect(aktualisiert.personenAnzahl).toBe(5)
  })

  it('löscht eine Reservierung', async () => {
    const r = await anlegen({ name: 'Zum Löschen' })
    const del = await srv.fastify.inject({ method: 'DELETE', url: `/api/reservierungen/${r.id}`, headers: auth() })
    expect([200, 204]).toContain(del.statusCode)
    const res = await liste()
    expect((res.json() as ReservierungResponse[]).some(x => x.id === r.id)).toBe(false)
  })

  it('lehnt eine Reservierung für eine fremde Kasse ab (404)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/reservierungen', headers: auth(),
      payload: { kasseId: '11111111-1111-1111-1111-111111111111', datum: DATUM, zeitVon: '19:30', personenAnzahl: 2, name: 'Fremd' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('lehnt ungültige Eingaben ab (400)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/reservierungen', headers: auth(),
      payload: { kasseId, datum: DATUM, zeitVon: '25:99', personenAnzahl: 0, name: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})
