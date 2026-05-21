/**
 * Tests für die Artikel-CRUD-Routen.
 * Alle Routen sind auth-protected — der Test-Server liefert über authHeader()
 * einen gültigen JWT mit TEST_MANDANT_ID als mandantId.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
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
          // Ownership-Check (.limit(1)) und Liste (.orderBy()) liefern dasselbe
          limit:   () => Promise.resolve(state.selectReturning ?? []),
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

// ---------------------------------------------------------------------------
// Test-Fixtures
// ---------------------------------------------------------------------------

const artikelRow = (overrides: Record<string, unknown> = {}) => ({
  id:              '11111111-1111-1111-1111-111111111111',
  mandantId:       TEST_MANDANT_ID,
  bezeichnung:     'Espresso',
  preisBruttoCent: 350,
  mwstSatz:        'ermaessigt1',
  artikelnummer:   null,
  station:         null,
  aktiv:           true,
  createdAt:       new Date('2026-05-20T10:00:00Z'),
  updatedAt:       new Date('2026-05-20T10:00:00Z'),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth-Check: ohne Token → 401
// ---------------------------------------------------------------------------

describe('Auth-Schutz', () => {
  it('GET /api/artikel ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/artikel' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/artikel ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel',
      payload: { bezeichnung: 'x', preisBruttoCent: 100, mwstSatz: 'normal' },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/artikel
// ---------------------------------------------------------------------------

describe('POST /api/artikel', () => {
  it('legt einen Artikel an (HTTP 201)', async () => {
    const srv = await buildTestServer(mockDb({ insertReturning: [artikelRow()] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel',
      headers: srv.authHeader(),
      payload: { bezeichnung: 'Espresso', preisBruttoCent: 350, mwstSatz: 'ermaessigt1' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.bezeichnung).toBe('Espresso')
    expect(body.mandantId).toBe(TEST_MANDANT_ID) // aus JWT übernommen
    await srv.close()
  })

  it('ignoriert mandantId aus Body — nimmt JWT', async () => {
    const srv = await buildTestServer(mockDb({ insertReturning: [artikelRow()] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel',
      headers: srv.authHeader(),
      payload: {
        // Versuch, einen anderen Mandanten unterzuschieben
        mandantId:       '99999999-9999-9999-9999-999999999999',
        bezeichnung:     'Espresso',
        preisBruttoCent: 350,
        mwstSatz:        'ermaessigt1',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().mandantId).toBe(TEST_MANDANT_ID)
    await srv.close()
  })

  it('lehnt ungültigen mwstSatz ab', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel',
      headers: srv.authHeader(),
      payload: { bezeichnung: 'Test', preisBruttoCent: 100, mwstSatz: 'ungueltig' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('lehnt negativen Preis ab', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel',
      headers: srv.authHeader(),
      payload: { bezeichnung: 'Test', preisBruttoCent: -100, mwstSatz: 'normal' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/artikel
// ---------------------------------------------------------------------------

describe('GET /api/artikel', () => {
  it('listet Artikel zum mandantId aus JWT auf', async () => {
    const rows = [
      artikelRow({ id: 'a1', bezeichnung: 'Apfelstrudel' }),
      artikelRow({ id: 'a2', bezeichnung: 'Espresso' }),
    ]
    const srv = await buildTestServer(mockDb({ selectReturning: rows }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/artikel',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/artikel/:id
// ---------------------------------------------------------------------------

describe('PUT /api/artikel/:id', () => {
  it('aktualisiert einen Artikel', async () => {
    const original = artikelRow()
    const updated  = artikelRow({ bezeichnung: 'Doppelter Espresso' })
    const srv = await buildTestServer(mockDb({
      selectReturning: [original],  // Ownership-Check
      updateReturning: [updated],
    }))
    const res = await srv.fastify.inject({
      method: 'PUT', url: `/api/artikel/${original.id}`,
      headers: srv.authHeader(),
      payload: { bezeichnung: 'Doppelter Espresso' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().bezeichnung).toBe('Doppelter Espresso')
    await srv.close()
  })

  it('404 wenn Artikel nicht zum Mandanten gehört', async () => {
    const srv = await buildTestServer(mockDb({ selectReturning: [] }))
    const res = await srv.fastify.inject({
      method: 'PUT', url: '/api/artikel/22222222-2222-2222-2222-222222222222',
      headers: srv.authHeader(),
      payload: { bezeichnung: 'Neu' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/artikel/:id (soft delete)
// ---------------------------------------------------------------------------

describe('DELETE /api/artikel/:id', () => {
  it('setzt aktiv=false', async () => {
    const original    = artikelRow()
    const deaktiviert = artikelRow({ aktiv: false })
    const updateSpy   = vi.fn()
    const srv = await buildTestServer(mockDb({
      selectReturning: [original],
      updateReturning: [deaktiviert],
      updateSpy,
    }))
    const res = await srv.fastify.inject({
      method: 'DELETE', url: `/api/artikel/${original.id}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().aktiv).toBe(false)
    expect(updateSpy).toHaveBeenCalled()
    await srv.close()
  })
})
