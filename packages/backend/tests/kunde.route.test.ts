/**
 * Tests für die Kunden-CRUD-Routen.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Erstellt ein Ergebnis-Objekt, das sowohl awaitable (thenable) als auch chainbar ist. */
function makeResult(data: unknown[]) {
  return {
    then:      (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                 Promise.resolve(data).then(resolve, reject),
    limit:     () => Promise.resolve(data),
    orderBy:   () => ({ limit: () => Promise.resolve(data) }),
    innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(data) }) }) }),
  }
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
        where:     () => makeResult(queue[idx++] ?? []),
        innerJoin: () => ({ where: () => makeResult(queue[idx++] ?? []) }),
      }),
    }),
    insert: () => ({
      values: () => ({
        then:      (resolve: (v: unknown) => unknown) => Promise.resolve(opts.insertReturning ?? []).then(resolve),
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

const kundeRow = (overrides: Record<string, unknown> = {}) => ({
  id:          'k-0001',
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
  createdAt:   new Date('2026-01-01T10:00:00Z'),
  updatedAt:   new Date('2026-01-01T10:00:00Z'),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz', () => {
  it('GET /api/kunden ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/kunden' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/kunden ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kunden',
      payload: { nachname: 'Test' },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kunden
// ---------------------------------------------------------------------------

describe('GET /api/kunden', () => {
  it('listet Kunden des Mandanten', async () => {
    const rows = [kundeRow({ id: 'k1' }), kundeRow({ id: 'k2', vorname: 'Anna' })]
    const srv  = await buildTestServer(mockDb({ selectQueue: [rows] }))
    const res  = await srv.fastify.inject({
      method: 'GET', url: '/api/kunden',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kunden/:id
// ---------------------------------------------------------------------------

describe('GET /api/kunden/:id', () => {
  it('gibt vorhandenen Kunden zurück', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[kundeRow()]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/kunden/k-0001',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().nachname).toBe('Mustermann')
    await srv.close()
  })

  it('404 wenn Kunde nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/kunden/k-9999',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kunden
// ---------------------------------------------------------------------------

describe('POST /api/kunden', () => {
  it('legt Kunden an (201)', async () => {
    // selectQueue[0]: Nummern-Aggregate → [{naechsteNummer: 1}]
    const srv = await buildTestServer(mockDb({
      selectQueue:     [[{ naechsteNummer: 1 }]],
      insertReturning: [kundeRow()],
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kunden',
      headers: srv.authHeader(),
      payload: { nachname: 'Mustermann', vorname: 'Max' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().nachname).toBe('Mustermann')
    await srv.close()
  })

  it('lehnt Payload ohne Firma und Nachname ab (400)', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kunden',
      headers: srv.authHeader(),
      payload: { vorname: 'Nur-Vorname' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('akzeptiert Firma ohne Nachname', async () => {
    const row = kundeRow({ firma: 'Muster GmbH', vorname: null, nachname: null })
    const srv  = await buildTestServer(mockDb({
      selectQueue:     [[{ naechsteNummer: 1 }]],
      insertReturning: [row],
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kunden',
      headers: srv.authHeader(),
      payload: { firma: 'Muster GmbH' },
    })
    expect(res.statusCode).toBe(201)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/kunden/:id
// ---------------------------------------------------------------------------

describe('PUT /api/kunden/:id', () => {
  it('aktualisiert Kunden', async () => {
    const original = kundeRow()
    const updated  = kundeRow({ vorname: 'Moritz' })
    const srv = await buildTestServer(mockDb({
      selectQueue:     [[original]],
      updateReturning: [updated],
    }))
    const res = await srv.fastify.inject({
      method: 'PUT', url: '/api/kunden/k-0001',
      headers: srv.authHeader(),
      payload: { vorname: 'Moritz' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().vorname).toBe('Moritz')
    await srv.close()
  })

  it('404 wenn Kunde nicht vorhanden', async () => {
    const srv = await buildTestServer(mockDb({ selectQueue: [[]] }))
    const res = await srv.fastify.inject({
      method: 'PUT', url: '/api/kunden/k-9999',
      headers: srv.authHeader(),
      payload: { vorname: 'Test' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/kunden/:id (Soft-Delete → aktiv = false)
// ---------------------------------------------------------------------------

describe('DELETE /api/kunden/:id', () => {
  it('deaktiviert Kunden', async () => {
    const aktiv      = kundeRow()
    const inaktiv    = kundeRow({ aktiv: false })
    const srv = await buildTestServer(mockDb({
      selectQueue:     [[aktiv]],
      updateReturning: [inaktiv],
    }))
    const res = await srv.fastify.inject({
      method: 'DELETE', url: '/api/kunden/k-0001',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().aktiv).toBe(false)
    await srv.close()
  })
})
