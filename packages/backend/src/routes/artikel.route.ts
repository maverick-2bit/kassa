/**
 * Artikel-Routen
 *   POST   /api/artikel              Anlegen
 *   GET    /api/artikel?mandantId=…  Auflisten
 *   PUT    /api/artikel/:id          Aktualisieren
 *   DELETE /api/artikel/:id          Deaktivieren (soft delete)
 */

import type { FastifyPluginAsync } from 'fastify'
import { ArtikelInputSchema, ArtikelUpdateSchema } from '@kassa/shared'
import { z } from 'zod'
import type { Db } from '../db/client.js'
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
  mandantId: z.string().uuid(),
  nurAktive: z.coerce.boolean().optional().default(true),
})

const IdParamSchema = z.object({ id: z.string().uuid() })

export const artikelRoute: FastifyPluginAsync<ArtikelRouteOptions> = async (fastify, opts) => {
  // POST /artikel
  fastify.post('/artikel', async (request, reply) => {
    const parsed = ArtikelInputSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }
    const artikel = await erstelleArtikel(opts.db, parsed.data)
    return reply.status(201).send(artikel)
  })

  // GET /artikel?mandantId=...
  fastify.get('/artikel', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }
    const list = await listeArtikel(opts.db, parsed.data.mandantId, {
      nurAktive: parsed.data.nurAktive,
    })
    return reply.send(list)
  })

  // PUT /artikel/:id
  fastify.put('/artikel/:id', async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const update = ArtikelUpdateSchema.safeParse(request.body)
    if (!update.success) {
      return reply.status(400).send({ fehler: update.error.issues })
    }
    const result = await aktualisiereArtikel(opts.db, id.data.id, update.data)
    if (!result) return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    return reply.send(result)
  })

  // DELETE /artikel/:id (soft delete)
  fastify.delete('/artikel/:id', async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const result = await deaktiviereArtikel(opts.db, id.data.id)
    if (!result) return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    return reply.send(result)
  })
}
