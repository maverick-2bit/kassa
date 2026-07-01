/**
 * Integrationstest: weitere Registrierkasse für bestehenden Mandanten anlegen.
 *
 * Deckt ab:
 *  - GET  /api/kassen listet die Kassen des Mandanten.
 *  - POST /api/kassen legt eine zweite Kasse an (provisorisch, ohne FON) — mit
 *    EIGENEM SEE-Zertifikat und EIGENEM Startbeleg unter demselben Mandanten.
 *  - Doppelte kassenId wird abgelehnt.
 *  - Mit FON-Daten wird die Kasse registriert (FON-Client kontaktiert).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen, belege } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@kasse-anlegen.at'
const ADMIN_PASSWORT = 'kasse-anlegen-passwort-123'

const kasseInBetriebNehmen = vi.fn().mockResolvedValue({ erfolgreich: true })
const startbelegPruefen    = vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'FO-PW-2' })

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen,
    startbelegPruefen,
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Mehrkassen GmbH',
  uid:        'ATU99999906',
  kassenId:   'KASSE-001',
  umgebung:   'test',
  admin: { name: 'Multi Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Weitere Kasse anlegen (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let mandantId: string
  let ersteKasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token        = login.token
    mandantId    = login.mandant.id
    ersteKasseId = login.kassen[0].id
    kasseInBetriebNehmen.mockClear()
    startbelegPruefen.mockClear()
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('GET /api/kassen listet zunächst genau eine Kasse', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/kassen', headers: auth() })
    expect(res.statusCode).toBe(200)
    const liste = res.json()
    expect(liste).toHaveLength(1)
    expect(liste[0].kassenId).toBe('KASSE-001')
  })

  it('POST /api/kassen legt eine zweite Kasse provisorisch an (ohne FON)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: auth(),
      payload: { kassenId: 'KASSE-002', bezeichnung: 'Bar Terrasse', umgebung: 'test' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.erfolgreich).toBe(true)
    expect(body.kasseId).toBeTruthy()
    expect(typeof body.startbelegNummer).toBe('number')

    // FON wurde NICHT kontaktiert (provisorisch)
    expect(kasseInBetriebNehmen).not.toHaveBeenCalled()

    // Eigene SEE-Einheit: anderes Zertifikat als die erste Kasse
    const [k1] = await idb.db.select().from(kassen).where(eq(kassen.id, ersteKasseId))
    const [k2] = await idb.db.select().from(kassen).where(eq(kassen.id, body.kasseId))
    expect(k2!.mandantId).toBe(mandantId)
    expect(k2!.bezeichnung).toBe('Bar Terrasse')
    expect(k2!.bei_fo_registriert).toBe(false)
    expect(k2!.seeZertifikatSn).not.toBe(k1!.seeZertifikatSn)
    expect(k2!.seeZertifikatDer).not.toBe(k1!.seeZertifikatDer)

    // Eigener Startbeleg
    const startbelege = await idb.db.select().from(belege)
      .where(and(eq(belege.kasseId, body.kasseId), eq(belege.belegTyp, 'Startbeleg')))
    expect(startbelege).toHaveLength(1)
  })

  it('doppelte kassenId wird abgelehnt', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: auth(),
      payload: { kassenId: 'KASSE-002', umgebung: 'test' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().erfolgreich).toBe(false)
    expect(res.json().fehler).toMatch(/bereits vergeben/i)
  })

  it('mit FON-Daten wird die Kasse registriert (FON-Client kontaktiert)', async () => {
    kasseInBetriebNehmen.mockClear()
    startbelegPruefen.mockClear()

    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: auth(),
      payload: {
        kassenId: 'KASSE-003', umgebung: 'test',
        finanzOnline: { teilnehmerId: 'TID', benutzerkennung: 'BID', pin: 'PIN' },
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().erfolgreich).toBe(true)
    expect(kasseInBetriebNehmen).toHaveBeenCalledTimes(1)
    expect(startbelegPruefen).toHaveBeenCalledTimes(1)

    const [k3] = await idb.db.select().from(kassen).where(eq(kassen.id, res.json().kasseId))
    expect(k3!.bei_fo_registriert).toBe(true)
    expect(k3!.registriert_am).not.toBeNull()

    // Insgesamt jetzt drei Kassen
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/kassen', headers: auth() })).json()
    expect(liste).toHaveLength(3)
  })
})
