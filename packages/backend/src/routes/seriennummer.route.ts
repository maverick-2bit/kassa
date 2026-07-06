/**
 * Seriennummer-Routen (auth, mandantId aus JWT).
 *   GET    /api/seriennummern?artikelId=&status=   Auflisten (Pool)
 *   POST   /api/seriennummern                      Erfassen (Wareneingang)
 *   DELETE /api/seriennummern/:id                  Verfügbare Seriennummer löschen
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { SeriennummernErfassenInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeSeriennummern,
  erfasseSeriennummern,
  loescheSeriennummer,
  SeriennummerError,
} from '../services/seriennummer.service.js'

export interface SeriennummerRouteOptions {
  db: Db
}

const ListQuerySchema = z.object({
  artikelId: z.string().uuid().optional(),
  status:    z.enum(['verfuegbar', 'verkauft']).optional(),
})

const IdParamSchema = z.object({ id: z.string().uuid() })

export const seriennummerRoute: FastifyPluginAsync<SeriennummerRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/seriennummern', auth, async (request, reply) => {
    const q = ListQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })
    const list = await listeSeriennummern(opts.db, request.user.mandantId, {
      ...(q.data.artikelId && { artikelId: q.data.artikelId }),
      ...(q.data.status    && { status:    q.data.status }),
    })
    return reply.send(list)
  })

  fastify.post('/seriennummern', auth, async (request, reply) => {
    const parsed = SeriennummernErfassenInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const list = await erfasseSeriennummern(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(list)
    } catch (err) {
      if (err instanceof SeriennummerError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.delete('/seriennummern/:id', auth, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await loescheSeriennummer(opts.db, request.user.mandantId, id.data.id)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof SeriennummerError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
