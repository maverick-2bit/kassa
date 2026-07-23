/**
 * Inventur-Routen (Guard: authentifiziert + Berechtigung „artikel.verwalten").
 *
 *   POST   /api/inventuren                    Neue Inventur (Soll-Snapshot)
 *   GET    /api/inventuren                    Liste mit Zähl-Fortschritt
 *   GET    /api/inventuren/:id                Kopf + Positionen (Soll/Ist/Differenz)
 *   PATCH  /api/inventuren/:id/zaehlung       Gezählte Mengen erfassen (nur offen)
 *   POST   /api/inventuren/:id/abschliessen   Ist absolut auf den Lagerstand buchen
 *   DELETE /api/inventuren/:id                Offene Inventur verwerfen
 *   GET    /api/inventuren/:id/protokoll.csv  CSV-Protokoll (Download)
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { InventurAnlageSchema, InventurZaehlSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  erstelleInventur,
  listeInventuren,
  holeInventur,
  erfasseZaehlung,
  schliesseInventurAb,
  loescheInventur,
  inventurProtokollCsv,
  InventurError,
} from '../services/inventur.service.js'

export interface InventurRouteOptions { db: Db }

const IdParam = z.object({ id: z.string().uuid() })

export const inventurRoute: FastifyPluginAsync<InventurRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  const darfVerwalten = (request: FastifyRequest): boolean =>
    request.user.rolle === 'admin' || request.user.berechtigungen.includes('artikel.verwalten')

  fastify.post('/inventuren', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const b = InventurAnlageSchema.safeParse(request.body ?? {})
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      const res = await erstelleInventur(request.user.mandantId, request.user.name, b.data.bezeichnung, db)
      return reply.status(201).send(res)
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      request.log.error(err)
      return reply.status(500).send({ fehler: 'Inventur konnte nicht angelegt werden' })
    }
  })

  fastify.get('/inventuren', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    return reply.send(await listeInventuren(request.user.mandantId, db))
  })

  fastify.get('/inventuren/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await holeInventur(p.data.id, request.user.mandantId, db))
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/inventuren/:id/zaehlung', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = InventurZaehlSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      await erfasseZaehlung(p.data.id, request.user.mandantId, b.data.positionen, db)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/inventuren/:id/abschliessen', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await schliesseInventurAb(p.data.id, request.user.mandantId, db))
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.delete('/inventuren/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await loescheInventur(p.data.id, request.user.mandantId, db)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/inventuren/:id/protokoll.csv', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      const { dateiname, csv } = await inventurProtokollCsv(p.data.id, request.user.mandantId, db)
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${dateiname}"`)
        .send(csv)
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
