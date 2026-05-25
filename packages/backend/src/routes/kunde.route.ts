import type { FastifyPluginAsync } from 'fastify'
import { KundeInputSchema, KundeUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeKunden,
  holeKunde,
  erstelleKunde,
  aktualisiereKunde,
  listeBelegeVonKunde,
  KundeError,
} from '../services/kunde.service.js'

export interface KundeRouteOptions { db: Db }

export const kundeRoute: FastifyPluginAsync<KundeRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/kunden', auth, async (request, reply) => {
    const q = request.query as Record<string, string>
    const suche = q['suche']
    const rows = await listeKunden(opts.db, request.user.mandantId, {
      ...(suche !== undefined && { suche }),
      nurAktive: q['nurAktive'] !== 'false',
      limit:     q['limit'] ? parseInt(q['limit'], 10) : 50,
    })
    return reply.send(rows)
  })

  fastify.get('/kunden/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeKunde(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof KundeError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/kunden', auth, async (request, reply) => {
    const parsed = KundeInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const kunde = await erstelleKunde(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(kunde)
    } catch (err) {
      if (err instanceof KundeError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.put('/kunden/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = KundeUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await aktualisiereKunde(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) {
      if (err instanceof KundeError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/kunden/:id/belege', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const liste = await listeBelegeVonKunde(opts.db, id, request.user.mandantId)
    return reply.send(liste)
  })

  fastify.delete('/kunden/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await aktualisiereKunde(opts.db, id, request.user.mandantId, { aktiv: false }))
    } catch (err) {
      if (err instanceof KundeError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
