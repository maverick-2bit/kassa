/**
 * Tests für /api/angebote (CRUD).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID = 'fa000000-0000-0000-0000-000000000001'
const ANG_ID   = 'ab000000-0000-0000-0000-000000000001'

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

const angRow = (overrides: Record<string, unknown> = {}) => ({
  id:               ANG_ID,
  mandantId:        TEST_MANDANT_ID,
  kasseId:          KASSE_ID,
  nummer:           1,
  datum:            new Date(),
  status:           'offen',
  positionen:       [{ bezeichnung: 'Consulting', menge: 1, einzelpreisBreutto: 10000, mwstSatz: 'normal' }],
  gesamtbetragCent: 10000,
  gueltigBis:       null,
  notiz:            null,
  kundeId:          null,
  kundeSnapshot:    null,
  createdAt:        new Date(),
  updatedAt:        new Date(),
  ...overrides,
})

const validPositionen = [
  { bezeichnung: 'Consulting', menge: 1, einzelpreisBreutto: 10000, mwstSatz: 'normal' },
]

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz Angebote', () => {
  it('GET ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/angebote' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/angebote
// ---------------------------------------------------------------------------

describe('GET /api/angebote', () => {
  it('200 und gibt Liste zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[angRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/angebote',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].id).toBe(ANG_ID)
    await srv.close()
  })

  it('200 mit leerer Liste', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/angebote',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/angebote/:id
// ---------------------------------------------------------------------------

describe('GET /api/angebote/:id', () => {
  it('200 gibt Angebot zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[angRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/angebote/${ANG_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(ANG_ID)
    await srv.close()
  })

  it('404 wenn nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/angebote/${ANG_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/angebote
// ---------------------------------------------------------------------------

describe('POST /api/angebote', () => {
  it('201 erstellt Angebot', async () => {
    // erstelleAngebot: 1. select kasse, 2. select MAX(nummer), 3. insert
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [{ n: 1 }]],
      inserts: [[angRow()]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/angebote',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, positionen: validPositionen },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().nummer).toBe(1)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/angebote',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, positionen: validPositionen },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 wenn Positionen fehlen', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/angebote',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, positionen: [] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn kasseId fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/angebote',
      headers: srv.authHeader(),
      payload: { positionen: validPositionen },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/angebote/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/angebote/:id', () => {
  it('200 ändert Status', async () => {
    const updated = angRow({ status: 'angenommen' })
    const srv = await buildTestServer(mockDb({ updates: [[updated]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/angebote/${ANG_ID}`,
      headers: srv.authHeader(),
      payload: { status: 'angenommen' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('angenommen')
    await srv.close()
  })

  it('404 wenn nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ updates: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/angebote/${ANG_ID}`,
      headers: srv.authHeader(),
      payload: { status: 'abgelehnt' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültigem Status', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/angebote/${ANG_ID}`,
      headers: srv.authHeader(),
      payload: { status: 'ungueltig' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})
