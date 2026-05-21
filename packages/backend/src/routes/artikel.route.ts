/**
 * Artikel-Routen (alle auth-protected, mandantId aus JWT).
 *   POST   /api/artikel              Anlegen
 *   GET    /api/artikel              Auflisten (mandantId aus JWT)
 *   PUT    /api/artikel/:id          Aktualisieren
 *   DELETE /api/artikel/:id          Deaktivieren (soft delete)
 */

import type { FastifyPluginAsync } from 'fastify'
import { ArtikelInputSchema, ArtikelUpdateSchema } from '@kassa/shared'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { artikel } from '../db/schema.js'
import {
  erstelleArtikel,
  listeArtikel,
  aktualisiereArtikel,
  deaktiviereArtikel,
} from '../services/artikel.service.js'

export interface ArtikelRouteOptions {
  db: Db
}

const ListQuerySchema = z.object({
  nurAktive: z.coerce.boolean().optional().default(true),
})

const IdParamSchema = z.object({ id: z.string().uuid() })

/** Prüft ob ein Artikel zum Mandanten des angemeldeten Users gehört */
async function gehortArtikelZuMandant(db: Db, artikelId: string, mandantId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: artikel.id })
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  return !!row
}

export const artikelRoute: FastifyPluginAsync<ArtikelRouteOptions> = async (fastify, opts) => {
  fastify.post('/artikel', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    // mandantId IMMER aus JWT — Body wird ignoriert
    const bodyWithoutMandant = { ...(request.body as object), mandantId: request.user.mandantId }
    const parsed = ArtikelInputSchema.safeParse(bodyWithoutMandant)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const result = await erstelleArtikel(opts.db, parsed.data)
    return reply.status(201).send(result)
  })

  fastify.get('/artikel', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const list = await listeArtikel(opts.db, request.user.mandantId, {
      nurAktive: parsed.data.nurAktive,
    })
    return reply.send(list)
  })

  fastify.put('/artikel/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    if (!(await gehortArtikelZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    }

    const update = ArtikelUpdateSchema.safeParse(request.body)
    if (!update.success) return reply.status(400).send({ fehler: update.error.issues })

    const result = await aktualisiereArtikel(opts.db, id.data.id, update.data)
    if (!result) return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    return reply.send(result)
  })

  fastify.delete('/artikel/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    if (!(await gehortArtikelZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    }

    const result = await deaktiviereArtikel(opts.db, id.data.id)
    if (!result) return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    return reply.send(result)
  })
}
