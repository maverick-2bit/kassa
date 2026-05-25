import type { FastifyPluginAsync } from 'fastify'
import { AngebotInputSchema, AngebotUpdateSchema, type AngebotStatus } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeAngebote,
  holeAngebot,
  erstelleAngebot,
  aktualisiereAngebot,
  AngebotError,
} from '../services/angebot.service.js'

export interface AngebotRouteOptions { db: Db }

export const angebotRoute: FastifyPluginAsync<AngebotRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/angebote', auth, async (request, reply) => {
    const q      = request.query as Record<string, string>
    const status = q['status'] as AngebotStatus | undefined
    const liste  = await listeAngebote(opts.db, request.user.mandantId, {
      ...(status ? { status } : {}),
      limit: q['limit'] ? parseInt(q['limit'], 10) : 100,
    })
    return reply.send(liste)
  })

  fastify.get('/angebote/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeAngebot(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof AngebotError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/angebote', auth, async (request, reply) => {
    const parsed = AngebotInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const angebot = await erstelleAngebot(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(angebot)
    } catch (err) {
      if (err instanceof AngebotError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/angebote/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = AngebotUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await aktualisiereAngebot(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) {
      if (err instanceof AngebotError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
