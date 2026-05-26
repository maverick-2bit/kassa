/**
 * Tests für die Gutschein-Routen.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

function makeResult(data: unknown[]) {
  return {
    then:    (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
               Promise.resolve(data).then(resolve, reject),
    limit:   () => Promise.resolve(data),
    orderBy: () => ({ limit: () => Promise.resolve(data) }),
  }
}

function mockDb(opts: {
  selectQueue?:      unknown[][]
  insertReturning?:  unknown[]
  updateReturning?:  unknown[]
} = {}): Db {
  let idx = 0
  const queue = opts.selectQueue ?? []
  let insIdx = 0
  const insQueue = opts.insertReturning ? [opts.insertReturning] : ([] as unknown[][])

  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(queue[idx++] ?? []),
      }),
    }),
    insert: () => ({
      values: () => {
        const returning = insQueue[insIdx++] ?? []
        return {
          then:      (resolve: (v: unknown) => unknown) => Promise.resolve().then(resolve as any),
          returning: () => Promise.resolve(returning),
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(opts.updateReturning ?? []),
        }),
      }),
    }),
  } as unknown as Db
}

/** Wie mockDb, aber mit separaten insertQueues für Gutschein + Buchung (mehrere Inserts) */
function mockDbMultiInsert(opts: {
  selectQueue?:       unknown[][]
  insertQueue?:       unknown[][]   // Jeder Eintrag = Rückgabe eines insert().values().returning()
  updateReturning?:   unknown[]
}): Db {
  let selIdx = 0
  let insIdx = 0
  const sel = opts.selectQueue  ?? []
  const ins = opts.insertQueue  ?? []

  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(sel[selIdx++] ?? []),
      }),
    }),
    insert: () => ({
      values: () => ({
        then:      (resolve: (v: unknown) => unknown) => Promise.resolve().then(resolve as any),
        returning: () => Promise.resolve(ins[insIdx++] ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(opts.updateReturning ?? []),
        }),
      }),
    }),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Test-Fixtures
// ---------------------------------------------------------------------------

const gsRow = (overrides: Record<string, unknown> = {}) => ({
  id:          'gs-0001',
  mandantId:   TEST_MANDANT_ID,
  code:        'GS-ABCD-EFGH',
  nummer:      1,
  datum:       new Date('2026-01-01T10:00:00Z'),
  status:      'aktiv',
  betragCent:  5000,
  bezahltCent: 0,
  gueltigBis:  null,
  kundeId:     null,
  kundeSnapshot: null,
  notiz:       null,
  createdAt:   new Date('2026-01-01T10:00:00Z'),
  updatedAt:   new Date('2026-01-01T10:00:00Z'),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz', () => {
  it('GET /api/gutscheine ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/gutscheine' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/gutscheine ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine',
      payload: { betragCent: 5000 },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/gutscheine
// ---------------------------------------------------------------------------

describe('GET /api/gutscheine', () => {
  it('listet Gutscheine', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[gsRow(), gsRow({ id: 'gs-0002' })]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/gutscheine',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/gutscheine/code/:code
// ---------------------------------------------------------------------------

describe('GET /api/gutscheine/code/:code', () => {
  it('gibt Gutschein per Code zurück', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[gsRow()]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/gutscheine/code/GS-ABCD-EFGH',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().code).toBe('GS-ABCD-EFGH')
    await srv.close()
  })

  it('404 bei unbekanntem Code', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/gutscheine/code/GS-XXXX-XXXX',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/gutscheine
// ---------------------------------------------------------------------------

describe('POST /api/gutscheine', () => {
  it('erstellt Gutschein (201)', async () => {
    // selectQueue: [0] code-Duplikat-Check → [], [1] Nummern-Aggregate → [{n:1}]
    const db = mockDbMultiInsert({
      selectQueue:  [[], [{ n: 1 }]],
      insertQueue:  [[gsRow()], []],  // [0] Gutschein, [1] Buchung (kein returning)
    })
    const srv = await buildTestServer(db)
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine',
      headers: srv.authHeader(),
      payload: { betragCent: 5000 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().betragCent).toBe(5000)
    expect(res.json().status).toBe('aktiv')
    await srv.close()
  })

  it('400 bei negativem Betrag', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine',
      headers: srv.authHeader(),
      payload: { betragCent: -100 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 bei fehlendem Betrag', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine',
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/gutscheine/:id/einloesen
// ---------------------------------------------------------------------------

describe('POST /api/gutscheine/:id/einloesen', () => {
  it('löst Gutschein vollständig ein', async () => {
    const current  = gsRow()
    const updated  = gsRow({ status: 'eingeloest', bezahltCent: 5000 })
    const db = mockDbMultiInsert({
      selectQueue:  [[current]],
      insertQueue:  [[]],          // Buchung ohne returning
      updateReturning: [updated],
    })
    const srv = await buildTestServer(db)
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/gs-0001/einloesen',
      headers: srv.authHeader(),
      payload: { einloesungCent: 5000 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().gutschein.status).toBe('eingeloest')
    await srv.close()
  })

  it('400 wenn Gutschein bereits storniert', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[gsRow({ status: 'storniert' })]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/gs-0001/einloesen',
      headers: srv.authHeader(),
      payload: { einloesungCent: 100 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn Einlösungsbetrag den Restwert übersteigt', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[gsRow({ betragCent: 1000 })]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/gs-0001/einloesen',
      headers: srv.authHeader(),
      payload: { einloesungCent: 9999 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 bei unbekanntem Gutschein', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/gs-9999/einloesen',
      headers: srv.authHeader(),
      payload: { einloesungCent: 100 },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/gutscheine/:id/stornieren
// ---------------------------------------------------------------------------

describe('POST /api/gutscheine/:id/stornieren', () => {
  it('storniert einen aktiven Gutschein', async () => {
    const current = gsRow()
    const updated = gsRow({ status: 'storniert' })
    const db = mockDbMultiInsert({
      selectQueue:     [[current]],
      insertQueue:     [[]],       // Buchung
      updateReturning: [updated],
    })
    const srv = await buildTestServer(db)
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/gs-0001/stornieren',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('storniert')
    await srv.close()
  })

  it('400 wenn Gutschein bereits storniert', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[gsRow({ status: 'storniert' })]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/gs-0001/stornieren',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn Gutschein bereits vollständig eingelöst', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[gsRow({ status: 'eingeloest' })]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/gs-0001/stornieren',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})
