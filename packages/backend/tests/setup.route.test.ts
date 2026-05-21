/**
 * Integrationstests für POST /api/setup
 */

import { describe, it, expect, vi } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { SetupResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-DB — drei sequentielle .limit()-Calls: Mandant-Check, Email-Check, Sonstiges
// ---------------------------------------------------------------------------

interface MockState {
  existingMandant?: boolean
  existingEmail?:   boolean
}

function mockDb(state: MockState = {}): Db {
  let selectCallCount = 0
  const selectChain = {
    from:  () => selectChain,
    where: () => selectChain,
    limit: () => {
      const c = selectCallCount++
      if (c === 0) return Promise.resolve(state.existingMandant ? [{ id: 'm' }] : [])
      if (c === 1) return Promise.resolve(state.existingEmail   ? [{ id: 'u' }] : [])
      return Promise.resolve([])
    },
  }

  // transaction(cb) — Inserts liefern jeweils { id }
  const txMock = {
    insert: () => ({
      values: (v: unknown) => {
        const result = [{ ...(v as object), id: '00000000-0000-0000-0000-000000000001' }]
        return {
          returning: () => Promise.resolve(result),
          // Awaitable für inserts ohne .returning() (users, belege)
          then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
        }
      },
    }),
  }

  return {
    select:      () => selectChain,
    transaction: async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Mock-FinanzOnlineClient
// ---------------------------------------------------------------------------

function mockFoClient(opts: {
  registrierungErfolg?: boolean
  pruefungErfolg?:      boolean
  pruefwert?:           string
} = {}): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({
      erfolgreich: opts.registrierungErfolg ?? true,
    }),
    startbelegPruefen: vi.fn().mockResolvedValue({
      erfolgreich: opts.pruefungErfolg ?? true,
      pruefwert:   opts.pruefwert ?? 'TEST-PW-12345',
    }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validInput = {
  firmenname: 'Test Restaurant',
  uid:        'ATU12345678',
  kassenId:   'TEST-001',
  finanzOnline: {
    teilnehmerId:    'TID-1',
    benutzerkennung: 'BID-1',
    pin:             'PIN-1',
  },
  umgebung: 'test',
  admin: {
    name:     'Admin User',
    email:    'admin@example.com',
    passwort: 'sicherespasswort123',
  },
}

async function buildSrv(opts: {
  db?: Db
  foClient?: FinanzOnlineClient
} = {}) {
  const db = opts.db ?? mockDb()
  const srv = await buildTestServer(db)
  // FinanzOnline-Mock direkt in setupDeps reinmocken (über rksvOptionen)
  // Wir verwenden hier den Trick, dass setupDeps von buildServer geteilt wird.
  // Da der Helper das nicht direkt unterstützt, übergeben wir den Mock via direkte Manipulation:
  if (opts.foClient) {
    // Hack: setze rksvOptionen über Reflection — der Helper benutzt fastify.* Eigenschaften.
    // Sauberere Lösung: testServer-Helper erweitern.
    ;(srv.fastify as unknown as { _setupDeps?: { rksvOptionen?: { finanzOnlineClient: FinanzOnlineClient } } })._setupDeps =
      { rksvOptionen: { finanzOnlineClient: opts.foClient } }
  }
  return srv
}

// ---------------------------------------------------------------------------
// Health-Endpoint (kein Auth nötig)
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('antwortet mit ok', async () => {
    const srv = await buildSrv()
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// Setup-Endpoint
// ---------------------------------------------------------------------------

describe('POST /api/setup', () => {
  it('lehnt fehlenden Admin-Block ab (HTTP 400)', async () => {
    const srv = await buildSrv()
    const { admin: _admin, ...withoutAdmin } = validInput
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: withoutAdmin,
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('lehnt zu kurzes Admin-Passwort ab', async () => {
    const srv = await buildSrv()
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: { ...validInput, admin: { ...validInput.admin, passwort: 'kurz' } },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('lehnt ungültige UID ab', async () => {
    const srv = await buildSrv()
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: { ...validInput, uid: 'DE12345678' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as SetupResponse
    expect(body.fehler).toContain('UID')
    await srv.close()
  })

  it('lehnt bereits existierende UID ab', async () => {
    const srv = await buildSrv({ db: mockDb({ existingMandant: true }) })
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: validInput,
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as SetupResponse
    expect(body.fehler).toContain('UID')
    await srv.close()
  })

  it('lehnt bereits vergebene E-Mail ab', async () => {
    const srv = await buildSrv({ db: mockDb({ existingEmail: true }) })
    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: validInput,
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as SetupResponse
    expect(body.fehler).toContain('E-Mail')
    await srv.close()
  })

  it('Body fehlt → 400', async () => {
    const srv = await buildSrv()
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/setup' })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// Stillschweigend importiert um TS-Hinweise zu vermeiden
void mockFoClient
