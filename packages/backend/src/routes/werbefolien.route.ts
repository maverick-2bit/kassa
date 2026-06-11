/**
 * Werbefolien-Routen — Bilder für Kundendisplay-Werbemodus
 *
 *  GET    /api/werbefolien                → Liste aller aktiven Folien (mandant-scoped)
 *  POST   /api/werbefolien                → Neue Folie anlegen
 *  PATCH  /api/werbefolien/:id            → Folie aktualisieren
 *  DELETE /api/werbefolien/:id            → Folie löschen
 *
 *  GET    /api/werbefolien/public/:mandantId → Öffentlich (kein JWT, für Kundendisplay)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { werbefolien } from '../db/schema.js'
import { WerbefolieInputSchema, WerbefolieUpdateSchema } from '@kassa/shared'

export interface WerbefolienRouteOptions { db: Db }

const IdParam       = z.object({ id: z.string().uuid() })
const MandantParam  = z.object({ mandantId: z.string().uuid() })

function toDto(row: typeof werbefolien.$inferSelect) {
  return {
    id:               row.id,
    mandantId:        row.mandantId,
    titel:            row.titel,
    bildBase64:       row.bildBase64,
    mimeType:         row.mimeType,
    reihenfolge:      row.reihenfolge,
    aktiv:            row.aktiv,
    anzeigedauerSek:  row.anzeigedauerSek,
    createdAt:        row.createdAt.toISOString(),
    updatedAt:        row.updatedAt.toISOString(),
  }
}

export const werbefolienRoute: FastifyPluginAsync<WerbefolienRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  // ---- GET /werbefolien ----
  fastify.get('/werbefolien', guard, async (request, reply) => {
    const rows = await opts.db
      .select()
      .from(werbefolien)
      .where(eq(werbefolien.mandantId, request.user.mandantId))
      .orderBy(asc(werbefolien.reihenfolge), asc(werbefolien.createdAt))

    return reply.send(rows.map(toDto))
  })

  // ---- POST /werbefolien ----
  fastify.post('/werbefolien', guard, async (request, reply) => {
    const body = WerbefolieInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [row] = await opts.db
      .insert(werbefolien)
      .values({
        mandantId:       request.user.mandantId,
        titel:           body.data.titel ?? '',
        bildBase64:      body.data.bildBase64,
        mimeType:        body.data.mimeType ?? 'image/jpeg',
        reihenfolge:     body.data.reihenfolge ?? 0,
        aktiv:           body.data.aktiv ?? true,
        anzeigedauerSek: body.data.anzeigedauerSek ?? 8,
      })
      .returning()

    return reply.status(201).send(toDto(row!))
  })

  // ---- PATCH /werbefolien/:id ----
  fastify.patch('/werbefolien/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = WerbefolieUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const changes: Partial<typeof werbefolien.$inferInsert> = { updatedAt: new Date() }
    if (body.data.titel           !== undefined) changes.titel           = body.data.titel
    if (body.data.bildBase64      !== undefined) changes.bildBase64      = body.data.bildBase64
    if (body.data.mimeType        !== undefined) changes.mimeType        = body.data.mimeType
    if (body.data.reihenfolge     !== undefined) changes.reihenfolge     = body.data.reihenfolge
    if (body.data.aktiv           !== undefined) changes.aktiv           = body.data.aktiv
    if (body.data.anzeigedauerSek !== undefined) changes.anzeigedauerSek = body.data.anzeigedauerSek

    const [row] = await opts.db
      .update(werbefolien)
      .set(changes)
      .where(and(eq(werbefolien.id, p.data.id), eq(werbefolien.mandantId, request.user.mandantId)))
      .returning()

    if (!row) return reply.status(404).send({ fehler: 'Folie nicht gefunden' })
    return reply.send(toDto(row))
  })

  // ---- DELETE /werbefolien/:id ----
  fastify.delete('/werbefolien/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [row] = await opts.db
      .delete(werbefolien)
      .where(and(eq(werbefolien.id, p.data.id), eq(werbefolien.mandantId, request.user.mandantId)))
      .returning({ id: werbefolien.id })

    if (!row) return reply.status(404).send({ fehler: 'Folie nicht gefunden' })
    return reply.status(204).send()
  })

  // ---- GET /werbefolien/public/:mandantId (kein JWT) ----
  fastify.get('/werbefolien/public/:mandantId', async (request, reply) => {
    const p = MandantParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    // ETag aus id+updatedAt — das Kundendisplay pollt jede Minute, die Bilder
    // (Base64, teils MB-groß) werden nur bei tatsächlicher Änderung übertragen
    const meta = await opts.db
      .select({ id: werbefolien.id, updatedAt: werbefolien.updatedAt })
      .from(werbefolien)
      .where(and(eq(werbefolien.mandantId, p.data.mandantId), eq(werbefolien.aktiv, true)))
      .orderBy(asc(werbefolien.reihenfolge), asc(werbefolien.createdAt))

    const etag = `"${meta.map(m => `${m.id}:${m.updatedAt.getTime()}`).join(',') || 'leer'}"`
    if (request.headers['if-none-match'] === etag) {
      return reply.status(304).header('ETag', etag).send()
    }

    const rows = meta.length === 0 ? [] : await opts.db
      .select()
      .from(werbefolien)
      .where(and(eq(werbefolien.mandantId, p.data.mandantId), eq(werbefolien.aktiv, true)))
      .orderBy(asc(werbefolien.reihenfolge), asc(werbefolien.createdAt))

    return reply.header('ETag', etag).send(rows.map(row => ({
      id:              row.id,
      titel:           row.titel,
      bildBase64:      row.bildBase64,
      mimeType:        row.mimeType,
      reihenfolge:     row.reihenfolge,
      anzeigedauerSek: row.anzeigedauerSek,
    })))
  })
}
