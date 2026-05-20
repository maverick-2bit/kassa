/**
 * Tests für die Artikel-CRUD-Routen.
 * DB wird komplett gemockt — Drizzle-Chains werden als Stubs nachgebaut.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildServer } from '../src/server.js'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

interface MockDbState {
  insertReturning?: unknown[]
  selectReturning?: unknown[]
  updateReturning?: unknown[]
  insertSpy?: ReturnType<typeof vi.fn>
  updateSpy?: ReturnType<typeof vi.fn>
}

function mockDb(state: MockDbState = {}): Db {
  const insertSpy = state.insertSpy ?? vi.fn()
  const updateSpy = state.updateSpy ?? vi.fn()

  return {
    insert: (...args: unknown[]) => {
      insertSpy(...args)
      return {
        values: () => ({
          returning: () => Promise.resolve(state.insertReturning ?? []),
        }),
      }
    },
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(state.selectReturning ?? []),
        }),
      }),
    }),
    update: (...args: unknown[]) => {
      updateSpy(...args)
      return {
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve(state.updateReturning ?? []),
          }),
        }),
      }
    },
  } as unknown as Db
}

async function buildTestServer(db: Db) {
  return buildServer({
    config: {
      DATABASE_URL:      'postgresql://test',
      MASTER_PASSPHRASE: 'test-passphrase-long-enough',
      PORT:              3000,
      LOG_LEVEL:         'fatal',
      CORS_ORIGIN:       '*',
      NODE_ENV:          'test',
    },
    db,
    setupDeps: { db, masterPassphrase: 'test-passphrase-long-enough' },
    belegDeps: { db, masterPassphrase: 'test-passphrase-long-enough' },
  })
}

// ---------------------------------------------------------------------------
// Test-Fixtures
// ---------------------------------------------------------------------------

const MANDANT_ID = '00000000-0000-0000-0000-000000000001'

const artikelRow = (overrides: Record<string, unknown> = {}) => ({
  id:              '11111111-1111-1111-1111-111111111111',
  mandantId:       MANDANT_ID,
  bezeichnung:     'Espresso',
  preisBruttoCent: 350,
  mwstSatz:        'ermaessigt1',
  artikelnummer:   null,
  aktiv:           true,
  createdAt:       new Date('2026-05-20T10:00:00Z'),
  updatedAt:       new Date('2026-05-20T10:00:00Z'),
  ...overrides,
})

// ---------------------------------------------------------------------------
// POST /api/artikel
// ---------------------------------------------------------------------------

describe('POST /api/artikel', () => {
  it('legt einen Artikel an (HTTP 201)', async () => {
    const server = await buildTestServer(mockDb({ insertReturning: [artikelRow()] }))
    const res = await server.inject({
      method:  'POST',
      url:     '/api/artikel',
      payload: {
        mandantId:       MANDANT_ID,
        bezeichnung:     'Espresso',
        preisBruttoCent: 350,
        mwstSatz:        'ermaessigt1',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.bezeichnung).toBe('Espresso')
    expect(body.preisBruttoCent).toBe(350)
    await server.close()
  })

  it('lehnt ungültigen mwstSatz ab', async () => {
    const server = await buildTestServer(mockDb())
    const res = await server.inject({
      method:  'POST',
      url:     '/api/artikel',
      payload: {
        mandantId:       MANDANT_ID,
        bezeichnung:     'Test',
        preisBruttoCent: 100,
        mwstSatz:        'ungueltig',
      },
    })
    expect(res.statusCode).toBe(400)
    await server.close()
  })

  it('lehnt negativen Preis ab', async () => {
    const server = await buildTestServer(mockDb())
    const res = await server.inject({
      method:  'POST',
      url:     '/api/artikel',
      payload: {
        mandantId:       MANDANT_ID,
        bezeichnung:     'Test',
        preisBruttoCent: -100,
        mwstSatz:        'normal',
      },
    })
    expect(res.statusCode).toBe(400)
    await server.close()
  })

  it('lehnt fehlende mandantId ab', async () => {
    const server = await buildTestServer(mockDb())
    const res = await server.inject({
      method:  'POST',
      url:     '/api/artikel',
      payload: { bezeichnung: 'Test', preisBruttoCent: 100, mwstSatz: 'normal' },
    })
    expect(res.statusCode).toBe(400)
    await server.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/artikel
// ---------------------------------------------------------------------------

describe('GET /api/artikel', () => {
  it('listet Artikel zu mandantId auf', async () => {
    const rows = [
      artikelRow({ id: 'a1', bezeichnung: 'Apfelstrudel' }),
      artikelRow({ id: 'a2', bezeichnung: 'Espresso' }),
    ]
    const server = await buildTestServer(mockDb({ selectReturning: rows }))
    const res = await server.inject({
      method: 'GET',
      url:    `/api/artikel?mandantId=${MANDANT_ID}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await server.close()
  })

  it('verlangt mandantId in der Query', async () => {
    const server = await buildTestServer(mockDb())
    const res = await server.inject({ method: 'GET', url: '/api/artikel' })
    expect(res.statusCode).toBe(400)
    await server.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/artikel/:id
// ---------------------------------------------------------------------------

describe('PUT /api/artikel/:id', () => {
  it('aktualisiert einen Artikel', async () => {
    const updated = artikelRow({ bezeichnung: 'Doppelter Espresso' })
    const server = await buildTestServer(mockDb({ updateReturning: [updated] }))
    const res = await server.inject({
      method:  'PUT',
      url:     `/api/artikel/${updated.id}`,
      payload: { bezeichnung: 'Doppelter Espresso' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().bezeichnung).toBe('Doppelter Espresso')
    await server.close()
  })

  it('404 wenn nicht gefunden', async () => {
    const server = await buildTestServer(mockDb({ updateReturning: [] }))
    const res = await server.inject({
      method:  'PUT',
      url:     '/api/artikel/22222222-2222-2222-2222-222222222222',
      payload: { bezeichnung: 'Neu' },
    })
    expect(res.statusCode).toBe(404)
    await server.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/artikel/:id (soft delete)
// ---------------------------------------------------------------------------

describe('DELETE /api/artikel/:id', () => {
  it('setzt aktiv=false', async () => {
    const deaktiviert = artikelRow({ aktiv: false })
    const updateSpy = vi.fn()
    const server = await buildTestServer(mockDb({ updateReturning: [deaktiviert], updateSpy }))
    const res = await server.inject({
      method: 'DELETE',
      url:    `/api/artikel/${deaktiviert.id}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().aktiv).toBe(false)
    expect(updateSpy).toHaveBeenCalled()
    await server.close()
  })
})
