/**
 * Tests für /api/tisch-tabs (Gastro-Tisch-Tabs).
 *
 * Wir testen hauptsächlich Auth, Validierung, 404-Pfade und einfache
 * Happy-Paths.  Die Bezahlen/Splitten-Operationen erfordern den vollständigen
 * Beleg-Service und werden daher nur im 404-Pfad (vor dem Beleg-Service) geprüft.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID = 'fa000000-0000-0000-0000-000000000001'
const TAB_ID   = 'ta000000-0000-0000-0000-000000000001'

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
 * makeInsertResult: direkt await-bar UND über .returning() abfragbar.
 */
function makeInsertResult(data: unknown[]) {
  const r: any = {}
  r.then      = (ok: any, err: any) => Promise.resolve(data).then(ok, err)
  r.returning = () => Promise.resolve(data)
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
      values: () => makeInsertResult(inserts[ii++] ?? []),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          then:      (ok: any, err: any) => Promise.resolve([]).then(ok, err),
          returning: () => Promise.resolve(updates[ui++] ?? []),
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve([]),
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn({
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      delete: () => ({ where: () => Promise.resolve([]) }),
      insert: () => ({ values: () => Promise.resolve([]) }),
    } as unknown as Db),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Fixture-Helfer
// ---------------------------------------------------------------------------

const tabRow = (overrides: Record<string, unknown> = {}) => ({
  id:           TAB_ID,
  mandantId:    TEST_MANDANT_ID,
  kasseId:      KASSE_ID,
  tischNummer:  '1',
  kellner:      'Anna',
  positionen:   [],
  status:       'offen',
  geoffnetAm:   new Date(),
  geschlossenAm: null,
  belegId:      null,
  createdAt:    new Date(),
  updatedAt:    new Date(),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz Tisch-Tabs', () => {
  it('GET ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    `/api/tisch-tabs?kasseId=${KASSE_ID}`,
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/tisch-tabs
// ---------------------------------------------------------------------------

describe('GET /api/tisch-tabs', () => {
  it('400 wenn kasseId fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/tisch-tabs',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 gibt offene Tabs zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[tabRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/tisch-tabs?kasseId=${KASSE_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].tischNummer).toBe('1')
    await srv.close()
  })

  it('200 gibt leere Liste zurück wenn keine offenen Tabs', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/tisch-tabs?kasseId=${KASSE_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/tisch-tabs
// ---------------------------------------------------------------------------

describe('POST /api/tisch-tabs', () => {
  it('201 erstellt Tab', async () => {
    // 1. select kasse, 2. insert tab (returning), 3. insert ereignis (direkt)
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }]],
      inserts: [[tabRow()], []],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/tisch-tabs',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, tischNummer: '1', kellner: 'Anna' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.tischNummer).toBe('1')
    expect(body.status).toBe('offen')
    await srv.close()
  })

  it('400 wenn Pflichtfelder fehlen', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/tisch-tabs',
      headers: srv.authHeader(),
      payload: { tischNummer: '1' },   // kasseId und kellner fehlen
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/tisch-tabs',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, tischNummer: '1', kellner: 'Anna' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/tisch-tabs/:id
// ---------------------------------------------------------------------------

describe('GET /api/tisch-tabs/:id', () => {
  it('200 gibt Tab zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[tabRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/tisch-tabs/${TAB_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(TAB_ID)
    await srv.close()
  })

  it('404 wenn nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/tisch-tabs/${TAB_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/tisch-tabs/:id/positionen
// ---------------------------------------------------------------------------

describe('PUT /api/tisch-tabs/:id/positionen', () => {
  it('200 aktualisiert leere Positionen', async () => {
    // 1. select existing (status=offen, positionen=[])
    // 2. update returning new row
    // 3. insert ereignis 'positionen_aktualisiert'
    const srv = await buildTestServer(mockDb({
      selects: [[tabRow({ positionen: [] })]],
      updates: [[tabRow()]],
      inserts: [[]], // ereignis-log
    }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/tisch-tabs/${TAB_ID}/positionen`,
      headers: srv.authHeader(),
      payload: { positionen: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().positionen).toEqual([])
    await srv.close()
  })

  it('404 wenn Tab nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/tisch-tabs/${TAB_ID}/positionen`,
      headers: srv.authHeader(),
      payload: { positionen: [] },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('409 wenn Tab bereits bezahlt', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[tabRow({ status: 'bezahlt' })]],
    }))
    const res = await srv.fastify.inject({
      method:  'PUT',
      url:     `/api/tisch-tabs/${TAB_ID}/positionen`,
      headers: srv.authHeader(),
      payload: { positionen: [] },
    })
    expect(res.statusCode).toBe(409)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/tisch-tabs/:id/kellner
// ---------------------------------------------------------------------------

describe('PATCH /api/tisch-tabs/:id/kellner', () => {
  it('200 benennt Kellner um', async () => {
    // 1. select existing, 2. update returning, 3. insert ereignis
    const srv = await buildTestServer(mockDb({
      selects: [[tabRow({ kellner: 'Anna' })]],
      updates: [[tabRow({ kellner: 'Ben' })]],
      inserts: [[]],
    }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/tisch-tabs/${TAB_ID}/kellner`,
      headers: srv.authHeader(),
      payload: { kellner: 'Ben' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().kellner).toBe('Ben')
    await srv.close()
  })

  it('404 wenn Tab nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/tisch-tabs/${TAB_ID}/kellner`,
      headers: srv.authHeader(),
      payload: { kellner: 'Ben' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 wenn kellner fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/tisch-tabs/${TAB_ID}/kellner`,
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/tisch-tabs/:id/tisch
// ---------------------------------------------------------------------------

describe('PATCH /api/tisch-tabs/:id/tisch', () => {
  it('200 ändert Tischnummer', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[tabRow({ tischNummer: '1' })]],
      updates: [[tabRow({ tischNummer: '5' })]],
      inserts: [[]],
    }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/tisch-tabs/${TAB_ID}/tisch`,
      headers: srv.authHeader(),
      payload: { tischNummer: '5' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().tischNummer).toBe('5')
    await srv.close()
  })

  it('404 wenn Tab nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     `/api/tisch-tabs/${TAB_ID}/tisch`,
      headers: srv.authHeader(),
      payload: { tischNummer: '5' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/tisch-tabs/:id/verlauf
// ---------------------------------------------------------------------------

describe('GET /api/tisch-tabs/:id/verlauf', () => {
  it('200 gibt leeren Verlauf zurück', async () => {
    // 1. select tab (ownership-check), 2. select ereignisse
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: TAB_ID }], []],
    }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/tisch-tabs/${TAB_ID}/verlauf`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })

  it('404 wenn Tab nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     `/api/tisch-tabs/${TAB_ID}/verlauf`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/tisch-tabs/:id/bezahlen  (nur Fehler-Pfade ohne Beleg-Service)
// ---------------------------------------------------------------------------

describe('POST /api/tisch-tabs/:id/bezahlen', () => {
  it('400 wenn Zahlungs-Body ungültig', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/tisch-tabs/${TAB_ID}/bezahlen`,
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Tab nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/tisch-tabs/${TAB_ID}/bezahlen`,
      headers: srv.authHeader(),
      payload: {
        zahlung: { barCent: 1000, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 wenn keine Positionen im Tab', async () => {
    // Tab ist offen aber hat keine Positionen
    const srv = await buildTestServer(mockDb({
      selects: [[tabRow({ positionen: [] })]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/tisch-tabs/${TAB_ID}/bezahlen`,
      headers: srv.authHeader(),
      payload: {
        zahlung: { barCent: 1000, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/tisch-tabs/:id/splitten  (nur Fehler-Pfade)
// ---------------------------------------------------------------------------

describe('POST /api/tisch-tabs/:id/splitten', () => {
  it('400 wenn Body ungültig', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/tisch-tabs/${TAB_ID}/splitten`,
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Tab nicht gefunden', async () => {
    // Schema erfordert min. 2 Zahlungen, jede mit min. 1 Position
    const pos = {
      artikelId:       'aaaaaaaa-0000-0000-0000-000000000001',
      bezeichnung:     'Test',
      preisBruttoCent: 500,
      menge:           1,
    }
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/tisch-tabs/${TAB_ID}/splitten`,
      headers: srv.authHeader(),
      payload: {
        zahlungen: [
          { zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 }, positionen: [pos] },
          { zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 }, positionen: [pos] },
        ],
      },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})
