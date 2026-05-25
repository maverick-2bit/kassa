import type { FastifyPluginAsync } from 'fastify'
import { GutscheinInputSchema, GutscheinEinloesenSchema, type GutscheinStatus } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeGutscheine,
  listeGutscheinBuchungen,
  holeGutscheinById,
  holeGutscheinByCode,
  erstelleGutschein,
  loesGutscheinEin,
  storniereGutschein,
  GutscheinError,
} from '../services/gutschein.service.js'

export interface GutscheinRouteOptions { db: Db }

export const gutscheinRoute: FastifyPluginAsync<GutscheinRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/gutscheine', auth, async (request, reply) => {
    const q       = request.query as Record<string, string>
    const status  = q['status']  as GutscheinStatus | undefined
    const kundeId = q['kundeId'] as string | undefined
    return reply.send(await listeGutscheine(opts.db, request.user.mandantId, {
      ...(status  ? { status  } : {}),
      ...(kundeId ? { kundeId } : {}),
      limit: q['limit'] ? parseInt(q['limit'], 10) : 500,
    }))
  })

  /** Lookup per Code — für die Kasse */
  fastify.get('/gutscheine/code/:code', auth, async (request, reply) => {
    const { code } = request.params as { code: string }
    try {
      return reply.send(await holeGutscheinByCode(opts.db, code, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  /** Transaktionshistorie eines Gutscheins */
  fastify.get('/gutscheine/:id/buchungen', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await listeGutscheinBuchungen(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/gutscheine/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeGutscheinById(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/gutscheine', auth, async (request, reply) => {
    const parsed = GutscheinInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const gs = await erstelleGutschein(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(gs)
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  /** Einlösen — gibt { gutschein, restGutschein? } zurück */
  fastify.post('/gutscheine/:id/einloesen', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = GutscheinEinloesenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await loesGutscheinEin(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/gutscheine/:id/stornieren', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await storniereGutschein(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
