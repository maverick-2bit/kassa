import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  erstelleDbSicherung,
  listeDbSicherungen,
  ladeDbSicherungDatei,
  bereinigeSicherungen,
} from '../services/db-backup.service.js'

export interface DbBackupRouteOptions {
  db:          Db
  databaseUrl: string
  backupDir:   string
  retention:   number
}

const IdParamSchema = z.object({ id: z.string().uuid() })

export const dbBackupRoute: FastifyPluginAsync<DbBackupRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  function nurAdmin(request: Parameters<typeof fastify.authenticate>[0], reply: Parameters<typeof fastify.authenticate>[1], done: () => void) {
    if (request.user.rolle !== 'admin') {
      reply.status(403).send({ fehler: 'Nur Admins können DB-Backups verwalten' })
      return
    }
    done()
  }

  const adminGuard = { onRequest: [fastify.authenticate, nurAdmin] }

  fastify.get('/db-sicherungen', adminGuard, async (_request, reply) => {
    const liste = await listeDbSicherungen(opts.db)
    return reply.send(liste)
  })

  fastify.post('/db-sicherungen', adminGuard, async (_request, reply) => {
    try {
      const s = await erstelleDbSicherung(opts.db, opts.databaseUrl, opts.backupDir, false)
      await bereinigeSicherungen(opts.db, opts.retention)
      return reply.status(201).send(s)
    } catch (err) {
      fastify.log.error({ err }, 'Manueller DB-Backup fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/db-sicherungen/:id/download', adminGuard, async (request, reply) => {
    const parsed = IdParamSchema.safeParse(request.params)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const result = await ladeDbSicherungDatei(opts.db, parsed.data.id)
    if (!result) return reply.status(404).send({ fehler: 'Sicherung oder Datei nicht gefunden' })

    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${result.dateiname}"`)
      .send(result.buffer)
  })
}
