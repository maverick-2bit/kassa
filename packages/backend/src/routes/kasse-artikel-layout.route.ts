/**
 * Artikel-Anordnung je Kasse + Standard-Raster (alle auth-protected, mandantId immer aus dem JWT).
 *   GET    /api/kassen/:kasseId/artikel-layouts                  alle Anordnungen der Kasse (jede angemeldete Rolle,
 *                                                                wie pos-config: Kasse, Tisch und Kellner-App laden sie)
 *   PUT    /api/kassen/:kasseId/artikel-layouts/:kategorieId     Anordnung einer Warengruppe ersetzen (nur Admin)
 *   DELETE /api/kassen/:kasseId/artikel-layouts/:kategorieId     zurück auf das Standard-Layout (nur Admin)
 *   PUT    /api/kategorien/:kategorieId/artikel-raster           Standard-Raster einer Warengruppe setzen (nur Admin)
 *
 * Semantik der Kassen-Anordnung: siehe services/kasse-artikel-layout.service.ts und @kassa/shared (raster.ts).
 * Fremde Kassen, Warengruppen und Artikel (anderer Mandant) sind „nicht gefunden" (404).
 */

import type { FastifyPluginAsync } from 'fastify'
import { KasseArtikelLayoutUpdateSchema, StandardRasterUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  KassenLayoutError,
  ladeKassenLayouts,
  loescheKassenLayout,
  speichereKassenLayout,
  speichereStandardRaster,
} from '../services/kasse-artikel-layout.service.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import { uuidParam } from './uuid-param.js'

export interface KasseArtikelLayoutRouteOptions { db: Db }

export const kasseArtikelLayoutRoute: FastifyPluginAsync<KasseArtikelLayoutRouteOptions> = async (fastify, opts) => {
  const auth    = { onRequest: [fastify.authenticate] }
  const adminOk = { onRequest: [fastify.requireRolle('admin')] }

  fastify.get('/kassen/:kasseId/artikel-layouts', auth, async (request, reply) => {
    const kasseId   = uuidParam(request.params, 'kasseId')
    const mandantId = request.user.mandantId
    if (!(await pruefeKasseGehoertZuMandant(opts.db, kasseId, mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }
    return reply.send(await ladeKassenLayouts(opts.db, mandantId, kasseId))
  })

  fastify.put('/kassen/:kasseId/artikel-layouts/:kategorieId', adminOk, async (request, reply) => {
    const kasseId     = uuidParam(request.params, 'kasseId')
    const kategorieId = uuidParam(request.params, 'kategorieId')
    const body = KasseArtikelLayoutUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      await speichereKassenLayout(opts.db, request.user.mandantId, kasseId, kategorieId, body.data.eintraege)
    } catch (err) {
      if (err instanceof KassenLayoutError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
    return reply.status(204).send()
  })

  fastify.delete('/kassen/:kasseId/artikel-layouts/:kategorieId', adminOk, async (request, reply) => {
    const kasseId     = uuidParam(request.params, 'kasseId')
    const kategorieId = uuidParam(request.params, 'kategorieId')
    try {
      await loescheKassenLayout(opts.db, request.user.mandantId, kasseId, kategorieId)
    } catch (err) {
      if (err instanceof KassenLayoutError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
    return reply.status(204).send()
  })

  fastify.put('/kategorien/:kategorieId/artikel-raster', adminOk, async (request, reply) => {
    const kategorieId = uuidParam(request.params, 'kategorieId')
    const body = StandardRasterUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      await speichereStandardRaster(opts.db, request.user.mandantId, kategorieId, body.data.eintraege)
    } catch (err) {
      if (err instanceof KassenLayoutError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
    return reply.status(204).send()
  })
}
