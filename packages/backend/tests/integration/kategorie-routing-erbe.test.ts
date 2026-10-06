/**
 * Integrationstest: Untergruppen erben die KDS-Station der Elterngruppe.
 *
 * Anlass: Wer an der Hauptgruppe ("Kellner Getränke") die KDS-Station setzte, bekam beim
 * Bonieren von Artikeln einer UNTERgruppe die Meldung "Kein Artikel hat eine KDS-Station
 * oder einen Bonierdrucker" — das Routing las nur die Gruppe, in der der Artikel direkt steckt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL = 'admin@routing-erbe.at', ADMIN_PASSWORT = 'routing-erbe-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'RE-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Untergruppen erben die KDS-Station (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = ''
  let colaId = '', wasserId = '', loseId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = async (url: string, payload: unknown) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  const bonieren = (artikelId: string) => srv.fastify.inject({
    method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
    payload: { kasseId, tisch: '5', kellner: 'Anna', positionen: [{ artikelId, menge: 1 }] },
  })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Routing GmbH', uid: 'ATU99999961', kassenId: 'RE-001',
        finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
        admin: { name: 'RE Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    // KDS an dieser Kasse einschalten (Browser-KDS: keine IP nötig)
    const kds = await srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasseId}/kds`, headers: auth(), payload: { kdsAktiv: true } })
    expect(kds.statusCode).toBe(200)

    // Hauptgruppe MIT Station, Untergruppe OHNE; daneben eine Gruppe ganz ohne Station
    const haupt = (await post('/api/kategorien', { name: 'Kellner Getränke', farbe: 'blau', reihenfolge: 0, station: 'schank' })).id
    const unter = (await post('/api/kategorien', { name: 'Alkoholfrei', farbe: 'blau', reihenfolge: 0, parentId: haupt })).id
    const lose  = (await post('/api/kategorien', { name: 'Ohne Station', farbe: 'blau', reihenfolge: 1 })).id

    const mach = async (bezeichnung: string, kategorieId: string) =>
      (await post('/api/artikel', { bezeichnung, preisBruttoCent: 400, mwstSatz: 'normal', kategorieId })).id
    colaId   = await mach('Cola', haupt)
    wasserId = await mach('Wasser', unter)
    loseId   = await mach('Ohne Station Artikel', lose)
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('Artikel direkt in der Hauptgruppe: wird an die Station geroutet (wie bisher)', async () => {
    const res = await bonieren(colaId)
    expect(res.statusCode).toBe(200)
  })

  it('Artikel in der UNTERgruppe: erbt die Station der Hauptgruppe (kein "nichts zu bonieren")', async () => {
    const res = await bonieren(wasserId)
    expect(res.statusCode, res.body).toBe(200)
  })

  it('Gruppe ohne Station in der ganzen Kette: weiterhin "nichts zu bonieren" (400)', async () => {
    const res = await bonieren(loseId)
    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toMatch(/nichts zu bonieren/)
  })
})
