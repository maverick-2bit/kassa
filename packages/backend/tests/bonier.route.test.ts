/**
 * Tests für den Bonier-Endpunkt (POST /api/bestellung/bonieren).
 *
 * Bonierung ist KEIN RKSV-Vorgang — sie sendet Bons an KDS/Bonierdrucker
 * vor der eigentlichen Rechnungserstellung.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const KASSE_ID   = 'a1000000-0000-0000-0000-000000000001'
const ARTIKEL_ID = 'c1000000-0000-0000-0000-000000000001'
const BD_BACKUP  = 'd1000000-0000-0000-0000-000000000001'

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

function mockDb({ selects = [] }: { selects?: unknown[][] } = {}): Db {
  let si = 0
  return {
    select: () => ({
      from: () => ({
        where: () => makeResult(selects[si++] ?? []),
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
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    }),
    transaction: async (fn: any) =>
      fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  } as unknown as Db
}

const kasseRow = (overrides: Record<string, unknown> = {}) => ({
  id:           KASSE_ID,
  mandantId:    TEST_MANDANT_ID,
  kassenId:     'KASSE-BON',
  kdsAktiv:     false,
  kdsPort:      9200,
  kdsStationen: {},
  druckerAktiv: false,
  druckerIp:    null,
  druckerPort:  9100,
  ...overrides,
})

const artikelRow = (overrides: Record<string, unknown> = {}) => ({
  id:               ARTIKEL_ID,
  mandantId:        TEST_MANDANT_ID,
  bezeichnung:      'Pizza Margherita',
  station:          null,
  kategorieId:      null,
  bonierdruckerId:  null,
  lagerstandAktiv:  false,
  lagerstandMenge:  null,
  mindestbestand:   null,
  aktiv:            true,
  ...overrides,
})

const backupDruckerRow = () => ({
  id:         BD_BACKUP,
  mandantId:  TEST_MANDANT_ID,
  name:       'Backup Bon',
  ip:         '127.0.0.1',
  port:       19999,       // nicht geöffnet → TCP schlägt fehl
  istBackup:  true,
  fallbackId: null,
  aktiv:      true,
  createdAt:  new Date(),
  updatedAt:  new Date(),
})

const gueltigeBestellung = () => ({
  kasseId:    KASSE_ID,
  tisch:      'Tisch 5',
  kellner:    'Anna',
  positionen: [{ artikelId: ARTIKEL_ID, menge: 2 }],
})

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz Bonieren', () => {
  it('POST /api/bestellung/bonieren ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/bestellung/bonieren',
      payload: gueltigeBestellung(),
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/bestellung/bonieren
// ---------------------------------------------------------------------------

describe('POST /api/bestellung/bonieren', () => {
  it('400 wenn kasseId fehlt', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/bestellung/bonieren',
      headers: srv.authHeader(),
      payload: { tisch: 'Tisch 1', kellner: 'Bob', positionen: [{ artikelId: ARTIKEL_ID, menge: 1 }] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 wenn positionen leer', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/bestellung/bonieren',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, tisch: 'Tisch 1', kellner: 'Bob', positionen: [] },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('404 wenn Kasse nicht im Mandanten', async () => {
    // pruefeKasseGehoertZuMandant → leere Antwort → 404
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/bestellung/bonieren',
      headers: srv.authHeader(),
      payload: gueltigeBestellung(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 wenn kein Routing möglich (kein KDS, kein Bonierdrucker)', async () => {
    // Kasse ohne KDS, Artikel ohne Station/Bonierdrucker, keine Backup-Drucker
    const srv = await buildTestServer(mockDb({
      selects: [
        [{ id: KASSE_ID }],          // pruefeKasseGehoertZuMandant
        [kasseRow()],                 // kassen select in bonierBestellung
        [artikelRow()],               // artikel select
        [],                           // bonierdrucker select (leer — kein Backup)
      ],
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/bestellung/bonieren',
      headers: srv.authHeader(),
      payload: gueltigeBestellung(),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toMatch(/nichts zu bonieren/i)
    await srv.close()
  })

  /**
   * Happy-Path: Backup-Drucker vorhanden, aber offline (TCP schlägt fehl).
   * Der Bon gilt als gesendet (200), Druckfehler werden im Ergebnis vermerkt.
   */
  it('200 mit Backup-Drucker auch wenn Drucker offline', async () => {
    const srv = await buildTestServer(mockDb({
      selects: [
        [{ id: KASSE_ID }],          // pruefeKasseGehoertZuMandant
        [kasseRow()],                 // kassen select
        [artikelRow()],               // artikel select (1 Artikel für 1 ArtikelId)
        [backupDruckerRow()],         // bonierdrucker select (Backup)
      ],
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/bestellung/bonieren',
      headers: srv.authHeader(),
      payload: gueltigeBestellung(),
    })
    // stationen ist leer → every() = true → 200
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.bonNummer).toBeDefined()
    expect(body.stationen).toEqual([])
    expect(body.drucker).toHaveLength(1)
    expect(body.drucker[0].istBackup).toBe(true)
    expect(body.drucker[0].erfolgreich).toBe(false)  // TCP schlägt fehl
    await srv.close()
  }, 8_000)
})
