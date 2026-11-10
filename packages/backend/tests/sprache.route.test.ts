/**
 * Zugriffsschutz der Sprach-Routen (Synonyme): Login, Berechtigung, Modul-Sperre, Eingabeprüfung.
 * Die Datenbank-Abläufe (ersetzen, Konflikte, Katalog) laufen im Integrationstest.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const ART_ID = 'ca000000-0000-0000-0000-0000000000a1'

/** select().from().where().limit() liefert nacheinander die übergebenen Antworten. */
function mockDb(selects: unknown[][] = []): { db: Db; abfragen: () => number } {
  let si = 0
  const result = (data: unknown[]) => {
    const r: any = {}
    r.then  = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(data).then(ok, err)
    r.limit = () => r
    return r
  }
  const db = { select: () => ({ from: () => ({ where: () => result(selects[si++] ?? []) }) }) } as unknown as Db
  return { db, abfragen: () => si }
}

describe('Sprach-Routen — Zugriffsschutz', () => {
  it('ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb().db)
    for (const [method, url] of [['GET', '/api/sprache/synonyme'], ['GET', `/api/sprache/artikel/${ART_ID}/synonyme`], ['PUT', `/api/sprache/artikel/${ART_ID}/synonyme`]] as const) {
      expect((await srv.fastify.inject({ method, url, payload: method === 'PUT' ? { synonyme: [] } : undefined })).statusCode).toBe(401)
    }
    await srv.close()
  })

  it('Kellner ohne „artikel.verwalten" → 403, ohne die Datenbank zu fragen', async () => {
    const { db, abfragen } = mockDb()
    const srv = await buildTestServer(db)
    const headers = srv.authHeader({ rolle: 'kellner', berechtigungen: ['tische'] })
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/sprache/synonyme', headers })).statusCode).toBe(403)
    expect((await srv.fastify.inject({ method: 'PUT', url: `/api/sprache/artikel/${ART_ID}/synonyme`, headers, payload: { synonyme: ['x'] } })).statusCode).toBe(403)
    expect(abfragen()).toBe(0)
    await srv.close()
  })

  it('Modul aus → 403 mit klarer Meldung (auch für Admin)', async () => {
    const srv = await buildTestServer(mockDb([[{ aktiv: false }]]).db)
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/sprache/synonyme', headers: srv.authHeader() })
    expect(res.statusCode).toBe(403)
    expect(res.json().fehler).toMatch(/nicht aktiviert/)
    await srv.close()
  })

  it('Berechtigung „artikel.verwalten" genügt statt Admin (Modul aus → trotzdem 403)', async () => {
    const srv = await buildTestServer(mockDb([[{ aktiv: false }]]).db)
    const headers = srv.authHeader({ rolle: 'kellner', berechtigungen: ['artikel.verwalten'] })
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/sprache/synonyme', headers })
    expect(res.statusCode).toBe(403)
    expect(res.json().fehler).toMatch(/nicht aktiviert/) // Berechtigung ging durch, Modul sperrt
    await srv.close()
  })

  it('PUT: ungültige ID und ungültiger Body → 400, bevor irgendetwas geprüft wird', async () => {
    const { db, abfragen } = mockDb()
    const srv = await buildTestServer(db)
    const headers = srv.authHeader()
    expect((await srv.fastify.inject({ method: 'PUT', url: '/api/sprache/artikel/keine-id/synonyme', headers, payload: { synonyme: [] } })).statusCode).toBe(400)
    expect((await srv.fastify.inject({ method: 'PUT', url: `/api/sprache/artikel/${ART_ID}/synonyme`, headers, payload: {} })).statusCode).toBe(400)
    expect((await srv.fastify.inject({ method: 'PUT', url: `/api/sprache/artikel/${ART_ID}/synonyme`, headers, payload: { synonyme: ['ok', ''] } })).statusCode).toBe(400)
    expect((await srv.fastify.inject({ method: 'PUT', url: `/api/sprache/artikel/${ART_ID}/synonyme`, headers, payload: { synonyme: Array.from({ length: 21 }, (_, i) => `s${i}`) } })).statusCode).toBe(400)
    expect((await srv.fastify.inject({ method: 'PUT', url: `/api/sprache/artikel/${ART_ID}/synonyme`, headers, payload: { synonyme: ['x'.repeat(81)] } })).statusCode).toBe(400)
    expect(abfragen()).toBe(0)
    await srv.close()
  })
})
