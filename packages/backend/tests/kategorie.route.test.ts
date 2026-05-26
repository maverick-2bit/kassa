/**
 * Tests für /api/kategorien (CRUD).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KAT_ID = 'ca000000-0000-0000-0000-000000000001'

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
}

function mockDb({ selects = [], inserts = [], updates = [] }: DbQueues = {}): Db {
  let si = 0, ii = 0, ui = 0
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
  } as unknown as Db
}

const katRow = (overrides: Record<string, unknown> = {}) => ({
  id:              KAT_ID,
  mandantId:       TEST_MANDANT_ID,
  name:            'Getränke',
  farbe:           'blau',
  reihenfolge:     0,
  aktiv:           true,
  bonierdruckerId: null,
  createdAt:       new Date(),
  updatedAt:       new Date(),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz Kategorien', () => {
  it('POST ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/kategorien', payload: {} })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kategorien
// ---------------------------------------------------------------------------

describe('POST /api/kategorien', () => {
  it('201 bei gültiger Eingabe', async () => {
    const srv = await buildTestServer(mockDb({ inserts: [[katRow()]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/kategorien',
      headers: srv.authHeader(),
      payload: { name: 'Getränke', farbe: 'blau', reihenfolge: 0 },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe('Getränke')
    await srv.close()
  })

  it('400 wenn Name fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/kategorien',
      headers: srv.authHeader(),
      payload: { farbe: 'blau' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn Farbe ungültig', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/kategorien',
      headers: srv.authHeader(),
      payload: { name: 'Test', farbe: 'lila-rosa-ungültig' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kategorien
// ---------------------------------------------------------------------------

describe('GET /api/kategorien', () => {
  it('200 und gibt Liste zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[katRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kategorien',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0].name).toBe('Getränke')
    await srv.close()
  })

  it('200 mit leerer Liste', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kategorien',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/kategorien/:id
// ---------------------------------------------------------------------------

describe('PUT /api/kategorien/:id', () => {
  it('200 bei gültigem Update', async () => {
    const updated = katRow({ name: 'Warme Getränke' })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KAT_ID }]],   // ownership-check
      updates: [[updated]],
    }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/kategorien/${KAT_ID}`,
      headers: srv.authHeader(),
      payload: { name: 'Warme Getränke' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Warme Getränke')
    await srv.close()
  })

  it('404 wenn Kategorie nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/kategorien/${KAT_ID}`,
      headers: srv.authHeader(),
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     '/api/kategorien/keine-uuid',
      headers: srv.authHeader(),
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/kategorien/:id  (Soft-Delete)
// ---------------------------------------------------------------------------

describe('DELETE /api/kategorien/:id', () => {
  it('200 und setzt aktiv=false', async () => {
    const deaktiviert = katRow({ aktiv: false })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KAT_ID }]],   // ownership-check
      updates: [[deaktiviert]],
    }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/kategorien/${KAT_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().aktiv).toBe(false)
    await srv.close()
  })

  it('404 wenn Kategorie nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/kategorien/${KAT_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})
