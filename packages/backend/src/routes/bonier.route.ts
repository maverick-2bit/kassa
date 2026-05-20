/**
 * Bonier-Routen
 *   POST /api/bestellung/bonieren    Bonierung an KDS-Stationen senden
 */

import type { FastifyPluginAsync } from 'fastify'
import { BonierungInputSchema } from '@kassa/shared'
import {
  bonierBestellung,
  BonierError,
  type BonierServiceDeps,
} from '../services/bonier.service.js'

export interface BonierRouteOptions {
  deps: BonierServiceDeps
}

export const bonierRoute: FastifyPluginAsync<BonierRouteOptions> = async (fastify, opts) => {
  fastify.post('/bestellung/bonieren', async (request, reply) => {
    const parsed = BonierungInputSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }

    try {
      const ergebnis = await bonierBestellung(parsed.data, opts.deps)
      // 207 Multi-Status, wenn manche Stationen fehlgeschlagen sind
      const erfolg = ergebnis.stationen.every((s) => s.erfolgreich)
      return reply.status(erfolg ? 200 : 207).send(ergebnis)
    } catch (err) {
      if (err instanceof BonierError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Bonierung fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
