/**
 * Drucker-Routen
 *   GET   /api/kassen/:id/drucker         Drucker-Konfiguration
 *   PATCH /api/kassen/:id/drucker         Drucker-Konfiguration ändern
 *   GET   /api/kassen/:id/drucker/status  Online-Status (TCP-Check)
 *   GET   /api/kassen/:id/drucker/log     Letzte 50 Druckversuche
 *   POST  /api/belege/:id/drucken         Bon manuell drucken
 *   POST  /api/kassen/:id/drucker/test    Testdruck
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { Buffer } from 'node:buffer'
import { StationSchema, BelegModusEnum } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { druckLog, kassen } from '../db/schema.js'
import { pruefeBelegGehoertZuMandant, pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import { waehleDruckerFuerKasse } from '../services/drucker-pool.service.js'
import {
  druckeBeleg,
  sendBytes,
  druckerConfigVonKasse,
  aktualisiereStatus,
  getDruckerStatus,
  DruckerError,
} from '../services/drucker.service.js'
import * as ep from '../services/escpos/commands.js'

export interface DruckerRouteOptions { db: Db }

const IdParamSchema = z.object({ id: z.string().uuid() })

const DruckerConfigInputSchema = z.object({
  // Auswahl aus der Bondrucker-Bibliothek (null = kein Drucker). Setzt den Snapshot.
  druckerId:          z.string().uuid().nullable().optional(),
  druckerIp:          z.string().trim().min(1).max(64).nullable().optional(),
  druckerPort:        z.number().int().min(1).max(65535).optional(),
  druckerAktiv:       z.boolean().optional(),
  druckerBreite:      z.number().int().min(20).max(80).optional(),
  druckerTimeoutSek:  z.number().int().min(1).max(30).optional(),
  belegModus:         BelegModusEnum.optional(),
  belegBasisUrl:      z.string().trim().max(255).nullable().optional(),
})

function kasseZuDruckerDto(kasse: typeof kassen.$inferSelect) {
  return {
    druckerId:         kasse.druckerId,
    druckerIp:         kasse.druckerIp,
    druckerPort:       kasse.druckerPort,
    druckerAktiv:      kasse.druckerAktiv,
    druckerBreite:     kasse.druckerBreite,
    druckerTimeoutSek: kasse.druckerTimeoutSek,
    belegModus:        kasse.belegModus,
    belegBasisUrl:     kasse.belegBasisUrl,
  }
}

export const druckerRoute: FastifyPluginAsync<DruckerRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  // ── GET /kassen/:id/drucker ─────────────────────────────────────────────────
  fastify.get('/kassen/:id/drucker', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, params.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send(kasseZuDruckerDto(kasse))
  })

  // ── PATCH /kassen/:id/drucker ───────────────────────────────────────────────
  fastify.patch('/kassen/:id/drucker', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const body = DruckerConfigInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    // Drucker-Auswahl aus der Bibliothek → schreibt den Inline-Snapshot der Kasse.
    if (body.data.druckerId !== undefined) {
      const ok = await waehleDruckerFuerKasse(opts.db, params.data.id, request.user.mandantId, body.data.druckerId)
      if (!ok) return reply.status(400).send({ fehler: 'Gewählter Drucker nicht gefunden' })
    }

    const update: Partial<typeof kassen.$inferInsert> = { updatedAt: new Date() }
    // Alt-Inline-Felder nur akzeptieren, wenn NICHT gleichzeitig per Pool gewählt wurde
    // (sonst würde der eben geschriebene Snapshot überschrieben).
    if (body.data.druckerId === undefined) {
      if (body.data.druckerIp         !== undefined) update.druckerIp         = body.data.druckerIp ?? null
      if (body.data.druckerPort       !== undefined) update.druckerPort       = body.data.druckerPort
      if (body.data.druckerAktiv      !== undefined) update.druckerAktiv      = body.data.druckerAktiv
      if (body.data.druckerBreite     !== undefined) update.druckerBreite     = body.data.druckerBreite
      if (body.data.druckerTimeoutSek !== undefined) update.druckerTimeoutSek = body.data.druckerTimeoutSek
    }
    if (body.data.belegModus        !== undefined) update.belegModus        = body.data.belegModus
    if (body.data.belegBasisUrl     !== undefined) update.belegBasisUrl     = body.data.belegBasisUrl ?? null

    const [updated] = await opts.db.update(kassen).set(update).where(eq(kassen.id, params.data.id)).returning()
    if (!updated) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send(kasseZuDruckerDto(updated))
  })

  // ── GET /kassen/:id/drucker/status — TCP-Ping ───────────────────────────────
  fastify.get('/kassen/:id/drucker/status', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, params.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    if (!kasse.druckerAktiv || !kasse.druckerIp) {
      return reply.send({ online: null, grund: 'Drucker nicht konfiguriert' })
    }

    // Cache nutzen wenn < 30s alt
    const cached = getDruckerStatus(kasse.druckerIp, kasse.druckerPort)
    if (cached && Date.now() - cached.geprüftAm.getTime() < 30_000) {
      return reply.send({ online: cached.online, geprüftAm: cached.geprüftAm })
    }

    const online = await aktualisiereStatus(kasse.druckerIp, kasse.druckerPort)
    return reply.send({ online, geprüftAm: new Date() })
  })

  // ── GET /kassen/:id/drucker/log — Druckhistorie ─────────────────────────────
  fastify.get('/kassen/:id/drucker/log', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const eintraege = await opts.db
      .select()
      .from(druckLog)
      .where(eq(druckLog.kasseId, params.data.id))
      .orderBy(desc(druckLog.erstelltAt))
      .limit(50)

    return reply.send(eintraege.map(e => ({
      id:          e.id,
      druckerIp:   e.druckerIp,
      druckerTyp:  e.druckerTyp,
      belegId:     e.belegId,
      erfolg:      e.erfolg,
      fehlerText:  e.fehlerText,
      erstelltAt:  e.erstelltAt.toISOString(),
    })))
  })

  // ── POST /belege/:id/drucken (Reprint) ──────────────────────────────────────
  fastify.post('/belege/:id/drucken', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeBelegGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Beleg nicht gefunden' })

    // „Nicht akzeptiert" (Digital-Modus): ausweich=true erzwingt den Papier-Druck
    const ausweich = (request.body as { ausweich?: boolean } | undefined)?.ausweich === true

    try {
      await druckeBeleg(opts.db, params.data.id, { ignoreModus: ausweich })
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof DruckerError)
        return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'Reprint fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── GET /kassen/:id/kds ─────────────────────────────────────────────────────
  fastify.get('/kassen/:id/kds', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, params.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send({ kdsAktiv: kasse.kdsAktiv, kdsPort: kasse.kdsPort, kdsStationen: kasse.kdsStationen })
  })

  // ── PATCH /kassen/:id/kds ───────────────────────────────────────────────────
  fastify.patch('/kassen/:id/kds', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

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
    return reply.send({ kdsAktiv: updated.kdsAktiv, kdsPort: updated.kdsPort, kdsStationen: updated.kdsStationen })
  })

  // ── POST /kassen/:id/drucker/test ───────────────────────────────────────────
  fastify.post('/kassen/:id/drucker/test', auth, async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, params.data.id, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, params.data.id)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const config = druckerConfigVonKasse(kasse)
    if (!config) return reply.status(409).send({ fehler: 'Drucker nicht konfiguriert oder deaktiviert' })

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
      // Testdruck in Druckhistorie loggen
      await opts.db.insert(druckLog).values({
        mandantId:  request.user.mandantId,
        kasseId:    kasse.id,
        druckerIp:  config.ip,
        druckerTyp: 'test',
        erfolg:     true,
      })
      return reply.send({ erfolgreich: true })
    } catch (err) {
      await opts.db.insert(druckLog).values({
        mandantId:  request.user.mandantId,
        kasseId:    kasse.id,
        druckerIp:  config.ip,
        druckerTyp: 'test',
        erfolg:     false,
        fehlerText: err instanceof Error ? err.message : String(err),
      }).catch(() => {})
      if (err instanceof DruckerError)
        return reply.status(err.httpStatus).send({ fehler: err.message })
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
