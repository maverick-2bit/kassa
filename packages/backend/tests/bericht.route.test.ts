/**
 * Tests für /api/berichte/* (Umsatz, Artikel, Warengruppe, Stunden).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID     = 'fa000000-0000-0000-0000-000000000001'
const UNBEKANNT_ID = 'ff000000-0000-0000-0000-000000000099'

// ---------------------------------------------------------------------------
// Mock-Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Erstellt ein thenable Objekt, das direkt awaited werden kann und dabei
 * `data` liefert; außerdem sind .limit() / .orderBy() chainbar.
 */
function makeResult(data: unknown[]) {
  const r: any = {}
  r.then    = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
                Promise.resolve(data).then(ok, err)
  r.limit   = () => r
  r.orderBy = () => r
  return r
}

function mockDb(selectQueue: unknown[][] = []): Db {
  let si = 0
  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(selectQueue[si++] ?? []),
      }),
    }),
    execute: () => Promise.resolve([]),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz Berichte', () => {
  it('GET /berichte/umsatz ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/berichte/umsatz?von=2026-01-01&bis=2026-01-31',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/berichte/umsatz
// ---------------------------------------------------------------------------

describe('GET /api/berichte/umsatz', () => {
  it('400 wenn von oder bis fehlen', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/umsatz',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn Datumsformat ungültig', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/umsatz?von=01.01.2026&bis=31.01.2026',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn angefragte kasseId nicht zum Mandanten gehört', async () => {
    // Mandant hat keine Kassen → unbekannte ID ist nicht erlaubt
    const srv = await buildTestServer(mockDb([[]])) // kassen-select liefert []
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/berichte/umsatz?von=2026-01-01&bis=2026-01-31&kasseIds=${UNBEKANNT_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 Happy Path — leerer Zeitraum', async () => {
    // Mandant hat eine Kasse; keine Belege in diesem Zeitraum
    const srv = await buildTestServer(mockDb([
      [{ id: KASSE_ID }],   // kassen-select
      [],                    // belege-select → leer
    ]))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/umsatz?von=2026-01-01&bis=2026-01-31',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.von).toBe('2026-01-01')
    expect(body.bis).toBe('2026-01-31')
    expect(Array.isArray(body.zeilen)).toBe(true)
    expect(body.gesamt.umsatzCent).toBe(0)
    await srv.close()
  })

  it('400 wenn von > bis', async () => {
    // Kassen-Select muss trotzdem gemockt werden (passiert vor der von>bis-Prüfung)
    const srv = await buildTestServer(mockDb([[{ id: KASSE_ID }]]))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/umsatz?von=2026-02-01&bis=2026-01-01',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/berichte/artikel
// ---------------------------------------------------------------------------

describe('GET /api/berichte/artikel', () => {
  it('400 wenn von fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/artikel?bis=2026-01-31',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 Happy Path', async () => {
    // execute() wird für Raw-SQL gemockt → liefert []
    const srv = await buildTestServer(mockDb([[{ id: KASSE_ID }]]))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/artikel?von=2026-01-01&bis=2026-01-31',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().zeilen)).toBe(true)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/berichte/warengruppe
// ---------------------------------------------------------------------------

describe('GET /api/berichte/warengruppe', () => {
  it('200 Happy Path', async () => {
    const srv = await buildTestServer(mockDb([[{ id: KASSE_ID }]]))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/warengruppe?von=2026-01-01&bis=2026-01-31',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().zeilen)).toBe(true)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/berichte/stunden
// ---------------------------------------------------------------------------

describe('GET /api/berichte/stunden', () => {
  it('400 wenn von fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/stunden?bis=2026-01-31',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 Happy Path — 24 Stunden-Zeilen', async () => {
    const srv = await buildTestServer(mockDb([[{ id: KASSE_ID }]]))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/berichte/stunden?von=2026-01-01&bis=2026-01-31',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.zeilen).toHaveLength(24)
    await srv.close()
  })
})
