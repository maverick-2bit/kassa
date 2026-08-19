/**
 * Integrationstest: PIN-only-Kellner (Eventpersonal).
 *
 * Aushilfen bekommen kein E-Mail-Konto — sie werden mit Name + PIN angelegt
 * und melden sich NUR per PIN am Handy an. Intern erhält das Konto eine nicht
 * erratbare Platzhalter-Adresse plus Zufallspasswort; der E-Mail-Login ist
 * damit faktisch unmöglich.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@pin-kellner.at'
const ADMIN_PASSWORT = 'pin-kellner-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'PK-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('PIN-only-Kellner (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Event GmbH',
        uid:        'ATU99999926',
        kassenId:   'PK-001',
        finanzOnline: { teilnehmerId: 'TID-PK', benutzerkennung: 'BID-PK', pin: 'PIN-PK' },
        umgebung: 'test',
        admin: { name: 'PK Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('legt einen Kellner ohne E-Mail/Passwort an (nur Name + PIN)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: {
        name: 'Aushilfe Anna', rolle: 'kellner',
        berechtigungen: ['tische', 'kasse'], kassenIds: [kasseId], pin: '4711',
      },
    })
    expect(res.statusCode).toBe(201)
    const u = res.json()
    expect(u.hatPin).toBe(true)
    // Platzhalter-Adresse: intern, nicht erratbar, klar als solche erkennbar
    expect(u.email).toMatch(/@pin\.kellner\.lokal$/)
  })

  it('ein frisches Handy kann die Kassen-Auswahl OHNE Token laden', async () => {
    // Der Bootstrap der Kellner-App: vor dem allerersten Login gibt es kein
    // Token — der alte Weg über GET /kassen war deshalb eine 401-Sackgasse
    // (leere Liste → totes PIN-Feld, zweimal vom Test-PC gemeldet).
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()

    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/auswahl?mandantId=${login.mandant.id}`,
    })
    expect(res.statusCode).toBe(200)
    const liste = res.json() as { id: string; bezeichnung: string }[]
    expect(liste).toHaveLength(1)
    expect(liste[0]!.id).toBe(kasseId)
    expect(liste[0]!.bezeichnung).toBeTruthy()   // Fallback kassenId, nie leer

    // Ungültige mandantId → 400; fremde (nicht existente) → leere Liste
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/kassen/auswahl?mandantId=quatsch' })).statusCode).toBe(400)
    const fremd = await srv.fastify.inject({
      method: 'GET', url: '/api/kassen/auswahl?mandantId=11111111-1111-1111-1111-111111111111',
    })
    expect(fremd.json()).toEqual([])
  })

  it('die Aushilfe kann sich per PIN am Handy anmelden — mit ihrem Namen', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/pin-login',
      payload: { kasseId, pin: '4711' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.name).toBe('Aushilfe Anna')
  })

  it('ein E-Mail-Login auf das PIN-Konto ist unmöglich', async () => {
    const [users] = [
      (await srv.fastify.inject({ method: 'GET', url: '/api/users', headers: auth() })).json(),
    ]
    const anna = users.find((u: { name: string }) => u.name === 'Aushilfe Anna')
    // Selbst mit bekannter Platzhalter-Adresse: das Zufallspasswort kennt niemand.
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: anna.email, passwort: 'irgendein-versuch-123' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('ohne E-Mail UND ohne PIN wird die Anlage abgelehnt (Konto wäre unbenutzbar)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { name: 'Kaputt', rolle: 'kellner', berechtigungen: [], kassenIds: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('ein Admin ohne E-Mail wird abgelehnt', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { name: 'Chef ohne Mail', rolle: 'admin', berechtigungen: [], kassenIds: [], pin: '9999' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('der klassische Weg (E-Mail + Passwort) funktioniert unverändert', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: {
        name: 'Stamm-Kellner', email: 'stamm@pin-kellner.at', passwort: 'stamm-passwort-1',
        rolle: 'kellner', berechtigungen: ['tische'], kassenIds: [kasseId],
      },
    })
    expect(res.statusCode).toBe(201)
    const login = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'stamm@pin-kellner.at', passwort: 'stamm-passwort-1' },
    })
    expect(login.statusCode).toBe(200)
  })
})
