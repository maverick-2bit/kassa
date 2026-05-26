/**
 * Tests für die User-Verwaltungs-Routen (admin-only).
 */

import { describe, it, expect, vi } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID, TEST_USER_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

function makeResult(data: unknown[]) {
  return {
    then:    (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
               Promise.resolve(data).then(resolve, reject),
    limit:   () => Promise.resolve(data),
    orderBy: () => Promise.resolve(data),
  }
}

function mockDb(opts: {
  selectQueue?:     unknown[][]
  insertReturning?: unknown[]
  updateReturning?: unknown[]
  deleteSpy?:       ReturnType<typeof vi.fn>
} = {}): Db {
  let selIdx = 0
  const sel  = opts.selectQueue ?? []

  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(sel[selIdx++] ?? []),
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
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Test-Fixtures
// ---------------------------------------------------------------------------

const userRow = (overrides: Record<string, unknown> = {}) => ({
  id:             'u-0001',
  mandantId:      TEST_MANDANT_ID,
  email:          'test@example.at',
  passwordHash:   '$2a$10$fakehash',
  pinHash:        null,
  name:           'Test Admin',
  rolle:          'admin',
  berechtigungen: [],
  aktiv:          true,
  createdAt:      new Date('2026-01-01T10:00:00Z'),
  updatedAt:      new Date('2026-01-01T10:00:00Z'),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Admin-Only-Guard
// ---------------------------------------------------------------------------

describe('Admin-Only-Guard', () => {
  it('GET /api/users ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/users' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('GET /api/users mit Nicht-Admin-Token → 403', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/users',
      headers: srv.authHeader({ rolle: 'kellner' }),
    })
    expect(res.statusCode).toBe(403)
    await srv.close()
  })

  it('POST /api/users mit Nicht-Admin-Token → 403', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/users',
      headers: srv.authHeader({ rolle: 'kellner' }),
      payload: { name: 'Test', email: 'x@x.at', passwort: 'pw123', rolle: 'kellner', berechtigungen: [], kassenIds: [] },
    })
    expect(res.statusCode).toBe(403)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------

describe('GET /api/users', () => {
  it('listet User des Mandanten', async () => {
    const rows = [userRow({ id: 'u1' }), userRow({ id: 'u2', email: 'u2@x.at' })]
    const srv  = await buildTestServer(mockDb({ selectQueue: [rows] }))
    const res  = await srv.fastify.inject({
      method: 'GET', url: '/api/users',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/users
// ---------------------------------------------------------------------------

describe('POST /api/users', () => {
  it('legt User an (201)', async () => {
    // selectQueue[0]: E-Mail-Duplikat-Check → leer
    const row = userRow()
    const srv = await buildTestServer(mockDb({
      selectQueue:     [[]],
      insertReturning: [row],
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/users',
      headers: srv.authHeader(),
      payload: {
        name:           'Test Admin',
        email:          'test@example.at',
        passwort:       'sicher123!',
        rolle:          'admin',
        berechtigungen: [],
        kassenIds:      [],
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().email).toBe('test@example.at')
    await srv.close()
  })

  it('409 bei doppelter E-Mail', async () => {
    // selectQueue[0]: E-Mail-Duplikat-Check → bereits vorhanden
    const srv = await buildTestServer(mockDb({
      selectQueue: [[{ id: 'u-exists' }]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/users',
      headers: srv.authHeader(),
      payload: {
        name:           'Doppelt',
        email:          'test@example.at',
        passwort:       'sicher123!',
        rolle:          'admin',
        berechtigungen: [],
        kassenIds:      [],
      },
    })
    expect(res.statusCode).toBe(409)
    await srv.close()
  })

  it('400 bei fehlendem Pflichtfeld', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/users',
      headers: srv.authHeader(),
      payload: { name: 'Nur Name' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/users/:id
// ---------------------------------------------------------------------------

describe('PUT /api/users/:id', () => {
  it('aktualisiert User', async () => {
    const existing = userRow()
    const updated  = userRow({ name: 'Geänderter Name' })
    const srv = await buildTestServer(mockDb({
      selectQueue:     [[existing]],
      updateReturning: [updated],
    }))
    const res = await srv.fastify.inject({
      method:  'PUT', url: '/api/users/u-0001',
      headers: srv.authHeader(),
      payload: { name: 'Geänderter Name' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Geänderter Name')
    await srv.close()
  })

  it('404 wenn User nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PUT', url: '/api/users/u-9999',
      headers: srv.authHeader(),
      payload: { name: 'Test' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/users/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/users/:id', () => {
  it('deaktiviert User', async () => {
    const existing = userRow()
    const inaktiv  = userRow({ aktiv: false })
    const srv = await buildTestServer(mockDb({
      selectQueue:     [[existing]],
      updateReturning: [inaktiv],
    }))
    const res = await srv.fastify.inject({
      method:  'DELETE', url: '/api/users/u-0001',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().aktiv).toBe(false)
    await srv.close()
  })

  it('400 beim Versuch, sich selbst zu löschen', async () => {
    const srv = await buildTestServer(mockDb())
    // Der Test-JWT hat TEST_USER_ID als sub — gleiche ID verwenden
    const res = await srv.fastify.inject({
      method:  'DELETE', url: `/api/users/${TEST_USER_ID}`,
      headers: srv.authHeader({ sub: TEST_USER_ID }),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn User nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method:  'DELETE', url: '/api/users/u-9999',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})
