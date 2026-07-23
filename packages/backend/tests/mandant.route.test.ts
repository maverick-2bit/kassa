/**
 * Tests für /api/mandanten/module (GET + PATCH).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

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
  } as unknown as Db
}

const moduleRow = (overrides: Record<string, unknown> = {}) => ({
  modulGastroAktiv:    false,
  modulAngeboteAktiv:  false,
  modulMergeportAktiv: false,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth-Schutz Mandant', () => {
  it('GET ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/module' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/mandanten/module
// ---------------------------------------------------------------------------

describe('GET /api/mandanten/module', () => {
  it('200 gibt Module zurück', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[moduleRow({ modulGastroAktiv: true })]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/mandanten/module',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.modulGastroAktiv).toBe(true)
    expect(body.modulAngeboteAktiv).toBe(false)
    await srv.close()
  })

  it('404 wenn Mandant nicht gefunden', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[]] }))
    const res = await srv.fastify.inject({
      method:  'GET',
      url:     '/api/mandanten/module',
      headers: srv.authHeader(),
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/mandanten/module
// ---------------------------------------------------------------------------

describe('PATCH /api/mandanten/module', () => {
  it('200 als Admin', async () => {
    const srv = await buildTestServer(mockDb({ updates: [[moduleRow({ modulGastroAktiv: true })]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/module',
      headers: srv.authHeader(),   // rolle=admin (Standard)
      payload: { modulGastroAktiv: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().modulGastroAktiv).toBe(true)
    await srv.close()
  })

  it('200 als Kellner mit Berechtigung "einstellungen"', async () => {
    const srv = await buildTestServer(mockDb({ updates: [[moduleRow({ modulAngeboteAktiv: true })]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/module',
      headers: srv.authHeader({ rolle: 'kellner', berechtigungen: ['einstellungen'] }),
      payload: { modulAngeboteAktiv: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().modulAngeboteAktiv).toBe(true)
    await srv.close()
  })

  it('403 als Kellner ohne Berechtigung', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/module',
      headers: srv.authHeader({ rolle: 'kellner', berechtigungen: [] }),
      payload: { modulGastroAktiv: true },
    })
    expect(res.statusCode).toBe(403)
    await srv.close()
  })

  it('400 bei leerem Body', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/module',
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 bei ungültigem Feld', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/module',
      headers: srv.authHeader(),
      payload: { modulGastroAktiv: 'kein-boolean' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET/PATCH /api/mandanten/stripe (pro-Mandant-Keys, write-only)
// ---------------------------------------------------------------------------

describe('GET /api/mandanten/stripe', () => {
  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/stripe' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('meldet konfiguriertes eigenes Konto — ohne Klartext-Secrets', async () => {
    // sec/wh sind (Pseudo-)Ciphertexte; die Route gibt nur Booleans zurück, nie den Inhalt
    const srv = await buildTestServer(mockDb({ selects: [[{ sec: 'ENC-sec', wh: 'ENC-wh' }]] }))
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/stripe', headers: srv.authHeader() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.secretKeyGesetzt).toBe(true)
    expect(body.webhookSecretGesetzt).toBe(true)
    expect(body.eigenesKontoAktiv).toBe(true)
    expect(body.globalerFallbackAktiv).toBe(false) // Test-Config hat keine Env-Keys
    expect(body.webhookPfad).toMatch(/^\/api\/stripe\/webhook\/[0-9a-f-]+$/)
    // Kein Klartext/Ciphertext im Response
    expect(res.body).not.toContain('ENC-sec')
    expect(res.body).not.toContain('secretKey"')
    await srv.close()
  })

  it('meldet „nicht konfiguriert" wenn keine Keys gesetzt', async () => {
    const srv = await buildTestServer(mockDb({ selects: [[{ sec: null, wh: null }]] }))
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/stripe', headers: srv.authHeader() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.eigenesKontoAktiv).toBe(false)
    expect(body.secretKeyGesetzt).toBe(false)
    await srv.close()
  })
})

describe('PATCH /api/mandanten/stripe', () => {
  it('200 als Admin: gültige Keys werden angenommen (Response ohne Klartext)', async () => {
    const srv = await buildTestServer(mockDb({ updates: [[{ sec: 'ENC-sec', wh: 'ENC-wh' }]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/stripe',
      headers: srv.authHeader(),
      payload: { secretKey: 'sk_test_ABC123', webhookSecret: 'whsec_ABC123' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().eigenesKontoAktiv).toBe(true)
    expect(res.body).not.toContain('sk_test_ABC123')
    await srv.close()
  })

  it('200 löscht die Keys mit null', async () => {
    const srv = await buildTestServer(mockDb({ updates: [[{ sec: null, wh: null }]] }))
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/stripe',
      headers: srv.authHeader(),
      payload: { secretKey: null, webhookSecret: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().eigenesKontoAktiv).toBe(false)
    await srv.close()
  })

  it('400 bei falschem Key-Präfix', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/stripe',
      headers: srv.authHeader(),
      payload: { secretKey: 'kein-stripe-key' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('400 bei leerem Body (keine Änderung)', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/stripe',
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })

  it('403 als Kellner ohne Berechtigung', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method:  'PATCH',
      url:     '/api/mandanten/stripe',
      headers: srv.authHeader({ rolle: 'kellner', berechtigungen: [] }),
      payload: { secretKey: 'sk_test_X' },
    })
    expect(res.statusCode).toBe(403)
    await srv.close()
  })
})
