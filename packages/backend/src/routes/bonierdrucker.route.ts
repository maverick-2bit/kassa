/**
 * Bonierdrucker-Routen (auth-protected, mandantenweit).
 *   GET    /api/bonierdrucker              Liste
 *   POST   /api/bonierdrucker              Anlegen
 *   PATCH  /api/bonierdrucker/:id          Aktualisieren
 *   DELETE /api/bonierdrucker/:id          Löschen
 *   POST   /api/bonierdrucker/:id/test     Testdruck
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { BonierdruckerInputSchema, BonierdruckerUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeBonierdrucker,
  erstelleBonierdrucker,
  aktualisiereBonierdrucker,
  loescheBonierdrucker,
  testdruckBonierdrucker,
} from '../services/bonierdrucker.service.js'
import { aktualisiereStatus, getDruckerStatus } from '../services/drucker.service.js'
import { bonierdrucker } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'

export interface BonierdruckerRouteOptions { db: Db }

const IdParam = z.object({ id: z.string().uuid() })

export const bonierdruckerRoute: FastifyPluginAsync<BonierdruckerRouteOptions> = async (fastify, opts) => {

  fastify.get('/bonierdrucker', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const list = await listeBonierdrucker(opts.db, request.user.mandantId)
    return reply.send(list)
  })

  fastify.post('/bonierdrucker', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = BonierdruckerInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const result = await erstelleBonierdrucker(opts.db, request.user.mandantId, parsed.data)
    return reply.status(201).send(result)
  })

  fastify.patch('/bonierdrucker/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const update = BonierdruckerUpdateSchema.safeParse(request.body)
    if (!update.success) return reply.status(400).send({ fehler: update.error.issues })

    const result = await aktualisiereBonierdrucker(opts.db, id.data.id, request.user.mandantId, update.data)
    if (!result) return reply.status(404).send({ fehler: 'Bonierdrucker nicht gefunden' })
    return reply.send(result)
  })

  fastify.delete('/bonierdrucker/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const ok = await loescheBonierdrucker(opts.db, id.data.id, request.user.mandantId)
    if (!ok) return reply.status(404).send({ fehler: 'Bonierdrucker nicht gefunden' })
    return reply.status(204).send()
  })

  fastify.post('/bonierdrucker/:id/test', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [row] = await opts.db
      .select({ ip: bonierdrucker.ip, port: bonierdrucker.port })
      .from(bonierdrucker)
      .where(and(eq(bonierdrucker.id, id.data.id), eq(bonierdrucker.mandantId, request.user.mandantId)))
      .limit(1)

    if (!row) return reply.status(404).send({ fehler: 'Bonierdrucker nicht gefunden' })

    try {
      await testdruckBonierdrucker(row.ip, row.port)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      return reply.send({ erfolgreich: false, fehler: err instanceof Error ? err.message : 'Verbindungsfehler' })
    }
  })

  // Online-Status (TCP-Erreichbarkeit), 30s-Cache
  fastify.get('/bonierdrucker/:id/status', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [row] = await opts.db
      .select({ ip: bonierdrucker.ip, port: bonierdrucker.port })
      .from(bonierdrucker)
      .where(and(eq(bonierdrucker.id, id.data.id), eq(bonierdrucker.mandantId, request.user.mandantId)))
      .limit(1)
    if (!row) return reply.status(404).send({ fehler: 'Bonierdrucker nicht gefunden' })

    const cached = getDruckerStatus(row.ip, row.port)
    if (cached && Date.now() - cached.geprüftAm.getTime() < 30_000) {
      return reply.send({ online: cached.online, geprüftAm: cached.geprüftAm })
    }
    const online = await aktualisiereStatus(row.ip, row.port)
    return reply.send({ online, geprüftAm: new Date() })
  })
}
