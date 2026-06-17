/**
 * Integrationstest: Gutscheine gegen echtes PostgreSQL.
 *
 * Geld-kritisch. Prüft: Ausstellen (Saldo), Teil-/Voll-Einlösung, Restwert,
 * keine Über- oder Doppel-Einlösung, Restgutschein, Storno, Code-Lookup.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { GutscheinResponse, GutscheinEinloesungResult } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@gutschein.at'
const ADMIN_PASSWORT = 'gutschein-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Gutschein GmbH',
  uid:        'ATU99999908',
  kassenId:   'GS-001',
  finanzOnline: { teilnehmerId: 'TID-GS', benutzerkennung: 'BID-GS', pin: 'PIN-GS' },
  umgebung: 'test',
  admin: { name: 'GS Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Gutscheine (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function erstelle(betragCent: number, code?: string): Promise<GutscheinResponse> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine', headers: auth(),
      payload: { betragCent, ...(code && { code }) },
    })
    if (r.statusCode !== 201) throw new Error(`Gutschein (${r.statusCode}): ${r.body}`)
    return r.json() as GutscheinResponse
  }

  const einloesen = (id: string, einloesungCent: number, erstelleRestgutschein = false) =>
    srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${id}/einloesen`, headers: auth(),
      payload: { einloesungCent, erstelleRestgutschein },
    })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    token = loginRes.json().token
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert die Gutschein-Liste ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/gutscheine' })
    expect(res.statusCode).toBe(401)
  })

  it('stellt einen Gutschein mit vollem Restwert aus', async () => {
    const gs = await erstelle(5000)
    expect(gs.status).toBe('aktiv')
    expect(gs.betragCent).toBe(5000)
    expect(gs.bezahltCent).toBe(0)
    expect(gs.restCent).toBe(5000)
    expect(gs.code).toBeTruthy()
  })

  it('findet einen Gutschein über seinen Code', async () => {
    const gs = await erstelle(1000, 'TESTCODE-123')
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/gutscheine/code/TESTCODE-123', headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(gs.id)
  })

  it('löst teilweise ein, dann den Rest — Saldo und Status stimmen', async () => {
    const gs = await erstelle(5000)

    const teil = await einloesen(gs.id, 2000)
    expect(teil.statusCode).toBe(200)
    const nachTeil = (teil.json() as GutscheinEinloesungResult).gutschein
    expect(nachTeil.bezahltCent).toBe(2000)
    expect(nachTeil.restCent).toBe(3000)
    expect(nachTeil.status).toBe('teileingeloest')

    const rest = await einloesen(gs.id, 3000)
    expect(rest.statusCode).toBe(200)
    const nachVoll = (rest.json() as GutscheinEinloesungResult).gutschein
    expect(nachVoll.restCent).toBe(0)
    expect(nachVoll.status).toBe('eingeloest')

    // bereits vollständig eingelöst -> 400
    const nochmal = await einloesen(gs.id, 100)
    expect(nochmal.statusCode).toBe(400)
  })

  it('verweigert Einlösung über dem Restwert (400)', async () => {
    const gs = await erstelle(1000)
    const res = await einloesen(gs.id, 1500)
    expect(res.statusCode).toBe(400)
    // Gutschein bleibt unangetastet
    const unveraendert = await srv.fastify.inject({
      method: 'GET', url: `/api/gutscheine/${gs.id}`, headers: auth(),
    })
    expect((unveraendert.json() as GutscheinResponse).restCent).toBe(1000)
  })

  it('stellt bei Teil-Einlösung mit Restgutschein einen neuen Gutschein über den Rest aus', async () => {
    const gs = await erstelle(5000)
    const res = await einloesen(gs.id, 2000, true)
    expect(res.statusCode).toBe(200)
    const result = res.json() as GutscheinEinloesungResult

    // Original vollständig abgeschrieben
    expect(result.gutschein.status).toBe('eingeloest')
    // Neuer Restgutschein über 3000
    expect(result.restGutschein).toBeDefined()
    expect(result.restGutschein!.betragCent).toBe(3000)
    expect(result.restGutschein!.restCent).toBe(3000)
    expect(result.restGutschein!.status).toBe('aktiv')
    expect(result.restGutschein!.id).not.toBe(gs.id)
  })

  it('stornierter Gutschein kann nicht eingelöst werden', async () => {
    const gs = await erstelle(2000)
    const storno = await srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${gs.id}/stornieren`, headers: auth(),
    })
    expect(storno.statusCode).toBe(200)
    expect((storno.json() as GutscheinResponse).status).toBe('storniert')

    const res = await einloesen(gs.id, 500)
    expect(res.statusCode).toBe(400)
  })

  it('protokolliert Einlösungs-Buchungen', async () => {
    const gs = await erstelle(3000)
    await einloesen(gs.id, 1000)
    await einloesen(gs.id, 500)
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/gutscheine/${gs.id}/buchungen`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const buchungen = res.json() as unknown[]
    // mindestens die beiden Einlösungen
    expect(buchungen.length).toBeGreaterThanOrEqual(2)
  })
})
