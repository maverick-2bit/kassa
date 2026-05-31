/**
 * Tests für /api/kds/* (Browser-KDS-Routen).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const BON_ID  = 'bd000000-0000-0000-0000-000000000001'
const POS_ID  = 'pd000000-0000-0000-0000-000000000001'

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
  updates?: unknown[][]
}

function mockDb({ selects = [], updates = [] }: DbQueues = {}): Db {
  let si = 0, ui = 0
  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(selects[si++] ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(updates[ui++] ?? []),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db
}

function bonRow(overrides: Record<string, unknown> = {}) {
  return {
    id:         BON_ID,
    mandantId:  TEST_MANDANT_ID,
    bonNummer:  'B-001',
    station:    'kueche',
    tisch:      '5',
    bereich:    null,
    kellner:    'Maria',
    positionen: [{ id: POS_ID, bezeichnung: 'Schnitzel', menge: 1, erledigt: false }],
    status:     'offen',
    erstelltAt: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// GET /api/kds/events  (SSE)
// ---------------------------------------------------------------------------

describe('GET /api/kds/events', () => {
  it('401 wenn Token fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/kds/events?station=kueche',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('401 bei ungültigem Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/kds/events?station=kueche&token=nicht-ein-jwt',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 wenn Station fehlt', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const token = srv.signTestToken()
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    `/api/kds/events?token=${token}`,
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 und liefert SSE-Stream bei gültigem Token + Station', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[bonRow()]] }))
    const token = srv.signTestToken()
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    `/api/kds/events?station=kueche&token=${token}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body).toContain('data:')
    expect(res.body).toContain('"typ":"snapshot"')
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kds/bons
// ---------------------------------------------------------------------------

describe('GET /api/kds/bons', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/kds/bons?station=kueche',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 wenn Station fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kds/bons',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 und gibt offene Bons zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[bonRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kds/bons?station=kueche',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0].bonNummer).toBe('B-001')
    expect(body[0].station).toBe('kueche')
    await srv.close()
  })

  it('200 mit leerer Liste', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kds/bons?station=kueche',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kds/bon/:id/erledigt
// ---------------------------------------------------------------------------

describe('POST /api/kds/bon/:id/erledigt', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST',
      url:    `/api/kds/bon/${BON_ID}/erledigt`,
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/kds/bon/keine-uuid/erledigt',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Bon nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/erledigt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('404 wenn Bon bereits erledigt', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[bonRow({ status: 'erledigt' })]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/erledigt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 bei erfolgreichem Abschluss', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[bonRow()]],
      updates: [[bonRow({ status: 'erledigt' })]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/erledigt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().erfolgreich).toBe(true)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kds/bon/:id/teilbon
// ---------------------------------------------------------------------------

describe('POST /api/kds/bon/:id/teilbon', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      payload: { positionIds: [POS_ID] },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 bei ungültiger UUID im Pfad', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/kds/bon/keine-uuid/teilbon',
      headers: srv.authHeader(),
      payload: { positionIds: [POS_ID] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn positionIds leer', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: { positionIds: [] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn positionIds fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Bon nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: { positionIds: [POS_ID] },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 bei erfolgreichem Teilbon', async () => {
    const updatedBon = bonRow({
      positionen: [{ id: POS_ID, bezeichnung: 'Schnitzel', menge: 1, erledigt: true }],
      status: 'erledigt',
    })
    const srv = await buildTestServer(mockDb({
      selects: [[bonRow()]],
      updates: [[updatedBon]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: { positionIds: [POS_ID] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().erfolgreich).toBe(true)
    await srv.close()
  })
})
