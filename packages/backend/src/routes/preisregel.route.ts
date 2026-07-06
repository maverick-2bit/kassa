/**
 * Preisregel-Routen (Happy Hour) — alle auth-protected, mandantId aus JWT.
 *   GET    /api/preisregeln         Auflisten
 *   POST   /api/preisregeln         Anlegen
 *   PATCH  /api/preisregeln/:id     Aktualisieren
 *   DELETE /api/preisregeln/:id     Löschen
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { PreisregelInputSchema, PreisregelUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { preisregeln } from '../db/schema.js'
import {
  listePreisregeln,
  erstellePreisregel,
  aktualisierePreisregel,
  loeschePreisregel,
} from '../services/preisregel.service.js'

export interface PreisregelRouteOptions {
  db: Db
}

const IdParamSchema = z.object({ id: z.string().uuid() })

async function gehoertZuMandant(db: Db, id: string, mandantId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: preisregeln.id })
    .from(preisregeln)
    .where(and(eq(preisregeln.id, id), eq(preisregeln.mandantId, mandantId)))
    .limit(1)
  return !!row
}

export const preisregelRoute: FastifyPluginAsync<PreisregelRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/preisregeln', auth, async (request, reply) => {
    const list = await listePreisregeln(opts.db, request.user.mandantId)
    return reply.send(list)
  })

  fastify.post('/preisregeln', auth, async (request, reply) => {
    const parsed = PreisregelInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const result = await erstellePreisregel(opts.db, request.user.mandantId, parsed.data)
    return reply.status(201).send(result)
  })

  fastify.patch('/preisregeln/:id', auth, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await gehoertZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Preisregel nicht gefunden' })
    }
    const update = PreisregelUpdateSchema.safeParse(request.body)
    if (!update.success) return reply.status(400).send({ fehler: update.error.issues })
    const result = await aktualisierePreisregel(opts.db, id.data.id, update.data)
    if (!result) return reply.status(404).send({ fehler: 'Preisregel nicht gefunden' })
    return reply.send(result)
  })

  fastify.delete('/preisregeln/:id', auth, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!(await gehoertZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Preisregel nicht gefunden' })
    }
    await loeschePreisregel(opts.db, id.data.id)
    return reply.status(204).send()
  })
}
