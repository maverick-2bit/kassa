/**
 * Kassenbuch-Routen — auth-protected.
 *   GET  /api/kassenbuch           Buchungen + Summen für Zeitraum
 *   POST /api/kassenbuch           Neue Buchung anlegen
 */

import type { FastifyPluginAsync } from 'fastify'
import { KassenbuchBuchungInputSchema, KassenbuchQuerySchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import {
  erstelleKassenbuchBuchung,
  listeKassenbuchBuchungen,
} from '../services/kassenbuch.service.js'

export interface KassenbuchRouteOptions { db: Db }

export const kassenbuchRoute: FastifyPluginAsync<KassenbuchRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/kassenbuch', guard, async (request, reply) => {
    const parsed = KassenbuchQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const result = await listeKassenbuchBuchungen(
      opts.db,
      parsed.data.kasseId,
      parsed.data.von,
      parsed.data.bis,
    )
    return reply.send(result)
  })

  fastify.post('/kassenbuch', guard, async (request, reply) => {
    // mandantId aus Body ignorieren — immer aus JWT + kasseId-Prüfung
    const parsed = KassenbuchBuchungInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const buchung = await erstelleKassenbuchBuchung(
      opts.db,
      parsed.data.kasseId,
      request.user.sub,
      parsed.data.typ,
      parsed.data.betragCent,
      parsed.data.grund ?? null,
      parsed.data.datum,
    )
    return reply.status(201).send(buchung)
  })
}
