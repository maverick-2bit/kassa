/**
 * Tests für GET /kassen/:id/status (Zertifikats-Ablauf).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID = 'fa000000-0000-0000-0000-000000000001'

function makeResult(data: unknown[]) {
  return {
    then:    (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
               Promise.resolve(data).then(resolve, reject),
    limit:   () => Promise.resolve(data),
    orderBy: () => ({ limit: () => Promise.resolve(data) }),
  }
}

function mockDb(selectRows: unknown[] = []): Db {
  return {
    select: () => ({ from: () => ({ where: () => makeResult(selectRows) }) }),
  } as unknown as Db
}

const kasseRow = (seeGueltigBis: Date) => ({
  id:              KASSE_ID,
  kassenId:        'KASSE-001',
  bezeichnung:     'Hauptkasse',
  status:          'aktiv',
  seeGueltigBis,
  bei_fo_registriert: true,
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz', () => {
  it('ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${KASSE_ID}/status` })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kassen/:id/status
// ---------------------------------------------------------------------------

describe('GET /api/kassen/:id/status', () => {
  it('404 wenn Kasse nicht im Mandanten', async () => {
    const srv = await buildTestServer(mockDb([]))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/status`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('gibt seeAbgelaufen=false zurück wenn Cert noch gültig', async () => {
    const inEinemJahr = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    const srv = await buildTestServer(mockDb([kasseRow(inEinemJahr)]))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/status`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.seeAbgelaufen).toBe(false)
    expect(body.seeRestTage).toBeGreaterThan(300)
    await srv.close()
  })

  it('gibt seeAbgelaufen=true zurück wenn Cert abgelaufen', async () => {
    const gestern = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const srv     = await buildTestServer(mockDb([kasseRow(gestern)]))
    const res     = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/status`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.seeAbgelaufen).toBe(true)
    expect(body.seeRestTage).toBe(0)
    await srv.close()
  })

  it('seeRestTage ist korrekt für Cert mit 45 Tagen Restlaufzeit', async () => {
    const in45Tagen = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    const srv       = await buildTestServer(mockDb([kasseRow(in45Tagen)]))
    const res       = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/status`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Toleranz: ±1 Tag (Laufzeit des Tests)
    expect(body.seeRestTage).toBeGreaterThanOrEqual(44)
    expect(body.seeRestTage).toBeLessThanOrEqual(45)
    await srv.close()
  })
})
