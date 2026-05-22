/**
 * Berichts-Routen — alle auth-protected, mandant-scoped.
 */

import type { FastifyPluginAsync } from 'fastify'
import { BerichtFilterSchema } from '@kassa/shared'
import {
  holeUmsatzbericht,
  BerichtError,
  type BerichtServiceDeps,
} from '../services/bericht.service.js'

export interface BerichtRouteOptions {
  deps: BerichtServiceDeps
}

export const berichtRoute: FastifyPluginAsync<BerichtRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/berichte/umsatz', guard, async (request, reply) => {
    // Query-Parameter nach BerichtFilter parsen
    const raw = request.query as Record<string, unknown>

    // kasseIds kann als kasseIds[]=... oder kasseIds=... kommen
    const kasseIdsRaw = raw['kasseIds']
    const kasseIds = Array.isArray(kasseIdsRaw)
      ? kasseIdsRaw
      : kasseIdsRaw ? [kasseIdsRaw] : []

    const parsed = BerichtFilterSchema.safeParse({
      kasseIds,
      von:               raw['von'],
      bis:               raw['bis'],
      nurZielrechnungen: raw['nurZielrechnungen'] === 'true',
      gruppierung:       raw['gruppierung'],
    })
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }

    try {
      const bericht = await holeUmsatzbericht(
        parsed.data,
        request.user.mandantId,
        opts.deps,
      )
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Umsatzbericht unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
