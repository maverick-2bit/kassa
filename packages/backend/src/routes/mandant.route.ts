/**
 * Mandanten-Einstellungen
 *
 *  GET  /api/mandanten/module
 *  PATCH /api/mandanten/module
 *
 *  GET  /api/mandanten/stammdaten
 *    → Firmenname, UID, Belegfußtext
 *
 *  PATCH /api/mandanten/stammdaten
 *    → Belegfußtext ändern (erfordert Berechtigung "einstellungen")
 */

import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { mandanten } from '../db/schema.js'
import { MandantModuleUpdateSchema, MandantStammdatenUpdateSchema } from '@kassa/shared'

export interface MandantRouteOptions { db: Db }

export const mandantRoute: FastifyPluginAsync<MandantRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  // ---- GET /mandanten/module ----
  fastify.get('/mandanten/module', guard, async (request, reply) => {
    const [row] = await opts.db
      .select({
        modulGastroAktiv:    mandanten.modulGastroAktiv,
        modulAngeboteAktiv:  mandanten.modulAngeboteAktiv,
        modulMergeportAktiv: mandanten.modulMergeportAktiv,
      })
      .from(mandanten)
      .where(eq(mandanten.id, request.user.mandantId))
      .limit(1)

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })

  // ---- PATCH /mandanten/module ----
  fastify.patch('/mandanten/module', guard, async (request, reply) => {
    // Nur Admins oder User mit "einstellungen"-Berechtigung dürfen Module ändern
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const body = MandantModuleUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const updates: Partial<{
      modulGastroAktiv:    boolean
      modulAngeboteAktiv:  boolean
      modulMergeportAktiv: boolean
    }> = {}

    if (body.data.modulGastroAktiv    !== undefined) updates.modulGastroAktiv    = body.data.modulGastroAktiv
    if (body.data.modulAngeboteAktiv  !== undefined) updates.modulAngeboteAktiv  = body.data.modulAngeboteAktiv
    if (body.data.modulMergeportAktiv !== undefined) updates.modulMergeportAktiv = body.data.modulMergeportAktiv

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ fehler: 'Keine Änderungen angegeben' })
    }

    const [row] = await opts.db
      .update(mandanten)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(mandanten.id, request.user.mandantId))
      .returning({
        modulGastroAktiv:    mandanten.modulGastroAktiv,
        modulAngeboteAktiv:  mandanten.modulAngeboteAktiv,
        modulMergeportAktiv: mandanten.modulMergeportAktiv,
      })

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })

  // ---- GET /mandanten/stammdaten ----
  fastify.get('/mandanten/stammdaten', guard, async (request, reply) => {
    const [row] = await opts.db
      .select({
        firmenname:    mandanten.firmenname,
        uid:           mandanten.uid,
        belegFusstext: mandanten.belegFusstext,
      })
      .from(mandanten)
      .where(eq(mandanten.id, request.user.mandantId))
      .limit(1)

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })

  // ---- PATCH /mandanten/stammdaten ----
  fastify.patch('/mandanten/stammdaten', guard, async (request, reply) => {
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const body = MandantStammdatenUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [row] = await opts.db
      .update(mandanten)
      .set({
        belegFusstext: body.data.belegFusstext ?? null,
        updatedAt:     new Date(),
      })
      .where(eq(mandanten.id, request.user.mandantId))
      .returning({
        firmenname:    mandanten.firmenname,
        uid:           mandanten.uid,
        belegFusstext: mandanten.belegFusstext,
      })

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })
}
