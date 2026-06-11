/**
 * Dienstplan-Routen
 *
 *  GET    /api/dienstplan?kasseId=&datumVon=&datumBis=&userId=
 *  POST   /api/dienstplan
 *  PATCH  /api/dienstplan/:id
 *  DELETE /api/dienstplan/:id
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { DienstplanSchichtInputSchema, DienstplanSchichtUpdateSchema } from '@kassa/shared'
import {
  listeSchichten,
  erstelleSchicht,
  aktualisiereSchicht,
  loescheSchicht,
} from '../services/dienstplan.service.js'

export interface DienstplanRouteOptions { db: Db }

const ListQuerySchema = z.object({
  kasseId:  z.string().uuid().optional(),
  userId:   z.string().uuid().optional(),
  datumVon: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  datumBis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit:    z.coerce.number().int().min(1).max(1000).optional(),
})

const IdParam = z.object({ id: z.string().uuid() })

export const dienstplanRoute: FastifyPluginAsync<DienstplanRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/dienstplan', guard, async (request, reply) => {
    const q = ListQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

    const liste = await listeSchichten(opts.db, request.user.mandantId, {
      ...(q.data.kasseId  !== undefined && { kasseId:  q.data.kasseId  }),
      ...(q.data.userId   !== undefined && { userId:   q.data.userId   }),
      ...(q.data.datumVon !== undefined && { datumVon: q.data.datumVon }),
      ...(q.data.datumBis !== undefined && { datumBis: q.data.datumBis }),
      ...(q.data.limit    !== undefined && { limit:    q.data.limit    }),
    })
    return reply.send(liste)
  })

  fastify.post('/dienstplan', guard, async (request, reply) => {
    const body = DienstplanSchichtInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const schicht = await erstelleSchicht(opts.db, request.user.mandantId, body.data)
      return reply.status(201).send(schicht)
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  fastify.patch('/dienstplan/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = DienstplanSchichtUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const schicht = await aktualisiereSchicht(opts.db, p.data.id, request.user.mandantId, body.data)
      return reply.send(schicht)
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  fastify.delete('/dienstplan/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    try {
      await loescheSchicht(opts.db, p.data.id, request.user.mandantId)
      return reply.status(204).send()
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })
}
