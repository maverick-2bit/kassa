/**
 * Auth-Routen
 *   POST /api/auth/login   E-Mail + Passwort → JWT
 *   GET  /api/auth/me      Aktueller User (für Frontend-Refresh)
 */

import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import { LoginInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen, mandanten, users } from '../db/schema.js'
import { AuthError, login, userZuDto } from '../services/auth.service.js'

export interface AuthRouteOptions {
  db: Db
}

export const authRoute: FastifyPluginAsync<AuthRouteOptions> = async (fastify, opts) => {
  fastify.post('/auth/login', async (request, reply) => {
    const parsed = LoginInputSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }

    try {
      const result = await login(parsed.data, {
        db: opts.db,
        signToken: (payload) => fastify.jwt.sign(payload),
      })
      return reply.send(result)
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Login fehlgeschlagen')
      return reply.status(500).send({ fehler: 'Login fehlgeschlagen' })
    }
  })

  // Geschützte Route — liefert aktuelle User-/Mandant-/Kassen-Daten
  fastify.get('/auth/me', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const [user] = await opts.db.select().from(users).where(eq(users.id, request.user.sub)).limit(1)
    if (!user) return reply.status(404).send({ fehler: 'Benutzer nicht gefunden' })

    const [mandant] = await opts.db
      .select({ id: mandanten.id, firmenname: mandanten.firmenname, uid: mandanten.uid })
      .from(mandanten)
      .where(eq(mandanten.id, user.mandantId))
      .limit(1)

    const kassenListe = await opts.db
      .select({ id: kassen.id, kassenId: kassen.kassenId, umgebung: kassen.umgebung })
      .from(kassen)
      .where(eq(kassen.mandantId, user.mandantId))

    return reply.send({
      user:    userZuDto(user),
      mandant,
      kassen:  kassenListe,
    })
  })
}
