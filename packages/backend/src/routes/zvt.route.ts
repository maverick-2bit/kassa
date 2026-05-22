/**
 * ZVT-Kartenterminal-Routen.
 *
 *   GET   /api/kassen/:id/zvt          ZVT-Konfiguration lesen
 *   PATCH /api/kassen/:id/zvt          ZVT-Konfiguration ändern
 *   POST  /api/zvt/zahlung             Zahlung starten → { jobId }
 *   GET   /api/zvt/zahlung/:jobId      Job-Status pollen
 *   POST  /api/zvt/zahlung/:jobId/abbrechen   Sofortiger Abbruch (kein Timeout abwarten)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { ZvtConfigUpdateSchema, ZvtZahlungInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen } from '../db/schema.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import {
  abbrechen,
  getJob,
  starteZahlung,
  ZvtError,
  type ZvtServiceDeps,
} from '../services/zvt/zvt.service.js'

export interface ZvtRouteOptions { deps: ZvtServiceDeps }

const IdParamSchema    = z.object({ id:    z.string().uuid() })
const JobIdParamSchema = z.object({ jobId: z.string().uuid() })

export const zvtRoute: FastifyPluginAsync<ZvtRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  // -------------------------------------------------------------------------
  // Konfiguration
  // -------------------------------------------------------------------------

  fastify.get('/kassen/:id/zvt', auth, async (request, reply) => {
    const p = IdParamSchema.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.deps.db, p.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }
    const [kasse] = await opts.deps.db.select().from(kassen).where(eq(kassen.id, p.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send({
      zvtIp:       kasse.zvtIp,
      zvtPort:     kasse.zvtPort,
      zvtPasswort: kasse.zvtPasswort,
      zvtAktiv:    kasse.zvtAktiv,
    })
  })

  fastify.patch('/kassen/:id/zvt', auth, async (request, reply) => {
    const p = IdParamSchema.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.deps.db, p.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }
    const body = ZvtConfigUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const update: Partial<typeof kassen.$inferInsert> = { updatedAt: new Date() }
    if (body.data.zvtIp       !== undefined) update.zvtIp       = body.data.zvtIp
    if (body.data.zvtPort     !== undefined) update.zvtPort     = body.data.zvtPort
    if (body.data.zvtPasswort !== undefined) update.zvtPasswort = body.data.zvtPasswort
    if (body.data.zvtAktiv    !== undefined) update.zvtAktiv    = body.data.zvtAktiv

    const [updated] = await opts.deps.db.update(kassen).set(update).where(eq(kassen.id, p.data.id)).returning()
    if (!updated) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send({
      zvtIp:       updated.zvtIp,
      zvtPort:     updated.zvtPort,
      zvtPasswort: updated.zvtPasswort,
      zvtAktiv:    updated.zvtAktiv,
    })
  })

  // -------------------------------------------------------------------------
  // Zahlung
  // -------------------------------------------------------------------------

  fastify.post('/zvt/zahlung', auth, async (request, reply) => {
    const parsed = ZvtZahlungInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const result = await starteZahlung(parsed.data, request.user.mandantId, opts.deps)
      return reply.send(result)
    } catch (err) {
      if (err instanceof ZvtError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/zvt/zahlung/:jobId', auth, async (request, reply) => {
    const p = JobIdParamSchema.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const job = getJob(p.data.jobId)
    if (!job) return reply.status(404).send({ fehler: 'Job nicht gefunden' })
    return reply.send(job)
  })

  fastify.post('/zvt/zahlung/:jobId/abbrechen', auth, async (request, reply) => {
    const p = JobIdParamSchema.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const job = abbrechen(p.data.jobId)
    if (!job) return reply.status(404).send({ fehler: 'Job nicht gefunden' })
    return reply.send(job)
  })
}
