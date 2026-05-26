/**
 * Tests für /api/bonierdrucker (CRUD + Testdruck).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const BD_ID = 'bd000000-0000-0000-0000-000000000001'

// ---------------------------------------------------------------------------
// Mock-Hilfsfunktionen
// ---------------------------------------------------------------------------

function makeResult(data: unknown[]) {
  const r: any = {}
  r.then    = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
                Promise.resolve(data).then(ok, err)
  r.limit   = () => r
  r.orderBy = () => r
  return r
}

interface DbQueues {
  selects?: unknown[][]
  inserts?: unknown[][]
  updates?: unknown[][]
  deletes?: unknown[][]
}

function mockDb({ selects = [], inserts = [], updates = [], deletes = [] }: DbQueues = {}): Db {
  let si = 0, ii = 0, ui = 0, di = 0
  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(selects[si++] ?? []),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve(inserts[ii++] ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(updates[ui++] ?? []),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve(deletes[di++] ?? []),
      }),
    }),
  } as unknown as Db
}

const bdRow = (overrides: Record<string, unknown> = {}) => ({
  id:        BD_ID,
  mandantId: TEST_MANDANT_ID,
  name:      'Küchendrucker',
  ip:        '192.168.1.100',
  port:      9100,
  istBackup: false,
  aktiv:     true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz Bonierdrucker', () => {
  it('GET ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/bonierdrucker' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/bonierdrucker
// ---------------------------------------------------------------------------

describe('GET /api/bonierdrucker', () => {
  it('200 und gibt Liste zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[bdRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/bonierdrucker',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].name).toBe('Küchendrucker')
    await srv.close()
  })

  it('200 mit leerer Liste', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/bonierdrucker',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/bonierdrucker
// ---------------------------------------------------------------------------

describe('POST /api/bonierdrucker', () => {
  it('201 bei gültiger Eingabe', async () => {
    const srv = await buildTestServer(mockDb({ inserts: [[bdRow()]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/bonierdrucker',
      headers: srv.authHeader(),
      payload: { name: 'Küchendrucker', ip: '192.168.1.100', port: 9100 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().ip).toBe('192.168.1.100')
    await srv.close()
  })

  it('400 wenn Name fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/bonierdrucker',
      headers: srv.authHeader(),
      payload: { ip: '192.168.1.100' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn IP fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/bonierdrucker',
      headers: srv.authHeader(),
      payload: { name: 'Drucker' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/bonierdrucker/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/bonierdrucker/:id', () => {
  it('200 bei gültigem Update', async () => {
    const updated = bdRow({ name: 'Thekendrucker' })
    const srv = await buildTestServer(mockDb({ updates: [[updated]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/bonierdrucker/${BD_ID}`,
      headers: srv.authHeader(),
      payload: { name: 'Thekendrucker' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Thekendrucker')
    await srv.close()
  })

  it('404 wenn nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ updates: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/bonierdrucker/${BD_ID}`,
      headers: srv.authHeader(),
      payload: { aktiv: false },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/bonierdrucker/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/bonierdrucker/:id', () => {
  it('204 bei erfolgreichem Löschen', async () => {
    const srv = await buildTestServer(mockDb({ deletes: [[{ id: BD_ID }]] }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/bonierdrucker/${BD_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })

  it('404 wenn nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ deletes: [[]] }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/bonierdrucker/${BD_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     '/api/bonierdrucker/keine-uuid',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/bonierdrucker/:id/test
// ---------------------------------------------------------------------------

describe('POST /api/bonierdrucker/:id/test', () => {
  it('404 wenn Drucker nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/bonierdrucker/${BD_ID}/test`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 erfolgreich=false wenn Drucker nicht erreichbar', async () => {
    // Port 19999 auf localhost ist im Test-Kontext nicht geöffnet
    const srv = await buildTestServer(mockDb({
      selects: [[{ ip: '127.0.0.1', port: 19999 }]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/bonierdrucker/${BD_ID}/test`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().erfolgreich).toBe(false)
    expect(res.json().fehler).toBeDefined()
    await srv.close()
  }, 10_000)  // TCP-Timeout abwarten
})
