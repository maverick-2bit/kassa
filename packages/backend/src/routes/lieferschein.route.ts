import type { FastifyPluginAsync } from 'fastify'
import {
  LiferscheinInputSchema,
  LiferscheinUpdateSchema,
  SammelrechnungInputSchema,
  type LiferscheinStatus,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeLiferscheine,
  holeLiferschein,
  erstelleLiferschein,
  aktualisiereLiferschein,
  erstelleSammelrechnung,
  LiferscheinError,
} from '../services/lieferschein.service.js'

export interface LiferscheinRouteOptions { db: Db }

export const lieferscheinRoute: FastifyPluginAsync<LiferscheinRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  // ---------------------------------------------------------------------------
  // Lieferscheine
  // ---------------------------------------------------------------------------

  fastify.get('/lieferscheine', auth, async (request, reply) => {
    const q         = request.query as Record<string, string>
    const kundeId   = q['kundeId']   as string | undefined
    const angebotId = q['angebotId'] as string | undefined
    const status    = q['status']    as LiferscheinStatus | undefined
    const liste     = await listeLiferscheine(opts.db, request.user.mandantId, {
      ...(kundeId   ? { kundeId }   : {}),
      ...(angebotId ? { angebotId } : {}),
      ...(status    ? { status }    : {}),
      limit: q['limit'] ? parseInt(q['limit'], 10) : 200,
    })
    return reply.send(liste)
  })

  fastify.get('/lieferscheine/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeLiferschein(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/lieferscheine', auth, async (request, reply) => {
    const parsed = LiferscheinInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const ls = await erstelleLiferschein(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(ls)
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/lieferscheine/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = LiferscheinUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await aktualisiereLiferschein(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ---------------------------------------------------------------------------
  // Sammelrechnung
  // ---------------------------------------------------------------------------

  fastify.post('/sammelrechnungen', auth, async (request, reply) => {
    const parsed = SammelrechnungInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const sr = await erstelleSammelrechnung(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(sr)
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
