import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  erstelleDbSicherung,
  listeDbSicherungen,
  ladeDbSicherungDatei,
  bereinigeSicherungen,
  DbSicherungError,
} from '../services/db-backup.service.js'
import { requireBetreiber } from '../auth/betreiber.js'

export interface DbBackupRouteOptions {
  db:          Db
  databaseUrl: string
  backupDir:   string
  retention:   number
}

const IdParamSchema = z.object({ id: z.string().guid() })

export const dbBackupRoute: FastifyPluginAsync<DbBackupRouteOptions> = async (fastify, opts) => {
  // NUR der Betreiber: pg_dump sichert die GANZE Datenbank (alle Mandanten samt Benutzern, Belegen,
  // verschlüsselten Signaturschlüsseln), und Liste/Download kennen keinen Mandanten. Ein Mandanten-Admin
  // konnte damit die Daten aller anderen Betriebe auf dem Rechner herunterladen. Der Export des
  // EIGENEN Mandanten (mandant-uebergabe) und die DEP-Sicherung je Kasse bleiben Mandanten-Admins.
  const adminGuard = { onRequest: [fastify.authenticate, requireBetreiber(opts.db)] }

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
      // pg_dump-Meldung (steht auch am Sicherungs-Eintrag) — alles andere ohne Interna
      if (!(err instanceof DbSicherungError)) throw err
      fastify.log.error({ err }, 'Manueller DB-Backup fehlgeschlagen')
      return reply.status(err.httpStatus).send({ fehler: err.message })
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
