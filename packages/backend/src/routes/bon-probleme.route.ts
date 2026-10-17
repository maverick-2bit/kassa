/**
 * Bon-Probleme-Routen
 *   GET  /api/kassen/:id/bon-probleme       Offene Meldungen zu Bons, die der Server selbst ausgelöst hat
 *   POST /api/bon-probleme/:id/nochmal      Nochmal senden (dieselbe Bestell-ID → nichts doppelt)
 *   POST /api/bon-probleme/:id/verstanden   Meldung bestätigen
 *
 * Gelesen und geschrieben wird immer mit dem Mandanten des angemeldeten Benutzers: eine fremde Kasse bzw.
 * Meldung antwortet 404, nie mit fremden Daten (siehe bon-probleme.service).
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import { BonierError } from '../services/bonier.service.js'
import {
  BonProblemError,
  bestaetigeBonProblem,
  holeOffeneBonProbleme,
  sendeBonProblemNochmal,
} from '../services/bon-probleme.service.js'

export interface BonProblemeRouteOptions { db: Db }

const IdParamSchema = z.object({ id: z.string().uuid() })

export const bonProblemeRoute: FastifyPluginAsync<BonProblemeRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/kassen/:id/bon-probleme', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    return reply.send(await holeOffeneBonProbleme(opts.db, request.user.mandantId, params.data.id))
  })

  fastify.post('/bon-probleme/:id/nochmal', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      const problem = await sendeBonProblemNochmal(opts.db, params.data.id, request.user.mandantId)
      return reply.send({ problem })
    } catch (err) {
      if (err instanceof BonProblemError || err instanceof BonierError)
        return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/bon-probleme/:id/verstanden', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await bestaetigeBonProblem(opts.db, params.data.id, request.user.mandantId)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof BonProblemError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
