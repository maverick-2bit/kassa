/**
 * Kategorie-Routen (alle auth-protected, mandantId aus JWT).
 *   POST   /api/kategorien              Anlegen
 *   GET    /api/kategorien              Auflisten (mandantId aus JWT)
 *   PUT    /api/kategorien/:id          Aktualisieren
 *   DELETE /api/kategorien/:id          Deaktivieren (soft delete)
 */

import type { FastifyPluginAsync } from 'fastify'
import { KategorieInputSchema, KategorieUpdateSchema } from '@kassa/shared'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kategorien } from '../db/schema.js'
import {
  erstelleKategorie,
  listeKategorien,
  aktualisiereKategorie,
  deaktiviereKategorie,
} from '../services/kategorie.service.js'

export interface KategorieRouteOptions {
  db: Db
}

const ListQuerySchema = z.object({
  nurAktive: z.coerce.boolean().optional().default(false),
})

const IdParamSchema = z.object({ id: z.string().uuid() })

async function gehoertKategorieZuMandant(db: Db, id: string, mandantId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: kategorien.id })
    .from(kategorien)
    .where(and(eq(kategorien.id, id), eq(kategorien.mandantId, mandantId)))
    .limit(1)
  return !!row
}

export const kategorieRoute: FastifyPluginAsync<KategorieRouteOptions> = async (fastify, opts) => {
  fastify.post('/kategorien', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = KategorieInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const result = await erstelleKategorie(opts.db, request.user.mandantId, parsed.data)
    return reply.status(201).send(result)
  })

  fastify.get('/kategorien', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const list = await listeKategorien(opts.db, request.user.mandantId, {
      nurAktive: parsed.data.nurAktive,
    })
    return reply.send(list)
  })

  fastify.put('/kategorien/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    if (!(await gehoertKategorieZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kategorie nicht gefunden' })
    }

    const update = KategorieUpdateSchema.safeParse(request.body)
    if (!update.success) return reply.status(400).send({ fehler: update.error.issues })

    const result = await aktualisiereKategorie(opts.db, id.data.id, update.data)
    if (!result) return reply.status(404).send({ fehler: 'Kategorie nicht gefunden' })
    return reply.send(result)
  })

  fastify.delete('/kategorien/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    if (!(await gehoertKategorieZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kategorie nicht gefunden' })
    }

    const result = await deaktiviereKategorie(opts.db, id.data.id)
    if (!result) return reply.status(404).send({ fehler: 'Kategorie nicht gefunden' })
    return reply.send(result)
  })
}
