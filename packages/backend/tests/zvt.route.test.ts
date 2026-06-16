/**
 * Tests für ZVT-Kartenterminal-Routen.
 *
 * ZVT läuft job-basiert:
 *   POST /api/zvt/zahlung         → startet Job, gibt sofort jobId zurück
 *   GET  /api/zvt/zahlung/:jobId  → Frontend pollt Status
 *   POST /api/zvt/zahlung/:jobId/abbrechen
 *
 * TCP-Verbindung zum Terminal läuft im Hintergrund — der Endpunkt blockiert nicht.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID    = 'a2000000-0000-0000-0000-000000000001'
const FAKE_JOB_ID = 'e2000000-0000-0000-0000-000000000001'

// ---------------------------------------------------------------------------
// Mock-Helfer
// ---------------------------------------------------------------------------

function makeResult(data: unknown[]) {
  const r: any = {}
  r.then    = (ok: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
                Promise.resolve(data).then(ok, rej)
  r.catch   = (fn: (e: unknown) => unknown) => Promise.resolve(data).catch(fn)
  r.limit   = () => r
  r.orderBy = () => r
  return r
}

interface DbQueues {
  selects?: unknown[][]
  updates?: unknown[][]
}

function mockDb({ selects = [], updates = [] }: DbQueues = {}): Db {
  let si = 0, ui = 0
  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(selects[si++] ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(updates[ui++] ?? []),
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        const r: any = {}
        r.then = (ok: any, rej?: any) => Promise.resolve([]).then(ok, rej)
        r.catch = (fn: any) => Promise.resolve([]).catch(fn)
        r.returning = () => Promise.resolve([])
        return r
      },
    }),
  } as unknown as Db
}

const kasseRow = (overrides: Record<string, unknown> = {}) => ({
  id:          KASSE_ID,
  mandantId:   TEST_MANDANT_ID,
  kassenId:    'KASSE-ZVT',
  zvtIp:       '192.168.1.200',
  zvtPort:     20007,
  zvtPasswort: '000000',
  zvtAktiv:    true,
  druckerAktiv: false,
  druckerIp:   null,
  druckerPort: 9100,
  druckerBreite: 42,
  druckerTimeoutSek: 5,
  kdsAktiv:    false,
  kdsPort:     9200,
  kdsStationen: {},
  abschlussEmail: null,
  aktiv:       true,
  createdAt:   new Date(),
  updatedAt:   new Date(),
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz ZVT', () => {
  it('GET /api/kassen/:id/zvt ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${KASSE_ID}/zvt` })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/zvt/zahlung ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/zvt/zahlung',
      payload: { kasseId: KASSE_ID, betragCent: 1500 },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kassen/:id/zvt — Konfiguration lesen
// ---------------------------------------------------------------------------

describe('GET /api/kassen/:id/zvt', () => {
  it('200 liefert ZVT-Konfiguration', async () => {
    const kasse = kasseRow()
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [kasse]],
    }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/zvt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.zvtAktiv).toBe(true)
    expect(body.zvtIp).toBe('192.168.1.200')
    expect(body.zvtPort).toBe(20007)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/zvt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/kassen/keine-uuid/zvt',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/kassen/:id/zvt — Konfiguration ändern
// ---------------------------------------------------------------------------

describe('PATCH /api/kassen/:id/zvt', () => {
  it('200 aktualisiert ZVT-Konfiguration', async () => {
    const updated = kasseRow({ zvtIp: '10.0.0.20', zvtAktiv: false })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }]],
      updates: [[updated]],
    }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${KASSE_ID}/zvt`,
      headers: srv.authHeader(),
      payload: { zvtIp: '10.0.0.20', zvtAktiv: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().zvtIp).toBe('10.0.0.20')
    expect(res.json().zvtAktiv).toBe(false)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${KASSE_ID}/zvt`,
      headers: srv.authHeader(),
      payload: { zvtAktiv: true },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültigem Port', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[{ id: KASSE_ID }]] }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${KASSE_ID}/zvt`,
      headers: srv.authHeader(),
      payload: { zvtPort: 0 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/zvt/zahlung — Zahlung starten
// ---------------------------------------------------------------------------

describe('POST /api/zvt/zahlung', () => {
  it('200 gibt sofort jobId zurück (nicht-blockierend)', async () => {
    // Terminal nicht erreichbar — Verbindung schlägt im Hintergrund fehl,
    // aber der Endpunkt antwortet sofort mit der jobId.
    const kasse = kasseRow({ zvtIp: '127.0.0.1', zvtPort: 19999 })
    const srv = await buildTestServer(mockDb({
      selects: [[kasse]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, betragCent: 2500 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.jobId).toBe('string')
    expect(body.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    await srv.close()
  })

  it('409 wenn ZVT-Terminal deaktiviert', async () => {
    const kasse = kasseRow({ zvtAktiv: false })
    const srv = await buildTestServer(mockDb({ selects: [[kasse]] }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, betragCent: 1000 },
    })
    expect(res.statusCode).toBe(409)
    await srv.close()
  })

  it('409 wenn keine Terminal-IP konfiguriert', async () => {
    const kasse = kasseRow({ zvtAktiv: true, zvtIp: null })
    const srv = await buildTestServer(mockDb({ selects: [[kasse]] }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, betragCent: 1000 },
    })
    expect(res.statusCode).toBe(409)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, betragCent: 1000 },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei fehlendem betragCent', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/zvt/zahlung/:jobId — Job-Status pollen
// ---------------------------------------------------------------------------

describe('GET /api/zvt/zahlung/:jobId', () => {
  it('404 wenn Job nicht existiert', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET', url: `/api/zvt/zahlung/${FAKE_JOB_ID}`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET', url: '/api/zvt/zahlung/keine-uuid',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 mit Job-Status nach POST (create → poll)', async () => {
    const kasse = kasseRow({ zvtIp: '127.0.0.1', zvtPort: 19999 })
    const srv = await buildTestServer(mockDb({ selects: [[kasse]] }))

    // Job anlegen
    const postRes = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, betragCent: 5000 },
    })
    expect(postRes.statusCode).toBe(200)
    const { jobId } = postRes.json()

    // Job pollen (jobs-Map ist module-level — direkt verfügbar)
    const getRes = await srv.fastify.inject({
      method:  'GET', url: `/api/zvt/zahlung/${jobId}`,
      headers: srv.authHeader(),
    })
    expect(getRes.statusCode).toBe(200)
    const job = getRes.json()
    expect(job.id).toBe(jobId)
    expect(job.betragCent).toBe(5000)
    expect(['verbinde', 'autorisiere', 'fehler']).toContain(job.status)

    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/zvt/zahlung/:jobId/abbrechen
// ---------------------------------------------------------------------------

describe('POST /api/zvt/zahlung/:jobId/abbrechen', () => {
  it('404 wenn Job nicht existiert', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: `/api/zvt/zahlung/${FAKE_JOB_ID}/abbrechen`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung/keine-uuid/abbrechen',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 bricht laufenden Job ab', async () => {
    const kasse = kasseRow({ zvtIp: '127.0.0.1', zvtPort: 19999 })
    const srv = await buildTestServer(mockDb({ selects: [[kasse]] }))

    const postRes = await srv.fastify.inject({
      method:  'POST', url: '/api/zvt/zahlung',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, betragCent: 3000 },
    })
    const { jobId } = postRes.json()

    const abbrechenRes = await srv.fastify.inject({
      method:  'POST', url: `/api/zvt/zahlung/${jobId}/abbrechen`,
      headers: srv.authHeader(),
    })
    expect(abbrechenRes.statusCode).toBe(200)
    const body = abbrechenRes.json()
    expect(body.id).toBe(jobId)
    expect(['abgebrochen', 'fehler']).toContain(body.status)

    await srv.close()
  })
})
