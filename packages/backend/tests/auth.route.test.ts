/**
 * Tests für die Auth-Routen.
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID } from './helpers/testServer.js'
import { hashPassword } from '../src/services/auth.service.js'
import type { Db } from '../src/db/client.js'

interface MockState {
  user?:    Record<string, unknown> | null
  mandant?: Record<string, unknown> | null
  kassen?:  Record<string, unknown>[]
}

function mockDb(state: MockState = {}): Db {
  // login-Flow: select users → select mandanten → select kassen (3 sequenzielle Selects)
  // /auth/me: select users → select mandanten → select kassen
  let callCount = 0
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const i = callCount++
          return {
            limit: () => {
              if (i % 3 === 0) return Promise.resolve(state.user    ? [state.user]    : [])
              if (i % 3 === 1) return Promise.resolve(state.mandant ? [state.mandant] : [])
              return Promise.resolve(state.kassen ?? [])
            },
            // wenn .limit nicht aufgerufen wird (kassen-Liste), direkt awaiten
            then: (resolve: (v: unknown) => void) =>
              Promise.resolve(state.kassen ?? []).then(resolve),
          }
        },
      }),
    }),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

describe('POST /api/auth/login', () => {
  it('liefert Token bei korrekten Credentials', async () => {
    const passwortHash = await hashPassword('geheim1234')
    const srv = await buildTestServer(mockDb({
      user: {
        id:           '11111111-1111-1111-1111-111111111111',
        mandantId:    TEST_MANDANT_ID,
        email:        'admin@example.com',
        passwordHash: passwortHash,
        name:         'Admin User',
        rolle:        'admin',
        aktiv:        true,
        createdAt:    new Date('2026-05-20'),
        updatedAt:    new Date('2026-05-20'),
      },
      mandant: { id: TEST_MANDANT_ID, firmenname: 'Test GmbH', uid: 'ATU12345678' },
      kassen:  [],
    }))

    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/auth/login',
      payload: { email: 'admin@example.com', passwort: 'geheim1234' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.token).toBeTruthy()
    expect(body.user.email).toBe('admin@example.com')
    expect(body.user.rolle).toBe('admin')
    expect(body.mandant.firmenname).toBe('Test GmbH')
    await srv.close()
  })

  it('lehnt falsches Passwort ab (401)', async () => {
    const passwortHash = await hashPassword('geheim1234')
    const srv = await buildTestServer(mockDb({
      user: {
        id: 'x', mandantId: TEST_MANDANT_ID, email: 'admin@example.com',
        passwordHash: passwortHash, name: 'A', rolle: 'admin', aktiv: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'admin@example.com', passwort: 'FALSCH' },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('lehnt unbekannte E-Mail ab (401)', async () => {
    const srv = await buildTestServer(mockDb({ user: null }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'unbekannt@example.com', passwort: 'irgendwas' },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('lehnt deaktivierten User ab (403)', async () => {
    const passwortHash = await hashPassword('geheim1234')
    const srv = await buildTestServer(mockDb({
      user: {
        id: 'x', mandantId: TEST_MANDANT_ID, email: 'admin@example.com',
        passwordHash: passwortHash, name: 'A', rolle: 'admin', aktiv: false,
        createdAt: new Date(), updatedAt: new Date(),
      },
    }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'admin@example.com', passwort: 'geheim1234' },
    })
    expect(res.statusCode).toBe(403)
    await srv.close()
  })

  it('lehnt ungültige E-Mail-Format ab (400)', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'keine-email', passwort: 'geheim' },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

describe('GET /api/auth/me', () => {
  it('liefert User-Info bei gültigem Token', async () => {
    const srv = await buildTestServer(mockDb({
      user: {
        id:           '20000000-0000-0000-0000-000000000001',
        mandantId:    TEST_MANDANT_ID,
        email:        'admin@example.com',
        passwordHash: 'irrelevant',
        name:         'Admin',
        rolle:        'admin',
        aktiv:        true,
        createdAt:    new Date('2026-05-20'),
        updatedAt:    new Date('2026-05-20'),
      },
      mandant: { id: TEST_MANDANT_ID, firmenname: 'Test GmbH', uid: 'ATU12345678' },
      kassen:  [],
    }))

    const res = await srv.fastify.inject({
      method:  'GET', url: '/api/auth/me',
      headers: srv.authHeader(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user.email).toBe('admin@example.com')
    expect(body.mandant.uid).toBe('ATU12345678')
    await srv.close()
  })

  it('401 ohne Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('401 bei manipuliertem Token', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: 'Bearer invalid.token.here' },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })
})
