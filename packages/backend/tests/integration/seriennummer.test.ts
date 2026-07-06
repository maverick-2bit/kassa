/**
 * Integrationstest: Seriennummern beim Verkauf (Rechnung/Bon) gegen echtes PostgreSQL.
 *
 * Deckt ab, was Unit-Mocks nicht beweisen:
 *  - strikter Pool je Artikel (fremde Seriennummer nicht verkaufbar)
 *  - Zuweisung landet auf der Beleg-Position (Aufdruck) und markiert den Pool
 *    atomar als „verkauft" mit belegId
 *  - Doppelverkauf derselben Seriennummer wird verhindert (409)
 *  - Stückzahl muss zur Anzahl der Seriennummern passen (400)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { type FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@serientest.at'
const ADMIN_PASSWORT = 'serientest-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'STEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Seriennummer-Test GmbH',
  uid:        'ATU99999902',
  kassenId:   'STEST-001',
  finanzOnline: { teilnehmerId: 'TID-STEST', benutzerkennung: 'BID-STEST', pin: 'PIN-STEST' },
  umgebung: 'test',
  admin: { name: 'Serien Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface PoolEintrag { id: string; seriennummer: string; status: string; belegId: string | null }

describe('Seriennummern beim Verkauf (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let laptopId: string   // serialisierter Artikel, 500,00 €
  let handyId: string    // zweiter serialisierter Artikel (Fremd-Pool)

  const auth = () => ({ authorization: `Bearer ${token}` })

  const pool = async (artikelId: string): Promise<PoolEintrag[]> => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/seriennummern?artikelId=${artikelId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    return res.json() as PoolEintrag[]
  }

  const barzahlung = (positionen: unknown[], barCent: number) => ({
    kasseId, positionen, zahlung: { barCent, karteCent: 0, sonstigeCent: 0 },
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

    const laptop = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Laptop', preisBruttoCent: 50000, mwstSatz: 'normal', seriennummernAktiv: true },
    })
    if (laptop.statusCode !== 201) throw new Error(`Laptop (${laptop.statusCode}): ${laptop.body}`)
    laptopId = laptop.json().id

    const handy = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Handy', preisBruttoCent: 30000, mwstSatz: 'normal', seriennummernAktiv: true },
    })
    handyId = handy.json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Seriennummern lassen sich in den Pool des Artikels erfassen', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/seriennummern', headers: auth(),
      payload: { artikelId: laptopId, seriennummern: ['SN-A1', 'SN-A2', 'SN-A3'] },
    })
    expect(res.statusCode).toBe(201)

    const handyRes = await srv.fastify.inject({
      method: 'POST', url: '/api/seriennummern', headers: auth(),
      payload: { artikelId: handyId, seriennummern: ['SN-H1'] },
    })
    expect(handyRes.statusCode).toBe(201)

    const p = await pool(laptopId)
    expect(p).toHaveLength(3)
    expect(p.every(s => s.status === 'verfuegbar')).toBe(true)
  })

  it('Barzahlung druckt die gewählten Seriennummern und markiert den Pool als verkauft', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: barzahlung([{ artikelId: laptopId, menge: 2, seriennummern: ['SN-A1', 'SN-A2'] }], 100000),
    })
    expect(res.statusCode).toBe(201)
    const beleg = res.json() as BelegResponse
    expect(beleg.gesamtbetragCent).toBe(100000)

    // Seriennummern stehen auf der Position (für den Aufdruck)
    const pos = beleg.positionen.find(p => p.seriennummern && p.seriennummern.length > 0)
    expect(pos).toBeDefined()
    expect([...pos!.seriennummern!].sort()).toEqual(['SN-A1', 'SN-A2'])

    // Pool: A1/A2 verkauft + belegId gesetzt, A3 weiterhin verfügbar
    const p = await pool(laptopId)
    const verkauft = p.filter(s => s.status === 'verkauft')
    expect(verkauft.map(s => s.seriennummer).sort()).toEqual(['SN-A1', 'SN-A2'])
    expect(verkauft.every(s => s.belegId === beleg.id)).toBe(true)
    expect(p.find(s => s.seriennummer === 'SN-A3')!.status).toBe('verfuegbar')
  })

  it('Eine bereits verkaufte Seriennummer kann nicht erneut verkauft werden (409)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: barzahlung([{ artikelId: laptopId, menge: 1, seriennummern: ['SN-A1'] }], 50000),
    })
    expect(res.statusCode).toBe(409)
    // A3 blieb unberührt
    expect((await pool(laptopId)).find(s => s.seriennummer === 'SN-A3')!.status).toBe('verfuegbar')
  })

  it('Stückzahl muss zur Anzahl der Seriennummern passen (400)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: barzahlung([{ artikelId: laptopId, menge: 2, seriennummern: ['SN-A3'] }], 100000),
    })
    expect(res.statusCode).toBe(400)
    expect((await pool(laptopId)).find(s => s.seriennummer === 'SN-A3')!.status).toBe('verfuegbar')
  })

  it('Der Pool ist strikt je Artikel — fremde Seriennummer ist nicht verkaufbar (409)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      // Handy-Seriennummer unter dem Laptop verkaufen zu wollen, schlägt fehl
      payload: barzahlung([{ artikelId: laptopId, menge: 1, seriennummern: ['SN-H1'] }], 50000),
    })
    expect(res.statusCode).toBe(409)
    // Handy-Pool unberührt
    expect((await pool(handyId)).find(s => s.seriennummer === 'SN-H1')!.status).toBe('verfuegbar')
  })
})
