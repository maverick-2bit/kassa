/**
 * Bondrucker-Bibliothek (mandantenweiter Pool).
 *   GET    /api/drucker              Liste
 *   POST   /api/drucker              Anlegen
 *   PATCH  /api/drucker/:id          Aktualisieren (+ Snapshot der Kassen auffrischen)
 *   DELETE /api/drucker/:id          Löschen (+ betroffene Kassen ablösen)
 *   POST   /api/drucker/:id/test     Testdruck
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { DruckerPoolInputSchema, DruckerPoolUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listeDrucker,
  erstelleDrucker,
  aktualisiereDrucker,
  loescheDrucker,
  testdruckDrucker,
} from '../services/drucker-pool.service.js'
import { aktualisiereStatus, getDruckerStatus } from '../services/drucker.service.js'
import { drucker } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'

export interface DruckerPoolRouteOptions { db: Db }

const IdParam = z.object({ id: z.string().uuid() })

export const druckerPoolRoute: FastifyPluginAsync<DruckerPoolRouteOptions> = async (fastify, opts) => {

  fastify.get('/drucker', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const list = await listeDrucker(opts.db, request.user.mandantId)
    return reply.send(list)
  })

  fastify.post('/drucker', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = DruckerPoolInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const result = await erstelleDrucker(opts.db, request.user.mandantId, parsed.data)
    return reply.status(201).send(result)
  })

  fastify.patch('/drucker/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const update = DruckerPoolUpdateSchema.safeParse(request.body)
    if (!update.success) return reply.status(400).send({ fehler: update.error.issues })

    const result = await aktualisiereDrucker(opts.db, id.data.id, request.user.mandantId, update.data)
    if (!result) return reply.status(404).send({ fehler: 'Drucker nicht gefunden' })
    return reply.send(result)
  })

  fastify.delete('/drucker/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const ok = await loescheDrucker(opts.db, id.data.id, request.user.mandantId)
    if (!ok) return reply.status(404).send({ fehler: 'Drucker nicht gefunden' })
    return reply.status(204).send()
  })

  fastify.post('/drucker/:id/test', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [row] = await opts.db
      .select({ ip: drucker.ip, port: drucker.port, timeoutSek: drucker.timeoutSek })
      .from(drucker)
      .where(and(eq(drucker.id, id.data.id), eq(drucker.mandantId, request.user.mandantId)))
      .limit(1)

    if (!row) return reply.status(404).send({ fehler: 'Drucker nicht gefunden' })

    try {
      await testdruckDrucker(row.ip, row.port, row.timeoutSek)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      return reply.send({ erfolgreich: false, fehler: err instanceof Error ? err.message : 'Verbindungsfehler' })
    }
  })

  // Online-Status (TCP-Erreichbarkeit), 30s-Cache
  fastify.get('/drucker/:id/status', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParam.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [row] = await opts.db
      .select({ ip: drucker.ip, port: drucker.port })
      .from(drucker)
      .where(and(eq(drucker.id, id.data.id), eq(drucker.mandantId, request.user.mandantId)))
      .limit(1)
    if (!row) return reply.status(404).send({ fehler: 'Drucker nicht gefunden' })

    const cached = getDruckerStatus(row.ip, row.port)
    if (cached && Date.now() - cached.geprüftAm.getTime() < 30_000) {
      return reply.send({ online: cached.online, geprüftAm: cached.geprüftAm })
    }
    const online = await aktualisiereStatus(row.ip, row.port)
    return reply.send({ online, geprüftAm: new Date() })
  })
}
