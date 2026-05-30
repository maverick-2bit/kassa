/**
 * Artikel-Routen (alle auth-protected, mandantId aus JWT).
 *   POST   /api/artikel              Anlegen
 *   POST   /api/artikel/bulk         Bulk-Import (Array von Artikel-Inputs)
 *   GET    /api/artikel              Auflisten (mandantId aus JWT)
 *   PUT    /api/artikel/:id          Aktualisieren
 *   DELETE /api/artikel/:id          Deaktivieren (soft delete)
 */

import type { FastifyPluginAsync } from 'fastify'
import { ArtikelInputSchema, ArtikelUpdateSchema } from '@kassa/shared'
import { z } from 'zod'
import { and, eq, isNotNull } from 'drizzle-orm'
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

// mandantId fehlt absichtlich — kommt aus dem JWT und wird serverseitig gesetzt
const BulkImportSchema = z.array(z.record(z.unknown())).min(1).max(500)

export const artikelRoute: FastifyPluginAsync<ArtikelRouteOptions> = async (fastify, opts) => {

  /**
   * POST /artikel/bulk — bis zu 500 Artikel in einer Anfrage anlegen.
   * mandantId kommt aus dem JWT, nicht aus dem Body.
   * Jede Zeile wird einzeln versucht; Fehler einer Zeile blockieren die anderen nicht.
   */
  fastify.post('/artikel/bulk', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = BulkImportSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    let erstellt    = 0
    const fehlzeilen: { index: number; fehler: string }[] = []

    for (let i = 0; i < parsed.data.length; i++) {
      // mandantId aus JWT einfügen und vollständig validieren
      const artikelParsed = ArtikelInputSchema.safeParse({ ...parsed.data[i], mandantId })
      if (!artikelParsed.success) {
        fehlzeilen.push({ index: i, fehler: 'Validierungsfehler: ' + artikelParsed.error.issues.map(e => e.message).join(', ') })
        continue
      }
      try {
        await erstelleArtikel(opts.db, artikelParsed.data)
        erstellt++
      } catch (err) {
        fehlzeilen.push({ index: i, fehler: err instanceof Error ? err.message : 'Unbekannt' })
      }
    }

    return reply.send({ erstellt, fehlgeschlagen: fehlzeilen.length, fehlzeilen })
  })

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

  /**
   * POST /artikel/lager-aktivieren — setzt lagerstandAktiv = true für alle
   * Artikel einer Warengruppe (oder alle aktiven Artikel ohne Kategorie).
   */
  fastify.post('/artikel/lager-aktivieren', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = z.object({
      kategorieId: z.string().uuid().nullable(),
    }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId  = request.user.mandantId
    const where = parsed.data.kategorieId === null
      ? and(eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true))
      : and(
          eq(artikel.mandantId, mandantId),
          eq(artikel.aktiv, true),
          eq(artikel.kategorieId, parsed.data.kategorieId),
        )

    const rows = await opts.db
      .update(artikel)
      .set({ lagerstandAktiv: true, updatedAt: new Date() })
      .where(where)
      .returning({ id: artikel.id })

    return reply.send({ aktiviert: rows.length })
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
