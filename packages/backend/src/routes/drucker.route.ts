/**
 * Drucker-Routen
 *   GET   /api/kassen/:id/drucker      Aktuelle Drucker-Konfiguration
 *   PATCH /api/kassen/:id/drucker      Drucker-Konfiguration ändern
 *   POST  /api/belege/:id/drucken      Bon manuell drucken
 *   POST  /api/kassen/:id/drucker/test Testdruck (Mini-Bon zum Prüfen der Verbindung)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { Buffer } from 'node:buffer'
import { StationSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen } from '../db/schema.js'
import { pruefeBelegGehoertZuMandant, pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import {
  druckeBeleg,
  sendBytes,
  druckerConfigVonKasse,
  DruckerError,
} from '../services/drucker.service.js'
import * as ep from '../services/escpos/commands.js'

export interface DruckerRouteOptions {
  db: Db
}

const IdParamSchema = z.object({ id: z.string().uuid() })

const DruckerConfigInputSchema = z.object({
  druckerIp:     z.string().trim().min(1).max(64).nullable(),
  druckerPort:   z.number().int().min(1).max(65535).optional(),
  druckerAktiv:  z.boolean().optional(),
  druckerBreite: z.number().int().min(20).max(80).optional(),
})

export const druckerRoute: FastifyPluginAsync<DruckerRouteOptions> = async (fastify, opts) => {
  // GET /kassen/:id/drucker
  fastify.get('/kassen/:id/drucker', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, params.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    return reply.send({
      druckerIp:     kasse.druckerIp,
      druckerPort:   kasse.druckerPort,
      druckerAktiv:  kasse.druckerAktiv,
      druckerBreite: kasse.druckerBreite,
    })
  })

  // PATCH /kassen/:id/drucker
  fastify.patch('/kassen/:id/drucker', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const body = DruckerConfigInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const update: Partial<typeof kassen.$inferInsert> = { updatedAt: new Date() }
    if (body.data.druckerIp     !== undefined) update.druckerIp     = body.data.druckerIp
    if (body.data.druckerPort   !== undefined) update.druckerPort   = body.data.druckerPort
    if (body.data.druckerAktiv  !== undefined) update.druckerAktiv  = body.data.druckerAktiv
    if (body.data.druckerBreite !== undefined) update.druckerBreite = body.data.druckerBreite

    const [updated] = await opts.db.update(kassen).set(update).where(eq(kassen.id, params.data.id)).returning()
    if (!updated) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    return reply.send({
      druckerIp:     updated.druckerIp,
      druckerPort:   updated.druckerPort,
      druckerAktiv:  updated.druckerAktiv,
      druckerBreite: updated.druckerBreite,
    })
  })

  // POST /belege/:id/drucken (Reprint)
  fastify.post('/belege/:id/drucken', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeBelegGehoertZuMandant(opts.db, params.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Beleg nicht gefunden' })
    }

    try {
      await druckeBeleg(opts.db, params.data.id)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof DruckerError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Reprint fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  // GET /kassen/:id/kds — KDS-Konfiguration auslesen
  fastify.get('/kassen/:id/kds', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }
    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, params.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send({
      kdsAktiv:     kasse.kdsAktiv,
      kdsPort:      kasse.kdsPort,
      kdsStationen: kasse.kdsStationen,
    })
  })

  // PATCH /kassen/:id/kds — KDS-Stationen + Port + Aktiv
  fastify.patch('/kassen/:id/kds', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const KdsConfigSchema = z.object({
      kdsAktiv:     z.boolean().optional(),
      kdsPort:      z.number().int().min(1).max(65535).optional(),
      kdsStationen: z.record(StationSchema, z.string().trim().min(1).max(64)).optional(),
    })
    const body = KdsConfigSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const update: Partial<typeof kassen.$inferInsert> = { updatedAt: new Date() }
    if (body.data.kdsAktiv     !== undefined) update.kdsAktiv     = body.data.kdsAktiv
    if (body.data.kdsPort      !== undefined) update.kdsPort      = body.data.kdsPort
    if (body.data.kdsStationen !== undefined) update.kdsStationen = body.data.kdsStationen

    const [updated] = await opts.db.update(kassen).set(update).where(eq(kassen.id, params.data.id)).returning()
    if (!updated) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send({
      kdsAktiv:     updated.kdsAktiv,
      kdsPort:      updated.kdsPort,
      kdsStationen: updated.kdsStationen,
    })
  })

  // POST /kassen/:id/drucker/test (Testdruck)
  fastify.post('/kassen/:id/drucker/test', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, params.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const config = druckerConfigVonKasse(kasse)
    if (!config) return reply.status(409).send({ fehler: 'Drucker nicht konfiguriert oder deaktiviert' })

    // Mini-Testdruck
    const bytes = Buffer.concat([
      ep.init(),
      ep.selectCodepage(19),
      ep.selectInternational(2),
      ep.align('center'),
      ep.font({ bold: true, doubleHeight: true }),
      ep.textLine('TEST DRUCK'),
      ep.font(),
      ep.textLine(`Kasse: ${kasse.kassenId}`),
      ep.textLine(new Date().toLocaleString('de-AT')),
      ep.newline(),
      ep.textLine('Wenn Sie das lesen koennen,'),
      ep.textLine('ist die Verbindung in Ordnung.'),
      ep.newline(2),
      ep.cut(),
    ])

    try {
      await sendBytes(bytes, config)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof DruckerError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
