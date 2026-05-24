/**
 * POS-Konfiguration pro Kasse.
 *   GET   /api/kassen/:kasseId/pos-config         Konfiguration lesen
 *   PUT   /api/kassen/:kasseId/pos-config         Konfiguration schreiben
 *   PATCH /api/artikel/reihenfolge                Globale Artikel-Reihenfolge (Bulk)
 *   PATCH /api/artikel/favoriten-reihenfolge      Globale Favoriten-Reihenfolge (Bulk)
 *   PATCH /api/kategorien/reihenfolge             Globale Kategorie-Reihenfolge (Bulk)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ReihenfolgeUpdateSchema, FavoritenReihenfolgeUpdateSchema } from '@kassa/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kassen, kassekategorieSichtbarkeit, artikel, kategorien } from '../db/schema.js'

export interface PosConfigRouteOptions { db: Db }

const KasseIdParam = z.object({ kasseId: z.string().uuid() })

const PosConfigBodySchema = z.object({
  sichtbareKategorieIds: z.array(z.string().uuid()).optional(),
  erlaubteZahlungsarten: z.array(z.enum(['bar', 'karte', 'sonstige'])).optional(),
})

export const posConfigRoute: FastifyPluginAsync<PosConfigRouteOptions> = async (fastify, opts) => {

  // ---- GET /kassen/:kasseId/pos-config ----
  fastify.get('/kassen/:kasseId/pos-config', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const p = KasseIdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Kassen-ID' })

    const [kasse] = await opts.db
      .select({ erlaubteZahlungsarten: kassen.erlaubteZahlungsarten })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const sichtbarkeit = await opts.db
      .select({ kategorieId: kassekategorieSichtbarkeit.kategorieId })
      .from(kassekategorieSichtbarkeit)
      .where(eq(kassekategorieSichtbarkeit.kasseId, p.data.kasseId))

    return reply.send({
      sichtbareKategorieIds: sichtbarkeit.map(r => r.kategorieId),
      erlaubteZahlungsarten: kasse.erlaubteZahlungsarten as string[],
    })
  })

  // ---- PUT /kassen/:kasseId/pos-config ----
  fastify.put('/kassen/:kasseId/pos-config', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const p = KasseIdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Kassen-ID' })

    const body = PosConfigBodySchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [kasse] = await opts.db
      .select({ id: kassen.id })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    await opts.db.transaction(async (tx) => {
      // Zahlungsarten
      if (body.data.erlaubteZahlungsarten !== undefined) {
        await tx.update(kassen)
          .set({ erlaubteZahlungsarten: body.data.erlaubteZahlungsarten, updatedAt: new Date() })
          .where(eq(kassen.id, p.data.kasseId))
      }

      // Kategorie-Sichtbarkeit komplett ersetzen
      if (body.data.sichtbareKategorieIds !== undefined) {
        await tx.delete(kassekategorieSichtbarkeit)
          .where(eq(kassekategorieSichtbarkeit.kasseId, p.data.kasseId))

        if (body.data.sichtbareKategorieIds.length > 0) {
          await tx.insert(kassekategorieSichtbarkeit).values(
            body.data.sichtbareKategorieIds.map(kategorieId => ({
              kasseId: p.data.kasseId,
              kategorieId,
            }))
          )
        }
      }
    })

    return reply.status(204).send()
  })

  // ---- PATCH /artikel/reihenfolge ----
  fastify.patch('/artikel/reihenfolge', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = ReihenfolgeUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    await opts.db.transaction(async (tx) => {
      for (const { id, reihenfolge } of parsed.data.eintraege) {
        await tx.update(artikel)
          .set({ reihenfolge, updatedAt: new Date() })
          .where(and(eq(artikel.id, id), eq(artikel.mandantId, mandantId)))
      }
    })
    return reply.status(204).send()
  })

  // ---- PATCH /artikel/favoriten-reihenfolge ----
  fastify.patch('/artikel/favoriten-reihenfolge', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = FavoritenReihenfolgeUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    await opts.db.transaction(async (tx) => {
      for (const { id, favoritenReihenfolge } of parsed.data.eintraege) {
        await tx.update(artikel)
          .set({ favoritenReihenfolge, updatedAt: new Date() })
          .where(and(eq(artikel.id, id), eq(artikel.mandantId, mandantId)))
      }
    })
    return reply.status(204).send()
  })

  // ---- PATCH /kategorien/reihenfolge ----
  fastify.patch('/kategorien/reihenfolge', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = ReihenfolgeUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    await opts.db.transaction(async (tx) => {
      for (const { id, reihenfolge } of parsed.data.eintraege) {
        await tx.update(kategorien)
          .set({ reihenfolge, updatedAt: new Date() })
          .where(and(eq(kategorien.id, id), eq(kategorien.mandantId, mandantId)))
      }
    })
    return reply.status(204).send()
  })
}
