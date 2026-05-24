import type { FastifyPluginAsync } from 'fastify'
import { LagerstandBulkInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { bulkLagerstandAktualisieren } from '../services/lagerstand.service.js'

export interface LagerstandRouteOptions {
  db: Db
}

export const lagerstandRoute: FastifyPluginAsync<LagerstandRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  /**
   * POST /lagerstand/bulk
   * Bulk-Aktualisierung für Wareneingang (addieren) oder Inventur (absolut setzen).
   */
  fastify.post('/lagerstand/bulk', auth, async (request, reply) => {
    const parsed = LagerstandBulkInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    await bulkLagerstandAktualisieren(parsed.data, request.user.mandantId, db)
    return reply.status(204).send()
  })
}
