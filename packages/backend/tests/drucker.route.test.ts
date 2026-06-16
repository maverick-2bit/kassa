/**
 * Tests für die Drucker-Routen.
 *
 * Prüft insbesondere:
 *   - Konfiguration lesen/schreiben
 *   - Online-Status (TCP-Ping)
 *   - Offline-Verhalten: Testdruck und Reprint wenn Drucker nicht erreichbar
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID = 'a0000000-0000-0000-0000-000000000001'
const BELEG_ID = 'b0000000-0000-0000-0000-000000000001'

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
  r.for     = () => r
  return r
}

function makeInsertResult(data: unknown[]) {
  const r: any = {}
  r.then      = (ok: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
                  Promise.resolve(data).then(ok, rej)
  r.catch     = (fn: (e: unknown) => unknown) => Promise.resolve(data).catch(fn)
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
          returning: () => Promise.resolve(updates[ui++] ?? []),
        }),
      }),
    }),
  } as unknown as Db
}

const kasseRow = (overrides: Record<string, unknown> = {}) => ({
  id:                KASSE_ID,
  mandantId:         TEST_MANDANT_ID,
  kassenId:          'KASSE-001',
  druckerIp:         null,
  druckerPort:       9100,
  druckerAktiv:      false,
  druckerBreite:     42,
  druckerTimeoutSek: 5,
  kdsAktiv:          false,
  kdsPort:           9200,
  kdsStationen:      {},
  zvtAktiv:          false,
  zvtIp:             null,
  zvtPort:           20007,
  zvtPasswort:       null,
  abschlussEmail:    null,
  aktiv:             true,
  createdAt:         new Date(),
  updatedAt:         new Date(),
  ...overrides,
})

const belegRow = () => ({
  id:                             BELEG_ID,
  kasseId:                        KASSE_ID,
  mandantId:                      TEST_MANDANT_ID,
  belegNummer:                    42,
  belegDatum:                     new Date(),
  belegTyp:                       'Startbeleg',
  betragNormalCent:               0,
  betragErmaessigt1Cent:          0,
  betragErmaessigt2Cent:          0,
  betragNullCent:                 0,
  betragBesondersCent:            0,
  summeBarCent:                   0,
  summeKarteCent:                 0,
  summeSonstigeCent:              0,
  positionen:                     [],
  zertifikatSn:                   'SN-TEST',
  sigVorbeleg:                    'prev-sig',
  signaturwert:                   'sig',
  umsatzzaehlerVerschluesselt:    'enc',
  maschinenlesbareCode:           'code',
  createdAt:                      new Date(),
})

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz Drucker', () => {
  it('GET /api/kassen/:id/drucker ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/drucker`,
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/kassen/:id/drucker/test ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${KASSE_ID}/drucker/test`,
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('POST /api/belege/:id/drucken ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/belege/${BELEG_ID}/drucken`,
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kassen/:id/drucker
// ---------------------------------------------------------------------------

describe('GET /api/kassen/:id/drucker', () => {
  it('200 liefert Drucker-Konfiguration', async () => {
    const kasse = kasseRow({ druckerAktiv: true, druckerIp: '192.168.1.100', druckerPort: 9100 })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [kasse]],
    }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/drucker`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.druckerAktiv).toBe(true)
    expect(body.druckerIp).toBe('192.168.1.100')
    expect(body.druckerPort).toBe(9100)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/drucker`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/kassen/keine-uuid/drucker',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/kassen/:id/drucker
// ---------------------------------------------------------------------------

describe('PATCH /api/kassen/:id/drucker', () => {
  it('200 aktualisiert Drucker-Konfiguration', async () => {
    const updated = kasseRow({ druckerIp: '10.0.0.5', druckerPort: 9100, druckerAktiv: true })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }]],
      updates: [[updated]],
    }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${KASSE_ID}/drucker`,
      headers: srv.authHeader(),
      payload: { druckerIp: '10.0.0.5', druckerAktiv: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().druckerIp).toBe('10.0.0.5')
    expect(res.json().druckerAktiv).toBe(true)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${KASSE_ID}/drucker`,
      headers: srv.authHeader(),
      payload: { druckerAktiv: false },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 bei ungültigem Port', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[{ id: KASSE_ID }]] }))
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${KASSE_ID}/drucker`,
      headers: srv.authHeader(),
      payload: { druckerPort: 99999 },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kassen/:id/drucker/status  (Offline-Verhalten)
// ---------------------------------------------------------------------------

describe('GET /api/kassen/:id/drucker/status', () => {
  it('online: null wenn Drucker deaktiviert', async () => {
    const kasse = kasseRow({ druckerAktiv: false })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [kasse]],
    }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/drucker/status`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().online).toBeNull()
    expect(res.json().grund).toBeDefined()
    await srv.close()
  })

  it('online: false wenn Drucker nicht erreichbar (TCP-Check)', async () => {
    // IP 192.0.2.1 (TEST-NET-1, RFC 5737) ist nie erreichbar → sofortiger Timeout/Fehler
    const kasse = kasseRow({ druckerAktiv: true, druckerIp: '192.0.2.1', druckerPort: 19999 })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [kasse]],
    }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/drucker/status`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().online).toBe(false)
    await srv.close()
  }, 6_000)  // TCP-Timeout abwarten
})

// ---------------------------------------------------------------------------
// GET /api/kassen/:id/drucker/log
// ---------------------------------------------------------------------------

describe('GET /api/kassen/:id/drucker/log', () => {
  it('200 mit leerer Druckhistorie', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], []],
    }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/drucker/log`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })

  it('200 mit Druckhistorie-Einträgen', async () => {
    const eintrag = {
      id:         'log-0000-0000-0000-000000000001',
      druckerIp:  '192.168.1.100',
      druckerTyp: 'bon',
      belegId:    BELEG_ID,
      erfolg:     true,
      fehlerText: null,
      erstelltAt: new Date('2026-06-15T10:00:00Z'),
    }
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [eintrag]],
    }))
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${KASSE_ID}/drucker/log`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].druckerIp).toBe('192.168.1.100')
    expect(body[0].erfolg).toBe(true)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kassen/:id/drucker/test  (Offline-Verhalten)
// ---------------------------------------------------------------------------

describe('POST /api/kassen/:id/drucker/test', () => {
  it('409 wenn Drucker nicht konfiguriert', async () => {
    const kasse = kasseRow({ druckerAktiv: false })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [kasse]],
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${KASSE_ID}/drucker/test`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(409)
    await srv.close()
  })

  it('404 wenn Kasse nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${KASSE_ID}/drucker/test`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  /**
   * Offline-Verhalten: Wenn der Drucker konfiguriert ist aber nicht erreichbar,
   * muss der Endpunkt 502 zurückgeben (statt zu hängen oder 500 zu werfen).
   * Druckfehler dürfen NICHT den Beleg-Flow blockieren — sie werden nur geloggt.
   */
  it('502 wenn Drucker konfiguriert aber offline', async () => {
    // Port 19999 auf localhost ist im Test-Kontext nicht geöffnet
    const kasse = kasseRow({
      druckerAktiv:      true,
      druckerIp:         '127.0.0.1',
      druckerPort:       19999,
      druckerTimeoutSek: 2,
    })
    const srv = await buildTestServer(mockDb({
      selects: [[{ id: KASSE_ID }], [kasse]],
      inserts: [[{ id: 'log-1' }]],
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${KASSE_ID}/drucker/test`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().fehler).toBeDefined()
    await srv.close()
  }, 8_000)
})

// ---------------------------------------------------------------------------
// POST /api/belege/:id/drucken
// ---------------------------------------------------------------------------

describe('POST /api/belege/:id/drucken (Reprint)', () => {
  it('409 wenn Drucker an Kasse nicht konfiguriert', async () => {
    const kasse = kasseRow({ druckerAktiv: false })
    const srv = await buildTestServer(mockDb({
      selects: [
        [{ id: BELEG_ID }],                  // pruefeBelegGehoertZuMandant
        [belegRow()],                         // select beleg in druckeBeleg
        [kasse],                              // select kasse in druckeBeleg
      ],
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/belege/${BELEG_ID}/drucken`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(409)
    await srv.close()
  })

  it('404 wenn Beleg nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/belege/${BELEG_ID}/drucken`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('404 wenn Beleg nicht zum Mandanten gehört', async () => {
    // pruefeBelegGehoertZuMandant gibt leer zurück → 404
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/belege/${BELEG_ID}/drucken`,
      headers: srv.authHeader({ mandantId: 'other-mandant-0000-000000000000' }),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})
