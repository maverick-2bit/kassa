/**
 * Tests für den Stripe-Webhook (öffentlich, kein JWT).
 * Ohne echte Stripe-Signaturen prüfbar: Routing (uuid), „nicht konfiguriert" (503).
 * Die eigentliche Signaturprüfung übernimmt das Stripe-SDK (verifiziereWebhook).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

// Mock-DB: liefert für ladeStripeKonfig keine Mandant-Keys → Env-Fallback greift (Test-Config: keiner)
function mockDb(): Db {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  } as unknown as Db
}

const MANDANT_UUID = '10000000-0000-0000-0000-000000000001'

describe('Stripe-Webhook', () => {
  it('globale Route ohne konfigurierte Keys → 503', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/stripe/webhook', payload: {} })
    expect(res.statusCode).toBe(503)
    await srv.close()
  })

  it('pro-Mandant-Route mit unkonfiguriertem Mandanten → 503', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/stripe/webhook/${MANDANT_UUID}`, payload: {} })
    expect(res.statusCode).toBe(503)
    await srv.close()
  })

  it('pro-Mandant-Route mit ungültiger Mandant-ID → 400', async () => {
    const srv = await buildTestServer(mockDb())
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/stripe/webhook/keine-uuid', payload: {} })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})
