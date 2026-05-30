import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { LieferantInputSchema, LieferantUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeLieferanten,
  erstelleLieferant,
  aktualisiereLieferant,
  deaktiviereLieferant,
} from '../services/lieferant.service.js'

export interface LieferantRouteOptions { db: Db }

const IdParam = z.object({ id: z.string().uuid() })

export const lieferantRoute: FastifyPluginAsync<LieferantRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/lieferanten', guard, async (request, reply) => {
    const liste = await listeLieferanten(opts.db, request.user.mandantId)
    return reply.send(liste)
  })

  fastify.post('/lieferanten', guard, async (request, reply) => {
    const parsed = LieferantInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const result = await erstelleLieferant(opts.db, request.user.mandantId, parsed.data)
    return reply.status(201).send(result)
  })

  fastify.put('/lieferanten/:id', guard, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const parsed = LieferantUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const result = await aktualisiereLieferant(opts.db, id.data.id, request.user.mandantId, parsed.data)
    if (!result) return reply.status(404).send({ fehler: 'Lieferant nicht gefunden' })
    return reply.send(result)
  })

  fastify.delete('/lieferanten/:id', guard, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const ok = await deaktiviereLieferant(opts.db, id.data.id, request.user.mandantId)
    if (!ok) return reply.status(404).send({ fehler: 'Lieferant nicht gefunden' })
    return reply.status(204).send()
  })
}
