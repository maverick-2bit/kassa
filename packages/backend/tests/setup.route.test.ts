/**
 * Integrationstests für POST /api/setup
 *
 * Strategie:
 *   - Fastify .inject() für In-Memory-Tests (kein echter HTTP-Server)
 *   - DB komplett gemockt (Drizzle-Querybuilder als Stub)
 *   - FinanzOnlineClient gemockt (kein echter HTTP-Call zum BMF)
 */

import { describe, it, expect, vi } from 'vitest'
import { buildServer } from '../src/server.js'
import type { SetupResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { Db } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

function mockDb(opts: { existingMandant?: boolean } = {}): Db {
  // select(...).from(...).where(...).limit(...) — Existenzprüfung
  const selectChain = {
    from:  () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(opts.existingMandant ? [{ id: 'existing-uuid' }] : []),
  }

  // transaction(cb) — führt cb mit Mock-Transaktion aus
  const txMock = {
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: '00000000-0000-0000-0000-000000000001' }]),
      }),
    }),
  }

  return {
    select:      () => selectChain,
    transaction: async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
    // Andere Methoden werden hier nicht gebraucht
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
// Test-Fixture
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
}

async function buildTestServer(deps: {
  db?: Db
  foClient?: FinanzOnlineClient
} = {}) {
  return buildServer({
    config: {
      DATABASE_URL:      'postgresql://test',
      MASTER_PASSPHRASE: 'test-passphrase-long-enough',
      PORT:              3000,
      LOG_LEVEL:         'fatal',
      CORS_ORIGIN:       '*',
      NODE_ENV:          'test',
    },
    setupDeps: {
      db:               deps.db ?? mockDb(),
      masterPassphrase: 'test-passphrase-long-enough',
      rksvOptionen:     deps.foClient ? { finanzOnlineClient: deps.foClient } : undefined,
    },
  })
}

// ---------------------------------------------------------------------------
// Health-Endpoint
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('antwortet mit ok', async () => {
    const server = await buildTestServer()
    const res    = await server.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
    await server.close()
  })
})

// ---------------------------------------------------------------------------
// Setup-Endpoint
// ---------------------------------------------------------------------------

describe('POST /api/setup', () => {
  it('führt erfolgreiches Setup durch (HTTP 201)', async () => {
    const server = await buildTestServer({ foClient: mockFoClient({ pruefwert: 'PW-ABC' }) })
    const res    = await server.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: validInput,
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as SetupResponse
    expect(body.erfolgreich).toBe(true)
    expect(body.mandantId).toBeTruthy()
    expect(body.kasseId).toBeTruthy()
    expect(body.startbelegNummer).toBe(1)
    expect(body.startbelegMaschinenlesbareCode).toMatch(/^_R1-AT_/)
    expect(body.pruefwert).toBe('PW-ABC')
    await server.close()
  })

  it('lehnt ungültige Eingabe ab (HTTP 400)', async () => {
    const server = await buildTestServer()
    const res    = await server.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: { ...validInput, uid: 'DE12345678' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as SetupResponse
    expect(body.erfolgreich).toBe(false)
    expect(body.fehler).toContain('UID')
    await server.close()
  })

  it('lehnt bereits existierende UID ab', async () => {
    const server = await buildTestServer({
      db:       mockDb({ existingMandant: true }),
      foClient: mockFoClient(),
    })
    const res = await server.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: validInput,
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as SetupResponse
    expect(body.erfolgreich).toBe(false)
    expect(body.fehler).toContain('bereits aktiv registriert')
    await server.close()
  })

  it('meldet FinanzOnline-Fehler als HTTP 400', async () => {
    const foClient = {
      kasseInBetriebNehmen: vi.fn().mockResolvedValue({
        erfolgreich: false,
        fehler:      'TID/PIN ungültig (Code 042)',
      }),
      startbelegPruefen:        vi.fn(),
      kasseAusserBetriebNehmen: vi.fn(),
    } as unknown as FinanzOnlineClient

    const server = await buildTestServer({ foClient })
    const res    = await server.inject({
      method:  'POST',
      url:     '/api/setup',
      payload: validInput,
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as SetupResponse
    expect(body.fehler).toContain('TID/PIN ungültig')
    await server.close()
  })

  it('Body fehlt → 400', async () => {
    const server = await buildTestServer()
    const res    = await server.inject({
      method: 'POST',
      url:    '/api/setup',
    })

    expect(res.statusCode).toBe(400)
    await server.close()
  })
})
