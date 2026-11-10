/**
 * Sprachbestellung (optionales Modul `modulSpracheAktiv`) — Synonyme je Artikel.
 *   GET /api/sprache/synonyme                  alle Artikel mit Synonymen
 *   GET /api/sprache/artikel/:id/synonyme      Synonyme eines Artikels
 *   PUT /api/sprache/artikel/:id/synonyme      Synonyme eines Artikels ersetzen (meldet Konflikte)
 *
 * Alles nur mit Berechtigung „artikel.verwalten" (bzw. Admin) und aktivem Modul (sonst 403);
 * mandantId immer aus dem Login. Die Spracherkennung selbst folgt in einem späteren Schritt.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ArtikelSynonymeSetzenSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { holeSynonyme, listeSynonyme, pruefeSpracheModul, setzeSynonyme, SpracheError } from '../services/sprache.service.js'

export interface SpracheRouteOptions { db: Db }

const IdParam = z.object({ id: z.string().guid() })

export const spracheRoute: FastifyPluginAsync<SpracheRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  const darfVerwalten = (request: FastifyRequest): boolean =>
    request.user.rolle === 'admin' || request.user.berechtigungen.includes('artikel.verwalten')

  const fehlerAntwort = (err: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (err instanceof SpracheError) return reply.status(err.httpStatus).send({ fehler: err.message })
    throw err
  }

  fastify.get('/sprache/synonyme', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    try {
      await pruefeSpracheModul(db, request.user.mandantId)
      return reply.send(await listeSynonyme(db, request.user.mandantId))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.get('/sprache/artikel/:id/synonyme', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await pruefeSpracheModul(db, request.user.mandantId)
      return reply.send(await holeSynonyme(db, request.user.mandantId, p.data.id))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.put('/sprache/artikel/:id/synonyme', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = ArtikelSynonymeSetzenSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      await pruefeSpracheModul(db, request.user.mandantId)
      return reply.send(await setzeSynonyme(db, request.user.mandantId, p.data.id, b.data.synonyme))
    } catch (err) { return fehlerAntwort(err, reply) }
  })
}
