/**
 * SB-Bestellungs-Verwaltung (JWT-geschützt — zentrale Kassa + KDS).
 *
 *   GET  /api/sb-bestellungen?datum=YYYY-MM-DD   — Tagesliste (Default: heute)
 *   POST /api/sb-bestellungen/:id/bereit          — „Zur Abholung bereit" quittieren
 *   POST /api/sb-bestellungen/:id/abgeholt        — „Abgeholt" quittieren (verschwindet vom Monitor)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  SbBestellungError,
  listeSbBestellungen,
  setzeAbgeholt,
  setzeBereit,
} from '../services/sb-bestellung.service.js'

export interface SbBestellungRouteOptions { db: Db }

const IdParam     = z.object({ id: z.string().uuid() })
const DatumQuery  = z.object({ datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })

export const sbBestellungRoute: FastifyPluginAsync<SbBestellungRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/sb-bestellungen', auth, async (request, reply) => {
    const q = DatumQuery.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: 'Ungültiges Datum (YYYY-MM-DD)' })
    return reply.send(await listeSbBestellungen(opts.db, request.user.mandantId, q.data.datum))
  })

  fastify.post('/sb-bestellungen/:id/bereit', auth, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await setzeBereit(opts.db, p.data.id, request.user.mandantId))
    } catch (err) {
      if (err instanceof SbBestellungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/sb-bestellungen/:id/abgeholt', auth, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await setzeAbgeholt(opts.db, p.data.id, request.user.mandantId))
    } catch (err) {
      if (err instanceof SbBestellungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
