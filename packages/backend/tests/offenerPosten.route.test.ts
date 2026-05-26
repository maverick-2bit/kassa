/**
 * Tests für die Offene-Posten-Routen.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

/** Thenable + chainbar (limit / leftJoin) */
function makeResult(data: unknown[]) {
  const chain = {
    then:     (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve(data).then(resolve, reject),
    limit:    () => Promise.resolve(data),
    orderBy:  () => ({ limit: () => Promise.resolve(data) }),
    leftJoin: () => ({
      where: () => ({ limit: () => Promise.resolve(data) }),
    }),
  }
  return chain
}

function mockDb(opts: {
  selectQueue?:      unknown[][]
  insertReturning?:  unknown[]
  updateReturning?:  unknown[]
} = {}): Db {
  let idx = 0
  const queue = opts.selectQueue ?? []

  return {
    select: () => ({
      from: () => ({
        where:    () => makeResult(queue[idx++] ?? []),
        leftJoin: () => ({
          where: () => makeResult(queue[idx++] ?? []),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        then:      (resolve: (v: unknown) => unknown) => Promise.resolve().then(resolve as any),
        returning: () => Promise.resolve(opts.insertReturning ?? []),
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

const kundeDbRow = () => ({
  id:          'c0c0c0c0-0000-0000-0000-000000000001',
  mandantId:   TEST_MANDANT_ID,
  nummer:      1,
  firma:       null,
  vorname:     'Max',
  nachname:    'Mustermann',
  email:       null,
  telefon:     null,
  strasse:     null,
  plz:         null,
  ort:         null,
  land:        'AT',
  uid:         null,
  aktiv:       true,
  kreditAktiv: false,
  createdAt:   new Date('2026-01-01'),
  updatedAt:   new Date('2026-01-01'),
})

const opDbRow = (overrides: Record<string, unknown> = {}) => ({
  id:            'd0d0d0d0-0000-0000-0000-000000000001',
  mandantId:     TEST_MANDANT_ID,
  nummer:        1,
  datum:         new Date('2026-01-01T10:00:00Z'),
  status:        'offen',
  kundeId:       'c0c0c0c0-0000-0000-0000-000000000001',
  kundeSnapshot: null,
  belegId:       null,
  belegNummer:   null,
  betragCent:    10000,
  bezahltCent:   0,
  notiz:         null,
  createdAt:     new Date('2026-01-01T10:00:00Z'),
  updatedAt:     new Date('2026-01-01T10:00:00Z'),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz', () => {
  it('GET /api/offene-posten ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/offene-posten ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten',
      payload: { kundeId: 'c0c0c0c0-0000-0000-0000-000000000001', betragCent: 5000 },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/offene-posten
// ---------------------------------------------------------------------------

describe('GET /api/offene-posten', () => {
  it('listet offene Posten (mit leftJoin)', async () => {
    const rows = [opDbRow(), opDbRow({ id: 'd0d0d0d0-0000-0000-0000-000000000002' })]
    const srv  = await buildTestServer(mockDb({ selectQueue: [rows] }))
    const res  = await srv.fastify.inject({
      method: 'GET', url: '/api/offene-posten',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/offene-posten/statistik
// ---------------------------------------------------------------------------

describe('GET /api/offene-posten/statistik', () => {
  it('gibt Anzahl und Gesamtbetrag zurück', async () => {
    // statistik-Query: thenable where ohne limit
    const rows = [
      { betragCent: 10000, bezahltCent: 3000 },
      { betragCent: 5000,  bezahltCent: 0 },
    ]
    const srv = await buildTestServer(mockDb({ selectQueue: [rows] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/offene-posten/statistik',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.anzahl).toBe(2)
    expect(body.gesamtRestCent).toBe(12000)   // (10000-3000) + (5000-0)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/offene-posten/:id
// ---------------------------------------------------------------------------

describe('GET /api/offene-posten/:id', () => {
  it('gibt offenen Posten zurück (mit leftJoin)', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[opDbRow()]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/offene-posten/d0d0d0d0-0000-0000-0000-000000000001',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().betragCent).toBe(10000)
    await srv.close()
  })

  it('404 wenn nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/offene-posten/d0d0d0d0-0000-0000-0000-000000009999',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/offene-posten
// ---------------------------------------------------------------------------

describe('POST /api/offene-posten', () => {
  it('erstellt offenen Posten (201)', async () => {
    // selectQueue[0]: Kunden-Lookup → [kundeRow]
    // selectQueue[1]: Nummern-Aggregate → [{n:1}]
    // insertReturning: [opRow]
    // selectQueue[2]: holeOffenerPosten (leftJoin) → [opRow]
    const srv = await buildTestServer(mockDb({
      selectQueue:     [[kundeDbRow()], [{ n: 1 }], [opDbRow()]],
      insertReturning: [opDbRow()],
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten',
      headers: srv.authHeader(),
      payload: {
        kundeId:    'c0c0c0c0-0000-0000-0000-000000000001',
        betragCent: 10000,
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().betragCent).toBe(10000)
    expect(res.json().status).toBe('offen')
    await srv.close()
  })

  it('400 ohne Pflichtfelder', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten',
      headers: srv.authHeader(),
      payload: { betragCent: 5000 },   // kundeId fehlt
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Kunde nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten',
      headers: srv.authHeader(),
      payload: { kundeId: 'c0c0c0c0-0000-0000-0000-000000009999', betragCent: 5000 },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/offene-posten/:id/zahlung
// ---------------------------------------------------------------------------

describe('POST /api/offene-posten/:id/zahlung', () => {
  it('erfasst Teilzahlung', async () => {
    const current = opDbRow()
    const updated = opDbRow({ bezahltCent: 4000, status: 'teilbezahlt' })
    const srv = await buildTestServer(mockDb({
      // selectQueue[0]: erfasseZahlung → current (from/where/limit)
      // selectQueue[1]: holeOffenerPosten nach Update → updated (leftJoin)
      selectQueue:     [[current], [updated]],
      updateReturning: [updated],
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten/d0d0d0d0-0000-0000-0000-000000000001/zahlung',
      headers: srv.authHeader(),
      payload: { zahlungCent: 4000 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('teilbezahlt')
    await srv.close()
  })

  it('400 wenn Zahlung den Restbetrag übersteigt', async () => {
    const current = opDbRow({ betragCent: 1000, bezahltCent: 0 })
    const srv = await buildTestServer(mockDb({ selectQueue: [[current]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten/d0d0d0d0-0000-0000-0000-000000000001/zahlung',
      headers: srv.authHeader(),
      payload: { zahlungCent: 9999 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn Posten bereits bezahlt', async () => {
    const current = opDbRow({ status: 'bezahlt', betragCent: 5000, bezahltCent: 5000 })
    const srv = await buildTestServer(mockDb({ selectQueue: [[current]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten/d0d0d0d0-0000-0000-0000-000000000001/zahlung',
      headers: srv.authHeader(),
      payload: { zahlungCent: 100 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})
