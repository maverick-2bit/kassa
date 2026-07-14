/**
 * Tests für /api/drucker (Bondrucker-Bibliothek: CRUD + Testdruck).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const D_ID = 'dd000000-0000-0000-0000-000000000001'

function makeResult(data: unknown[]) {
  const r: any = {}
  r.then    = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
                Promise.resolve(data).then(ok, err)
  r.limit   = () => r
  r.orderBy = () => r
  return r
}

interface DbQueues { selects?: unknown[][]; inserts?: unknown[][]; updates?: unknown[][]; deletes?: unknown[][] }

function mockDb({ selects = [], inserts = [], updates = [], deletes = [] }: DbQueues = {}): Db {
  let si = 0, ii = 0, ui = 0, di = 0
  return {
    select: () => ({ from: () => ({ where: () => makeResult(selects[si++] ?? []) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve(inserts[ii++] ?? []) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(updates[ui++] ?? []) }) }) }),
    delete: () => ({ where: () => ({ returning: () => Promise.resolve(deletes[di++] ?? []) }) }),
  } as unknown as Db
}

const dRow = (overrides: Record<string, unknown> = {}) => ({
  id:            D_ID,
  mandantId:     TEST_MANDANT_ID,
  name:          'Kasse vorne',
  ip:            '192.168.1.100',
  port:          9100,
  breiteZeichen: 48,
  timeoutSek:    5,
  aktiv:         true,
  createdAt:     new Date(),
  updatedAt:     new Date(),
  ...overrides,
})

describe('Auth-Schutz Drucker-Bibliothek', () => {
  it('GET ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/drucker' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

describe('GET /api/drucker', () => {
  it('200 mit Liste (DTO: breite + timeoutSek)', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[dRow()]] }))
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/drucker', headers: srv.authHeader() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0].name).toBe('Kasse vorne')
    expect(body[0].breite).toBe(48)
    expect(body[0].timeoutSek).toBe(5)
    await srv.close()
  })
})

describe('POST /api/drucker', () => {
  it('201 bei gültiger Eingabe', async () => {
    const srv = await buildTestServer(mockDb({ inserts: [[dRow()]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/drucker', headers: srv.authHeader(),
      payload: { name: 'Kasse vorne', ip: '192.168.1.100', port: 9100, breite: 48, timeoutSek: 5 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().breite).toBe(48)
    await srv.close()
  })

  it('400 wenn Name fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/drucker', headers: srv.authHeader(), payload: { ip: '192.168.1.100' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

describe('PATCH /api/drucker/:id', () => {
  it('200 aktualisiert (frischt Kassen-Snapshot mit auf)', async () => {
    // updates[0] = geänderte Pool-Zeile; der anschließende kassen-Snapshot-Update ist ein No-op im Mock
    const srv = await buildTestServer(mockDb({ updates: [[dRow({ ip: '10.0.0.9' })]] }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/drucker/${D_ID}`, headers: srv.authHeader(), payload: { ip: '10.0.0.9' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ip).toBe('10.0.0.9')
    await srv.close()
  })

  it('404 wenn Drucker nicht existiert', async () => {
    const srv = await buildTestServer(mockDb({ updates: [[]] }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/drucker/${D_ID}`, headers: srv.authHeader(), payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

describe('DELETE /api/drucker/:id', () => {
  it('204 (löst Kassen ab, dann löscht)', async () => {
    const srv = await buildTestServer(mockDb({ deletes: [[{ id: D_ID }]] }))
    const res = await srv.fastify.inject({ method: 'DELETE', url: `/api/drucker/${D_ID}`, headers: srv.authHeader() })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })

  it('404 wenn nicht vorhanden', async () => {
    const srv = await buildTestServer(mockDb({ deletes: [[]] }))
    const res = await srv.fastify.inject({ method: 'DELETE', url: `/api/drucker/${D_ID}`, headers: srv.authHeader() })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

describe('POST /api/drucker/:id/test', () => {
  it('404 wenn Drucker nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/drucker/${D_ID}/test`, headers: srv.authHeader() })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})
