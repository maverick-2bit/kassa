/**
 * Stripe-Webhook — bestätigt Gast-Zahlungen serverseitig (KEIN JWT).
 *
 *   POST /api/stripe/webhook/:mandantId   ← pro-Mandant (eigenes Stripe-Konto)
 *   POST /api/stripe/webhook              ← globaler Env-Fallback (ein Konto)
 *
 * Eigenes encapsuliertes Plugin mit Raw-Body-Parser: nur hier wird
 * application/json als Buffer geliefert (für die Signaturprüfung); der Rest der
 * App behält den normalen JSON-Parser. Die mandantId MUSS aus der URL kommen — die
 * Signaturprüfung braucht das (mandant-spezifische) Secret, bevor der Payload
 * vertrauenswürdig ist. Bei `checkout.session.completed` wird die Gast-Bestellung
 * idempotent finalisiert (RKSV-Beleg + Bonierung).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import type { BelegServiceDeps } from '../services/beleg.service.js'
import {
  verifiziereWebhook,
  ladeStripeKonfig,
  globaleStripeKonfig,
  type StripeKonfig,
} from '../services/stripe.service.js'
import { finalisiereGastBestellung, type GastServiceDeps } from '../services/gast-bestellung.service.js'

export interface StripeWebhookDeps { db: Db; belegDeps: BelegServiceDeps; config: Config }

async function verarbeiteWebhook(
  request: FastifyRequest,
  reply:   FastifyReply,
  konfig:  StripeKonfig | null,
  deps:    StripeWebhookDeps,
): Promise<FastifyReply> {
  if (!konfig) return reply.status(503).send({ fehler: 'Stripe nicht konfiguriert' })

  const sig = request.headers['stripe-signature']
  if (typeof sig !== 'string') return reply.status(400).send({ fehler: 'Signatur fehlt' })

  let event
  try {
    event = verifiziereWebhook(request.body as Buffer, sig, konfig)
  } catch (err) {
    request.log.warn({ err }, 'Stripe-Webhook-Signatur ungültig')
    return reply.status(400).send({ fehler: 'Signatur ungültig' })
  }

  if (event.type === 'checkout.session.completed') {
    const bestellungId = (event.data.object as { metadata?: { bestellungId?: string } }).metadata?.bestellungId
    if (bestellungId) {
      const gastDeps: GastServiceDeps = { db: deps.db, belegDeps: deps.belegDeps, config: deps.config }
      try {
        await finalisiereGastBestellung(bestellungId, gastDeps)
      } catch (err) {
        // 500 → Stripe wiederholt den Webhook; die Finalisierung ist über den Status-Claim idempotent.
        request.log.error({ err }, 'Gast-Finalisierung nach Stripe-Zahlung fehlgeschlagen')
        return reply.status(500).send({ fehler: 'Finalisierung fehlgeschlagen' })
      }
    }
  }
  return reply.send({ received: true })
}

export async function registerStripeWebhook(
  fastify: FastifyInstance,
  opts:    { deps: StripeWebhookDeps },
): Promise<void> {
  await fastify.register(async (stripe) => {
    // Raw-Body NUR in diesem Plugin — der Rest der App behält den JSON-Parser.
    stripe.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

    // Pro-Mandant: mandantId aus der URL → dessen (eigene oder Fallback-)Keys.
    stripe.post('/api/stripe/webhook/:mandantId', async (request, reply) => {
      const p = z.object({ mandantId: z.string().uuid() }).safeParse(request.params)
      if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Mandant-ID' })
      const konfig = await ladeStripeKonfig(opts.deps.db, p.data.mandantId, opts.deps.config)
      return verarbeiteWebhook(request, reply, konfig, opts.deps)
    })

    // Globaler Fallback (ein Env-Konto für alle) — verifiziert mit den Env-Keys.
    stripe.post('/api/stripe/webhook', async (request, reply) => {
      return verarbeiteWebhook(request, reply, globaleStripeKonfig(opts.deps.config), opts.deps)
    })
  })
}
