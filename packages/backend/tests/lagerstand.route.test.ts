/**
 * Tests für die Lagerstand-Route (POST /lagerstand/bulk).
 */

import { describe, it, expect, vi } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

function mockDb(opts: {
  updateSpy?: ReturnType<typeof vi.fn>
} = {}): Db {
  const updateSpy = opts.updateSpy ?? vi.fn()

  const makeUpdate = () => ({
    update: (...args: unknown[]) => {
      updateSpy(...args)
      return { set: () => ({ where: () => Promise.resolve() }) }
    },
  })

  return {
    ...makeUpdate(),
    transaction: async (fn: (tx: Db) => Promise<void>) => fn(makeUpdate() as unknown as Db),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz', () => {
  it('POST /api/lagerstand/bulk ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/lagerstand/bulk',
      payload: { modus: 'wareneingang', artikel: [], modifikatoren: [] },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/lagerstand/bulk
// ---------------------------------------------------------------------------

describe('POST /api/lagerstand/bulk', () => {
  it('Wareneingang — gibt 204 zurück', async () => {
    const updateSpy = vi.fn()
    const srv = await buildTestServer(mockDb({ updateSpy }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/lagerstand/bulk',
      headers: srv.authHeader(),
      payload: {
        modus:        'wareneingang',
        artikel:      [
          { id: 'a1a1a1a1-0000-0000-0000-000000000001', menge: 10 },
          { id: 'a1a1a1a1-0000-0000-0000-000000000002', menge: 5 },
        ],
        modifikatoren: [],
      },
    })
    expect(res.statusCode).toBe(204)
    expect(updateSpy).toHaveBeenCalledTimes(2)
    await srv.close()
  })

  it('Absoluter Modus (Inventur) — gibt 204 zurück', async () => {
    const updateSpy = vi.fn()
    const srv = await buildTestServer(mockDb({ updateSpy }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/lagerstand/bulk',
      headers: srv.authHeader(),
      payload: {
        modus:        'absolut',
        artikel:      [{ id: 'a1a1a1a1-0000-0000-0000-000000000001', menge: 100 }],
        modifikatoren: [{ id: 'b2b2b2b2-0000-0000-0000-000000000001', menge: 50 }],
      },
    })
    expect(res.statusCode).toBe(204)
    expect(updateSpy).toHaveBeenCalledTimes(2)   // 1 Artikel + 1 Modifikator
    await srv.close()
  })

  it('leere Listen sind erlaubt (keine DB-Calls)', async () => {
    const updateSpy = vi.fn()
    const srv = await buildTestServer(mockDb({ updateSpy }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/lagerstand/bulk',
      headers: srv.authHeader(),
      payload: { modus: 'wareneingang', artikel: [], modifikatoren: [] },
    })
    expect(res.statusCode).toBe(204)
    expect(updateSpy).not.toHaveBeenCalled()
    await srv.close()
  })

  it('400 bei ungültigem Modus', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/lagerstand/bulk',
      headers: srv.authHeader(),
      payload: { modus: 'ungueltig', artikel: [] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 bei negativer Menge', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/lagerstand/bulk',
      headers: srv.authHeader(),
      payload: {
        modus:   'wareneingang',
        artikel: [{ id: 'a1', menge: -5 }],
      },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})
