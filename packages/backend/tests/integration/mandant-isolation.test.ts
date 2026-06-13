/**
 * Integrationstest: Mandanten-Isolation gegen echtes PostgreSQL.
 *
 * Zwei Mandanten in derselben Datenbank — Mandant B darf weder Kassen,
 * Belege noch Artikel von Mandant A sehen oder benutzen.
 * Erwartetes Verhalten laut Konvention: 404 (nicht 403), damit die
 * Existenz fremder Ressourcen nicht erkennbar ist.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: number) {
  return {
    firmenname: `Isolationstest ${nr} GmbH`,
    uid:        `ATU9999991${nr}`,
    kassenId:   `ISO-00${nr}`,
    finanzOnline: {
      teilnehmerId:    `TID-ISO-${nr}`,
      benutzerkennung: `BID-ISO-${nr}`,
      pin:             `PIN-ISO-${nr}`,
    },
    umgebung: 'test',
    admin: {
      name:     `Admin ${nr}`,
      email:    `admin${nr}@isolationstest.at`,
      passwort: 'isolationstest-passwort-123',
    },
  }
}

describe('Mandanten-Isolation (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA: string, tokenB: string
  let kasseA: string, kasseB: string

  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    for (const [nr, ziel] of [[1, 'A'], [2, 'B']] as const) {
      const setupRes = await srv.fastify.inject({
        method: 'POST', url: '/api/setup', payload: setupInput(nr),
      })
      if (setupRes.statusCode !== 201) {
        throw new Error(`Setup ${ziel} fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)
      }
      const loginRes = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@isolationstest.at`, passwort: 'isolationstest-passwort-123' },
      })
      if (loginRes.statusCode !== 200) {
        throw new Error(`Login ${ziel} fehlgeschlagen (${loginRes.statusCode}): ${loginRes.body}`)
      }
      const login = loginRes.json()
      if (ziel === 'A') { tokenA = login.token; kasseA = login.kassen[0].id }
      else              { tokenB = login.token; kasseB = login.kassen[0].id }
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Login liefert jedem Mandanten nur die eigene Kasse', () => {
    expect(kasseA).toBeTruthy()
    expect(kasseB).toBeTruthy()
    expect(kasseA).not.toBe(kasseB)
  })

  it('Mandant B kann keine Belege der Kasse von A lesen (404)', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseA}`, headers: authB(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('Mandant B kann nicht auf der Kasse von A bonieren (404)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung',
      headers: authB(),
      payload: {
        kasseId: kasseA,
        positionen: [{ bezeichnung: 'Fremdbuchung', preisBruttoCent: 100, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 100, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(404)
  })

  it('Artikel von A sind für B unsichtbar', async () => {
    const anlegen = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel',
      headers: authA(),
      payload: { bezeichnung: 'Geheimes Schnitzel', preisBruttoCent: 1590, mwstSatz: 'normal' },
    })
    expect([200, 201]).toContain(anlegen.statusCode)

    const listeB = await srv.fastify.inject({
      method: 'GET', url: '/api/artikel', headers: authB(),
    })
    expect(listeB.statusCode).toBe(200)
    const artikelB = listeB.json() as { bezeichnung: string }[]
    expect(artikelB.find(a => a.bezeichnung === 'Geheimes Schnitzel')).toBeUndefined()

    const listeA = await srv.fastify.inject({
      method: 'GET', url: '/api/artikel', headers: authA(),
    })
    const artikelA = listeA.json() as { bezeichnung: string }[]
    expect(artikelA.find(a => a.bezeichnung === 'Geheimes Schnitzel')).toBeDefined()
  })

  it('Kassen-Status der fremden Kasse ist nicht abrufbar (404)', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseA}/status`, headers: authB(),
    })
    expect(res.statusCode).toBe(404)
  })
})
