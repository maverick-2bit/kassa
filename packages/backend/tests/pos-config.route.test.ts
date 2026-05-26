/**
 * Tests für /api/kassen/:kasseId/pos-config
 *         und /api/artikel/reihenfolge
 *         und /api/kategorien/reihenfolge
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID = 'fa000000-0000-0000-0000-000000000001'
const KAT_ID   = 'ca000000-0000-0000-0000-000000000001'
const ART_ID   = 'aa000000-0000-0000-0000-000000000001'

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

/**
 * makeInsertResult: kann als direktes await UND als .returning() verwendet werden.
 */
function makeInsertResult(data: unknown[]) {
  const r: any = {}
  r.then      = (ok: any, err: any) => Promise.resolve(data).then(ok, err)
  r.returning = () => Promise.resolve(data)
  return r
}

/** Einfaches tx-Mock für Transaktions-Routen (update/delete/insert ohne Rückgabe). */
function makeTx(): Db {
  return {
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    delete: () => ({ where: () => Promise.resolve([]) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as unknown as Db
}

interface DbQueues {
  selects?: unknown[][]
}

function mockDb({ selects = [] }: DbQueues = {}): Db {
  let si = 0
  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(selects[si++] ?? []),
      }),
    }),
    insert: () => ({
      values: () => makeInsertResult([]),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          then: (ok: any, err: any) => Promise.resolve([]).then(ok, err),
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve([]),
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(makeTx()),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz POS-Config', () => {
  it('GET ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    `/api/kassen/${KASSE_ID}/pos-config`,
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kassen/:kasseId/pos-config
// ---------------------------------------------------------------------------

describe('GET /api/kassen/:kasseId/pos-config', () => {
  it('200 gibt POS-Konfiguration zurück', async () => {
    const kasseRow    = { erlaubteZahlungsarten: ['bar', 'karte'], artikelbilderAktiv: true }
    const sichtbarRow = [{ kategorieId: KAT_ID }]
    // 1. select kasse, 2. select kassekategorieSichtbarkeit
    const srv = await buildTestServer(mockDb({ selects: [[kasseRow], sichtbarRow] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/kassen/${KASSE_ID}/pos-config`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sichtbareKategorieIds).toContain(KAT_ID)
    expect(body.erlaubteZahlungsarten).toContain('bar')
    expect(body.artikelbilderAktiv).toBe(true)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/kassen/${KASSE_ID}/pos-config`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger Kassen-ID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kassen/keine-uuid/pos-config',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/kassen/:kasseId/pos-config
// ---------------------------------------------------------------------------

describe('PUT /api/kassen/:kasseId/pos-config', () => {
  it('204 setzt sichtbareKategorieIds', async () => {
    // select kasse (ownership), dann transaction
    const srv = await buildTestServer(mockDb({ selects: [[{ id: KASSE_ID }]] }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/kassen/${KASSE_ID}/pos-config`,
      headers: srv.authHeader(),
      payload: { sichtbareKategorieIds: [KAT_ID] },
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })

  it('204 setzt erlaubteZahlungsarten', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[{ id: KASSE_ID }]] }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/kassen/${KASSE_ID}/pos-config`,
      headers: srv.authHeader(),
      payload: { erlaubteZahlungsarten: ['bar'] },
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/kassen/${KASSE_ID}/pos-config`,
      headers: srv.authHeader(),
      payload: { erlaubteZahlungsarten: ['bar'] },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger Zahlungsart', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/kassen/${KASSE_ID}/pos-config`,
      headers: srv.authHeader(),
      payload: { erlaubteZahlungsarten: ['kryptowährung'] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/artikel/reihenfolge
// ---------------------------------------------------------------------------

describe('PATCH /api/artikel/reihenfolge', () => {
  it('204 bei gültiger Eingabe', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/artikel/reihenfolge',
      headers: srv.authHeader(),
      payload: { eintraege: [{ id: ART_ID, reihenfolge: 0 }] },
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })

  it('400 wenn eintraege fehlen', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/artikel/reihenfolge',
      headers: srv.authHeader(),
      payload: { eintraege: [] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/artikel/favoriten-reihenfolge
// ---------------------------------------------------------------------------

describe('PATCH /api/artikel/favoriten-reihenfolge', () => {
  it('204 bei gültiger Eingabe', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/artikel/favoriten-reihenfolge',
      headers: srv.authHeader(),
      payload: { eintraege: [{ id: ART_ID, favoritenReihenfolge: 0 }] },
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/kategorien/reihenfolge
// ---------------------------------------------------------------------------

describe('PATCH /api/kategorien/reihenfolge', () => {
  it('204 bei gültiger Eingabe', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/kategorien/reihenfolge',
      headers: srv.authHeader(),
      payload: { eintraege: [{ id: KAT_ID, reihenfolge: 1 }] },
    })
    expect(res.statusCode).toBe(204)
    await srv.close()
  })

  it('400 wenn eintraege fehlen', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/kategorien/reihenfolge',
      headers: srv.authHeader(),
      payload: { eintraege: [] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})
