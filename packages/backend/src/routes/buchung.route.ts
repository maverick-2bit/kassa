/**
 * Öffentliche Buchungs-Routen (kein JWT)
 *
 *  GET  /api/buchung/:kasseId
 *    → Restaurant-Info + ob Online-Buchung aktiv
 *
 *  POST /api/buchung/:kasseId
 *    → Neue Reservierung anlegen (landet als status='wartend')
 *
 *  POST /api/buchung/:kasseId/stornieren/:token
 *    → Reservierung via Online-Token stornieren
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { OnlineBuchungInputSchema } from '@kassa/shared'
import {
  ladeOnlineBuchungInfo,
  erstelleOnlineReservierung,
  storniereViaToken,
} from '../services/reservierung.service.js'

export interface BuchungRouteOptions { db: Db }

const KasseParam = z.object({ kasseId: z.string().uuid() })
const StorniereParam = z.object({ kasseId: z.string().uuid(), token: z.string().uuid() })

export const buchungRoute: FastifyPluginAsync<BuchungRouteOptions> = async (fastify, opts) => {
  // ---- GET /buchung/:kasseId ----
  fastify.get('/buchung/:kasseId', async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    try {
      const info = await ladeOnlineBuchungInfo(opts.db, p.data.kasseId)
      return reply.send(info)
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  // ---- POST /buchung/:kasseId ----
  fastify.post('/buchung/:kasseId', async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = OnlineBuchungInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const res = await erstelleOnlineReservierung(opts.db, p.data.kasseId, body.data)
      // Nur die nötigsten Infos zurückgeben (kein onlineToken, keine internen IDs)
      return reply.status(201).send({
        id:          res.id,
        datum:       res.datum,
        zeitVon:     res.zeitVon,
        name:        res.name,
        onlineToken: res.onlineToken,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fehler'
      const status = msg.includes('nicht gefunden') ? 404
        : msg.includes('nicht aktiviert') ? 403
        : 500
      return reply.status(status).send({ fehler: msg })
    }
  })

  // ---- POST /buchung/:kasseId/stornieren/:token ----
  fastify.post('/buchung/:kasseId/stornieren/:token', async (request, reply) => {
    const p = StorniereParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Parameter' })

    try {
      await storniereViaToken(opts.db, p.data.kasseId, p.data.token)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fehler'
      const status = msg.includes('nicht gefunden') ? 404 : 409
      return reply.status(status).send({ fehler: msg })
    }
  })
}
