/**
 * Stripe-Webhook — bestätigt Gast-Zahlungen serverseitig (KEIN JWT).
 *
 *   POST /api/stripe/webhook
 *
 * Eigenes encapsuliertes Plugin mit Raw-Body-Parser: nur hier wird
 * application/json als Buffer geliefert (für die Signaturprüfung); der Rest der
 * App behält den normalen JSON-Parser. Bei `checkout.session.completed` wird die
 * Gast-Bestellung idempotent finalisiert (RKSV-Beleg + Bonierung).
 */

import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import type { BelegServiceDeps } from '../services/beleg.service.js'
import { verifiziereWebhook, isStripeAktiv } from '../services/stripe.service.js'
import { finalisiereGastBestellung, type GastServiceDeps } from '../services/gast-bestellung.service.js'

export interface StripeWebhookDeps { db: Db; belegDeps: BelegServiceDeps; config: Config }

export async function registerStripeWebhook(
  fastify: FastifyInstance,
  opts:    { deps: StripeWebhookDeps },
): Promise<void> {
  await fastify.register(async (stripe) => {
    // Raw-Body NUR in diesem Plugin — der Rest der App behält den JSON-Parser.
    stripe.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

    stripe.post('/api/stripe/webhook', async (request, reply) => {
      if (!isStripeAktiv(opts.deps.config)) return reply.status(503).send({ fehler: 'Stripe nicht konfiguriert' })

      const sig = request.headers['stripe-signature']
      if (typeof sig !== 'string') return reply.status(400).send({ fehler: 'Signatur fehlt' })

      let event
      try {
        event = verifiziereWebhook(request.body as Buffer, sig, opts.deps.config)
      } catch (err) {
        request.log.warn({ err }, 'Stripe-Webhook-Signatur ungültig')
        return reply.status(400).send({ fehler: 'Signatur ungültig' })
      }

      if (event.type === 'checkout.session.completed') {
        const bestellungId = (event.data.object as { metadata?: { bestellungId?: string } }).metadata?.bestellungId
        if (bestellungId) {
          const gastDeps: GastServiceDeps = { db: opts.deps.db, belegDeps: opts.deps.belegDeps, config: opts.deps.config }
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
    })
  })
}
