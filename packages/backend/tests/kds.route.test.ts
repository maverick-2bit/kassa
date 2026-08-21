/**
 * Tests für /api/kds/* (Browser-KDS-Routen).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const BON_ID  = 'bd000000-0000-0000-0000-000000000001'
const POS_ID  = 'cd000000-0000-0000-0000-000000000001'

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
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db
}

function bonRow(overrides: Record<string, unknown> = {}) {
  return {
    id:         BON_ID,
    mandantId:  TEST_MANDANT_ID,
    bonNummer:  'B-001',
    station:    'kueche',
    tisch:      '5',
    bereich:    null,
    kellner:    'Maria',
    positionen: [{ id: POS_ID, bezeichnung: 'Schnitzel', menge: 1, erledigt: false }],
    status:     'offen',
    erstelltAt: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// GET /api/kds/events  (SSE)
// ---------------------------------------------------------------------------

describe('GET /api/kds/events', () => {
  it('401 wenn Token fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/kds/events?station=kueche',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('401 bei ungültigem Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/kds/events?station=kueche&token=nicht-ein-jwt',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 wenn Station fehlt', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const token = srv.signTestToken()
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    `/api/kds/events?token=${token}`,
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 und liefert SSE-Stream bei gültigem Token + Station', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[bonRow()]] }))
    const token = srv.signTestToken()
    // SSE-Verbindung bleibt offen — Stream-Modus nutzen und nach dem Snapshot abbrechen
    const res = await srv.fastify.inject({
      method:          'GET',
      url:             `/api/kds/events?station=kueche&token=${token}`,
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const stream = res.stream()
    const chunk = await new Promise<string>(resolve => {
      stream.once('data', (d: Buffer) => resolve(d.toString()))
    })
    expect(chunk).toContain('data:')
    expect(chunk).toContain('"typ":"snapshot"')
    stream.destroy()
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/kds/bons
// ---------------------------------------------------------------------------

describe('GET /api/kds/bons', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET',
      url:    '/api/kds/bons?station=kueche',
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 wenn Station fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kds/bons',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('200 und gibt offene Bons zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[bonRow()]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kds/bons?station=kueche',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0].bonNummer).toBe('B-001')
    expect(body[0].station).toBe('kueche')
    await srv.close()
  })

  it('200 mit leerer Liste', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/kds/bons?station=kueche',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kds/bon/:id/erledigt
// ---------------------------------------------------------------------------

describe('POST /api/kds/bon/:id/erledigt', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST',
      url:    `/api/kds/bon/${BON_ID}/erledigt`,
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 bei ungültiger UUID', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/kds/bon/keine-uuid/erledigt',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Bon nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/erledigt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('404 wenn Bon bereits erledigt', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[bonRow({ status: 'erledigt' })]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/erledigt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 bei erfolgreichem Abschluss', async () => {
    // Zwei Selects: (1) Vorab-Lesen für den Runner-Beleg (was ist noch offen?),
    // (2) das Lesen im Service selbst. Danach greifen pruefeSbBereit und der
    // Bonierdrucker-Lookup ins Leere (leere Queue = keine Treffer) — unkritisch.
    const srv = await buildTestServer(mockDb({
      selects: [[bonRow()], [bonRow()]],
      updates: [[bonRow({ status: 'erledigt' })]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/erledigt`,
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().erfolgreich).toBe(true)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kds/bon/:id/teilbon
// ---------------------------------------------------------------------------

describe('POST /api/kds/bon/:id/teilbon', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      payload: { positionsMengen: [{ id: POS_ID, menge: 1 }] },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('400 bei ungültiger UUID im Pfad', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/kds/bon/keine-uuid/teilbon',
      headers: srv.authHeader(),
      payload: { positionsMengen: [{ id: POS_ID, menge: 1 }] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn positionsMengen leer', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: { positionsMengen: [] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn positionsMengen fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Bon nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: { positionsMengen: [{ id: POS_ID, menge: 1 }] },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('200 bei erfolgreichem Teilbon', async () => {
    const updatedBon = bonRow({
      positionen: [{ id: POS_ID, bezeichnung: 'Schnitzel', menge: 1, erledigtMenge: 1, erledigt: true }],
      status: 'erledigt',
    })
    const srv = await buildTestServer(mockDb({
      selects: [[bonRow()]],
      updates: [[updatedBon]],
    }))
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     `/api/kds/bon/${BON_ID}/teilbon`,
      headers: srv.authHeader(),
      payload: { positionsMengen: [{ id: POS_ID, menge: 1 }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().erfolgreich).toBe(true)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/kds/geraete-token  (langlebiger Token für KDS-Bildschirme)
// ---------------------------------------------------------------------------

describe('POST /api/kds/geraete-token', () => {
  it('Admin bekommt einen Geräte-Token, der an KDS-Routen funktioniert', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kds/geraete-token', headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const { token } = res.json() as { token: string }
    expect(token).toBeTruthy()

    const bons = await srv.fastify.inject({
      method: 'GET', url: '/api/kds/bons?station=kueche',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(bons.statusCode).toBe(200)
    await srv.close()
  })

  it('Kellner darf keinen Geräte-Token ausstellen (403), anonym 401', async () => {
    const srv = await buildTestServer(mockDb())
    const kellner = await srv.fastify.inject({
      method: 'POST', url: '/api/kds/geraete-token',
      headers: srv.authHeader({ rolle: 'kellner' }),
    })
    expect(kellner.statusCode).toBe(403)
    const anonym = await srv.fastify.inject({ method: 'POST', url: '/api/kds/geraete-token' })
    expect(anonym.statusCode).toBe(401)
    await srv.close()
  })

  it('der Geräte-Token ist außerhalb von /api/kds wertlos (403)', async () => {
    // Der Kern der Sache: ein abfotografierter KDS-QR gibt nur Küchen-Bons
    // frei — niemals Kassen-, Artikel- oder Benutzerdaten.
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const { token } = (await srv.fastify.inject({
      method: 'POST', url: '/api/kds/geraete-token', headers: srv.authHeader(),
    })).json() as { token: string }

    const H = { authorization: `Bearer ${token}` }
    const kategorien = await srv.fastify.inject({ method: 'GET', url: '/api/kategorien', headers: H })
    expect(kategorien.statusCode).toBe(403)
    const users = await srv.fastify.inject({ method: 'GET', url: '/api/users', headers: H })
    expect(users.statusCode).toBe(403)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// Einrichtungs-Code (PC-Pairing)
// ---------------------------------------------------------------------------

describe('POST /api/kds/einrichtungscode (+ einloesen)', () => {
  it('Admin erzeugt Code, Gerät löst ihn öffentlich gegen einen Token ein — einmalig', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const erz = await srv.fastify.inject({
      method: 'POST', url: '/api/kds/einrichtungscode', headers: srv.authHeader(),
    })
    expect(erz.statusCode).toBe(200)
    const { code } = erz.json() as { code: string }
    expect(code).toMatch(/^\d{6}$/)

    // Einlösen OHNE jede Anmeldung — das frische Gerät hat keine
    const tausch = await srv.fastify.inject({
      method: 'POST', url: '/api/kds/einrichtungscode/einloesen', payload: { code },
    })
    expect(tausch.statusCode).toBe(200)
    const { token } = tausch.json() as { token: string }

    // Der eingetauschte Token funktioniert an KDS-Routen …
    const bons = await srv.fastify.inject({
      method: 'GET', url: '/api/kds/bons?station=kueche',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(bons.statusCode).toBe(200)

    // … und der Code ist verbraucht
    const nochmal = await srv.fastify.inject({
      method: 'POST', url: '/api/kds/einrichtungscode/einloesen', payload: { code },
    })
    expect(nochmal.statusCode).toBe(404)
    await srv.close()
  })

  it('falscher/fehlerhafter Code wird abgelehnt, Erzeugen braucht Admin', async () => {
    const srv = await buildTestServer(mockDb())
    expect((await srv.fastify.inject({
      method: 'POST', url: '/api/kds/einrichtungscode/einloesen', payload: { code: '000000' },
    })).statusCode).toBe(404)
    expect((await srv.fastify.inject({
      method: 'POST', url: '/api/kds/einrichtungscode/einloesen', payload: { code: 'abc' },
    })).statusCode).toBe(400)
    expect((await srv.fastify.inject({
      method: 'POST', url: '/api/kds/einrichtungscode', headers: srv.authHeader({ rolle: 'kellner' }),
    })).statusCode).toBe(403)
    await srv.close()
  })
})
