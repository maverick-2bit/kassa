import type { FastifyPluginAsync } from 'fastify'
import {
  OffenerPostenInputSchema,
  OffenerPostenZahlungSchema,
  type OffenerPostenStatus,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeOffenePosten,
  holeOffenerPosten,
  erstelleOffenerPosten,
  erfasseZahlung,
  offenePostenStatistik,
  OffenerPostenError,
} from '../services/offenerPosten.service.js'

export interface OffenerPostenRouteOptions { db: Db }

export const offenerPostenRoute: FastifyPluginAsync<OffenerPostenRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/offene-posten', auth, async (request, reply) => {
    const q        = request.query as Record<string, string>
    const kundeId  = q['kundeId']  as string | undefined
    const status   = q['status']   as OffenerPostenStatus | undefined
    const liste    = await listeOffenePosten(opts.db, request.user.mandantId, {
      ...(kundeId ? { kundeId } : {}),
      ...(status  ? { status  } : {}),
      limit: q['limit'] ? parseInt(q['limit'], 10) : 500,
    })
    return reply.send(liste)
  })

  fastify.get('/offene-posten/statistik', auth, async (request, reply) => {
    const stats = await offenePostenStatistik(opts.db, request.user.mandantId)
    return reply.send(stats)
  })

  fastify.get('/offene-posten/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeOffenerPosten(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof OffenerPostenError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/offene-posten', auth, async (request, reply) => {
    const parsed = OffenerPostenInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const op = await erstelleOffenerPosten(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(op)
    } catch (err) {
      if (err instanceof OffenerPostenError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/offene-posten/:id/zahlung', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = OffenerPostenZahlungSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await erfasseZahlung(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) {
      if (err instanceof OffenerPostenError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
