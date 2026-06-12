/**
 * Tests für /api/modifikator-gruppen und /api/modifikatoren (CRUD).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const GRUPPE_ID  = 'dd000000-0000-0000-0000-000000000001'
const MOD_ID     = 'ed000000-0000-0000-0000-000000000001'
const ARTIKEL_ID = 'ad000000-0000-0000-0000-000000000001'

// ---------------------------------------------------------------------------
// Mock-Hilfsfunktionen
// ---------------------------------------------------------------------------

function makeResult(data: unknown[]) {
  const r: any = {}
  r.then    = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
                Promise.resolve(data).then(ok, err)
  r.limit   = () => r
  r.orderBy = () => r
  r.where   = () => r
  return r
}

interface DbQueues {
  selects?: unknown[][]
  inserts?: unknown[][]
  updates?: unknown[][]
  deletes?: number[]
}

function mockDb({ selects = [], inserts = [], updates = [], deletes = [] }: DbQueues = {}): Db {
  let si = 0, ii = 0, ui = 0, di = 0
  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(selects[si++] ?? []),
        orderBy: () => ({ where: () => makeResult(selects[si++] ?? []) }),
        innerJoin: () => ({ where: () => makeResult(selects[si++] ?? []) }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve(inserts[ii++] ?? []),
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(inserts[ii++] ?? []),
        }),
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
      where: () => Promise.resolve({ count: deletes[di++] ?? 0 }),
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn({
      delete: () => ({
        where: () => Promise.resolve({ count: 0 }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(inserts[ii++] ?? []),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => makeResult(selects[si++] ?? []),
        }),
      }),
    } as unknown as Db),
  } as unknown as Db
}

function gruppeRow(overrides: Record<string, unknown> = {}) {
  return {
    id:          GRUPPE_ID,
    mandantId:   TEST_MANDANT_ID,
    name:        'Größe',
    typ:         'optional',
    maxAuswahl:  null,
    reihenfolge: 0,
    aktiv:       true,
    createdAt:   new Date(),
    updatedAt:   new Date(),
    ...overrides,
  }
}

function modRow(overrides: Record<string, unknown> = {}) {
  return {
    id:              MOD_ID,
    mandantId:       TEST_MANDANT_ID,
    gruppeId:        GRUPPE_ID,
    name:            'Klein',
    aufschlagCent:   0,
    reihenfolge:     0,
    aktiv:           true,
    lagerstandMenge: null,
    createdAt:       new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz Modifikatoren', () => {
  it('GET /api/modifikator-gruppen ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/modifikator-gruppen ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/modifikator-gruppen', payload: {} })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/modifikator-gruppen
// ---------------------------------------------------------------------------

describe('GET /api/modifikator-gruppen', () => {
  it('200 mit leerer Liste', async () => {
    // service macht 1 select (gruppen), gibt leer zurück → keine 2. Abfrage
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/modifikator-gruppen',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })

  it('200 und gibt Gruppen mit Modifikatoren zurück', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[gruppeRow()], [modRow()]],   // 1. select: gruppen, 2. select: mods
    }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/modifikator-gruppen',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].name).toBe('Größe')
    expect(body[0].modifikatoren).toHaveLength(1)
    expect(body[0].modifikatoren[0].name).toBe('Klein')
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/modifikator-gruppen
// ---------------------------------------------------------------------------

describe('POST /api/modifikator-gruppen', () => {
  it('400 wenn Name fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/modifikator-gruppen',
      headers: srv.authHeader(),
      payload: { typ: 'optional' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 bei ungültigem Typ', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/modifikator-gruppen',
      headers: srv.authHeader(),
      payload: { name: 'Größe', typ: 'ungueltig' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('201 bei gültiger Eingabe', async () => {
    // service: insert gruppe, dann select gruppen + select mods für response
    const srv = await buildTestServer(mockDb({
      inserts: [[gruppeRow()]],
      selects: [[gruppeRow()], [modRow()]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/modifikator-gruppen',
      headers: srv.authHeader(),
      payload: { name: 'Größe', typ: 'optional' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().name).toBe('Größe')
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/modifikator-gruppen/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/modifikator-gruppen/:id', () => {
  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/modifikator-gruppen/keine-uuid',
      headers: srv.authHeader(),
      payload: { name: 'Neue Größe' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Gruppe nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/modifikator-gruppen/${GRUPPE_ID}`,
      headers: srv.authHeader(),
      payload: { name: 'Neue Größe' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 bei gültigem Update', async () => {
    const updated = gruppeRow({ name: 'Neue Größe' })
    const srv = await buildTestServer(mockDb({
      selects: [[gruppeRow()], [updated], []],
      updates: [[updated]],
    }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/modifikator-gruppen/${GRUPPE_ID}`,
      headers: srv.authHeader(),
      payload: { name: 'Neue Größe' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Neue Größe')
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/modifikator-gruppen/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/modifikator-gruppen/:id', () => {
  it('404 wenn Gruppe nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/modifikator-gruppen/${GRUPPE_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('204 bei erfolgreichem Löschen', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[gruppeRow()]],
      deletes: [1],
    }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/modifikator-gruppen/${GRUPPE_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/modifikator-gruppen/:gruppeId/modifikatoren
// ---------------------------------------------------------------------------

describe('POST /api/modifikator-gruppen/:gruppeId/modifikatoren', () => {
  it('400 wenn Name fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/modifikator-gruppen/${GRUPPE_ID}/modifikatoren`,
      headers: srv.authHeader(),
      payload: { aufschlagCent: 0 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Gruppe nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/modifikator-gruppen/${GRUPPE_ID}/modifikatoren`,
      headers: srv.authHeader(),
      payload: { name: 'Klein', aufschlagCent: 0 },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('201 bei gültiger Option', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[gruppeRow()], [gruppeRow()], []],
      inserts: [[modRow()]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/modifikator-gruppen/${GRUPPE_ID}/modifikatoren`,
      headers: srv.authHeader(),
      payload: { name: 'Klein', aufschlagCent: 0 },
    })
    expect(res.statusCode).toBe(201)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/modifikatoren/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/modifikatoren/:id', () => {
  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/modifikatoren/keine-uuid',
      headers: srv.authHeader(),
      payload: { name: 'Groß' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Modifikator nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/modifikatoren/${MOD_ID}`,
      headers: srv.authHeader(),
      payload: { name: 'Groß' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 bei gültigem Update', async () => {
    const updated = modRow({ name: 'Groß' })
    const srv = await buildTestServer(mockDb({
      selects: [[modRow()], [gruppeRow()], []],
      updates: [[updated]],
    }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/modifikatoren/${MOD_ID}`,
      headers: srv.authHeader(),
      payload: { name: 'Groß' },
    })
    expect(res.statusCode).toBe(200)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/modifikatoren/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/modifikatoren/:id', () => {
  it('404 wenn Modifikator nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/modifikatoren/${MOD_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('204 bei erfolgreichem Löschen', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[modRow()]],
      deletes: [1],
    }))
    const res = await srv.fastify.inject({
      method:  'DELETE',
      url:     `/api/modifikatoren/${MOD_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/artikel-modifikator-gruppen
// ---------------------------------------------------------------------------

describe('GET /api/artikel-modifikator-gruppen', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/artikel-modifikator-gruppen',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('200 gibt Zuweisungen zurück', async () => {
    const zuweisung = { artikelId: ARTIKEL_ID, gruppeId: GRUPPE_ID, reihenfolge: 0 }
    const srv = await buildTestServer(mockDb({ selects: [[zuweisung]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/artikel-modifikator-gruppen',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].artikelId).toBe(ARTIKEL_ID)
    await srv.close()
  })
})
