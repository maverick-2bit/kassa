/**
 * Gemeinsamer Test-Server-Builder.
 * Registriert das Auth-Plugin + alle Routen mit gemeinsamer Test-Config.
 * Liefert zusätzlich einen Token-Generator für authentifizierte Aufrufe.
 */

import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server.js'
import type { Db } from '../../src/db/client.js'
import type { Berechtigung, Rolle } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'

export const TEST_MASTER     = 'test-passphrase-long-enough'
export const TEST_JWT_SECRET = 'test-jwt-secret-key-very-long-and-secret-12345'

export const TEST_MANDANT_ID = '10000000-0000-0000-0000-000000000001'
export const TEST_USER_ID    = '20000000-0000-0000-0000-000000000001'

export interface TestServer {
  fastify: FastifyInstance
  /** Erzeugt einen gültigen JWT für die Tests */
  signTestToken: (overrides?: {
    sub?:            string
    mandantId?:      string
    rolle?:          Rolle
    name?:           string
    berechtigungen?: Berechtigung[]
  }) => string
  authHeader: (overrides?: Parameters<TestServer['signTestToken']>[0]) => { authorization: string }
  close: () => Promise<void>
}

export interface BuildTestServerOptions {
  finanzOnlineClient?: FinanzOnlineClient
}

export async function buildTestServer(db: Db, opts: BuildTestServerOptions = {}): Promise<TestServer> {
  const fastify = await buildServer({
    config: {
      DATABASE_URL:      'postgresql://test',
      MASTER_PASSPHRASE: TEST_MASTER,
      JWT_SECRET:        TEST_JWT_SECRET,
      JWT_EXPIRES_IN:    '1h',
      PORT:              3000,
      LOG_LEVEL:         'fatal',
      CORS_ORIGIN:       '*',
      NODE_ENV:          'test',
      MONITORING_TOKEN:  'test-monitoring-token',
      DB_BACKUP_MAX_AGE_STUNDEN:  26,
      DEP_BACKUP_MAX_AGE_STUNDEN: 26,
    },
    db,
    setupDeps: {
      db,
      masterPassphrase: TEST_MASTER,
      ...(opts.finanzOnlineClient && { rksvOptionen: { finanzOnlineClient: opts.finanzOnlineClient } }),
    },
    belegDeps: { db, masterPassphrase: TEST_MASTER },
  })

  await fastify.ready()

  const signTestToken: TestServer['signTestToken'] = (overrides = {}) =>
    fastify.jwt.sign({
      sub:             overrides.sub             ?? TEST_USER_ID,
      mandantId:       overrides.mandantId       ?? TEST_MANDANT_ID,
      rolle:           overrides.rolle           ?? 'admin',
      name:            overrides.name            ?? 'Test User',
      berechtigungen:  overrides.berechtigungen  ?? [],
    })

  return {
    fastify,
    signTestToken,
    authHeader: (overrides) => ({ authorization: `Bearer ${signTestToken(overrides)}` }),
    close:      () => fastify.close(),
  }
}
