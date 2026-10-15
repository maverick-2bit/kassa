/**
 * Einrichtungs-Übersicht (Einstellungen → Kassen).
 *   GET  /api/einrichtung                       Alle Kassen mit Druckern/Warengruppen/KDS + alle Kassen-Ausnahmen
 *   PUT  /api/einrichtung/ausnahmen             Kassen-Ausnahmen beim Bon-Routing ändern (Stapel, alles oder nichts)
 *   POST /api/kassen/:id/einrichtung-kopieren   Einrichtung einer anderen Kasse übernehmen
 *
 * Geschrieben wird sonst über die bestehenden Endpunkte je Kasse (Drucker, KDS, POS-Konfiguration).
 */

import type { FastifyPluginAsync } from 'fastify'
import { EinrichtungKopierenSchema, RoutingAenderungenSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { EinrichtungError, kopiereEinrichtung, ladeEinrichtung, setzeRoutingAusnahmen } from '../services/einrichtung.service.js'
import { uuidParam } from './uuid-param.js'

export interface EinrichtungRouteOptions { db: Db }

/** Nur Admins oder Benutzer mit „einstellungen"-Berechtigung dürfen die Einrichtung ändern. */
const darfVerwalten = (u: { rolle: string; berechtigungen: string[] }) =>
  u.rolle === 'admin' || u.berechtigungen.includes('einstellungen')

export const einrichtungRoute: FastifyPluginAsync<EinrichtungRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/einrichtung', auth, async (request, reply) => {
    return reply.send(await ladeEinrichtung(opts.db, request.user.mandantId))
  })

  fastify.put('/einrichtung/ausnahmen', auth, async (request, reply) => {
    if (!darfVerwalten(request.user)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const body = RoutingAenderungenSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      await setzeRoutingAusnahmen(opts.db, request.user.mandantId, body.data.aenderungen)
    } catch (err) {
      if (err instanceof EinrichtungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
    return reply.status(204).send()
  })

  fastify.post('/kassen/:id/einrichtung-kopieren', auth, async (request, reply) => {
    if (!darfVerwalten(request.user)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const id   = uuidParam(request.params)
    const body = EinrichtungKopierenSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      await kopiereEinrichtung(opts.db, request.user.mandantId, id, body.data.vonKasseId)
    } catch (err) {
      if (err instanceof EinrichtungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
    return reply.status(204).send()
  })
}
