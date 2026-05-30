import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  erstelleDepSicherung,
  ladeSicherungDatei,
  listeSicherungen,
} from '../services/dep-sicherung.service.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

export interface DepSicherungRouteOptions {
  db:        Db
  backupDir: string
}

const QuerySchema   = z.object({ kasseId: z.string().uuid() })
const BodySchema    = z.object({ kasseId: z.string().uuid() })
const IdParamSchema = z.object({ id: z.string().uuid() })

export const depSicherungRoute: FastifyPluginAsync<DepSicherungRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/dep-sicherungen', guard, async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const liste = await listeSicherungen(opts.db, parsed.data.kasseId, request.user.mandantId)
    return reply.send(liste)
  })

  fastify.post('/dep-sicherungen', guard, async (request, reply) => {
    const parsed = BodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    try {
      const sicherung = await erstelleDepSicherung(
        opts.db, parsed.data.kasseId, request.user.mandantId, opts.backupDir, false,
      )
      return reply.status(201).send(sicherung)
    } catch (err) {
      fastify.log.error({ err }, 'Manuelle DEP-Sicherung fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/dep-sicherungen/:id/download', guard, async (request, reply) => {
    const parsed = IdParamSchema.safeParse(request.params)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const result = await ladeSicherungDatei(opts.db, parsed.data.id, request.user.mandantId)
    if (!result) return reply.status(404).send({ fehler: 'Sicherung oder Datei nicht gefunden' })

    return reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${result.dateiname}"`)
      .send(result.buffer)
  })
}
