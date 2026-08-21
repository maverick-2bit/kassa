/**
 * Integrationstest: Favoriten je Kasse (mit Platzhaltern) + „Artikel je Zeile".
 *
 * Jede Kasse hat ihre eigene Favoritenliste (kasse_favoriten); artikelId null
 * ist ein Platzhalter (graue Kachel im Raster). Die Liste wird beim PUT komplett
 * ersetzt, fremde Artikel-IDs werden abgelehnt. artikelProZeile ist die
 * gemeinsame Raster-Einstellung für Kasse UND Kellner-App (2–6).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@kasse-favoriten.at'
const ADMIN_PASSWORT = 'kasse-favoriten-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KF-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Favoriten je Kasse (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let colaId = '', spritzerId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Favoriten GmbH',
        uid:        'ATU99999928',
        kassenId:   'KF-001',
        finanzOnline: { teilnehmerId: 'TID-KF', benutzerkennung: 'BID-KF', pin: 'PIN-KF' },
        umgebung: 'test',
        admin: { name: 'KF Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    const katId = (await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'Getränke', farbe: 'blau', reihenfolge: 0 },
    })).json().id
    const mach = (bezeichnung: string) => srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung, preisBruttoCent: 400, mwstSatz: 'normal', kategorieId: katId },
    }).then(r => r.json().id)
    colaId     = await mach('Cola')
    spritzerId = await mach('Spritzer')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('startet ohne Kassen-Liste (leere eintraege)', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/favoriten`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().eintraege).toEqual([])
  })

  it('speichert Artikel UND Platzhalter in exakter Reihenfolge', async () => {
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/favoriten`, headers: auth(),
      payload: { eintraege: [
        { artikelId: colaId },
        { artikelId: null },        // Platzhalter
        { artikelId: spritzerId },
      ] },
    })
    expect(put.statusCode).toBe(204)

    const res = (await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/favoriten`, headers: auth(),
    })).json()
    expect(res.eintraege).toEqual([
      { artikelId: colaId },
      { artikelId: null },
      { artikelId: spritzerId },
    ])
  })

  it('PUT ersetzt die Liste komplett (kein Anhängen)', async () => {
    await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/favoriten`, headers: auth(),
      payload: { eintraege: [{ artikelId: spritzerId }] },
    })
    const res = (await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/favoriten`, headers: auth(),
    })).json()
    expect(res.eintraege).toEqual([{ artikelId: spritzerId }])
  })

  it('lehnt fremde/unbekannte Artikel-IDs ab (400)', async () => {
    const res = await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/favoriten`, headers: auth(),
      payload: { eintraege: [{ artikelId: '00000000-0000-4000-8000-000000000000' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 für eine unbekannte Kasse', async () => {
    const res = await srv.fastify.inject({
      method: 'PUT', url: '/api/kassen/00000000-0000-4000-8000-000000000001/favoriten', headers: auth(),
      payload: { eintraege: [] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('artikelProZeile: Standard 4, speicherbar 2–6, Unsinn abgelehnt', async () => {
    const vorher = (await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
    })).json()
    expect(vorher.artikelProZeile).toBe(4)

    expect((await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { artikelProZeile: 3 },
    })).statusCode).toBe(204)

    const nachher = (await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
    })).json()
    expect(nachher.artikelProZeile).toBe(3)

    expect((await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { artikelProZeile: 7 },
    })).statusCode).toBe(400)
  })

  it('ein PIN-Kellner liest die Favoritenliste (Kellner-App-Pfad)', async () => {
    const anlage = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: {
        name: 'Aushilfe Fanni', rolle: 'kellner',
        berechtigungen: ['tische', 'kasse'], kassenIds: [kasseId], pin: '5522',
      },
    })
    expect(anlage.statusCode).toBe(201)

    const pinLogin = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/pin-login', payload: { kasseId, pin: '5522' },
    })
    expect(pinLogin.statusCode).toBe(200)

    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/favoriten`,
      headers: { authorization: `Bearer ${pinLogin.json().token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().eintraege).toEqual([{ artikelId: spritzerId }])
  })
})
