/**
 * Beleg-Routen
 *   POST /api/belege/barzahlung    Barzahlungsbeleg erstellen
 *   GET  /api/belege?kasseId=…     Belege auflisten
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { BarzahlungsbelegInputSchema } from '@kassa/shared'
import {
  erstelleBarzahlungsbeleg,
  listeBelege,
  BelegError,
  type BelegServiceDeps,
} from '../services/beleg.service.js'

export interface BelegRouteOptions {
  deps: BelegServiceDeps
}

const ListQuerySchema = z.object({
  kasseId: z.string().uuid(),
  limit:   z.coerce.number().int().min(1).max(500).optional(),
})

export const belegRoute: FastifyPluginAsync<BelegRouteOptions> = async (fastify, opts) => {
  fastify.post('/belege/barzahlung', async (request, reply) => {
    const parsed = BarzahlungsbelegInputSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }

    try {
      const beleg = await erstelleBarzahlungsbeleg(parsed.data, opts.deps)
      return reply.status(201).send(beleg)
    } catch (err) {
      if (err instanceof BelegError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Beleg-Erstellung unerwartet fehlgeschlagen')
      const meldung = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ fehler: meldung })
    }
  })

  fastify.get('/belege', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }
    const liste = await listeBelege(opts.deps.db, parsed.data.kasseId, {
      ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    })
    return reply.send(liste)
  })
}
