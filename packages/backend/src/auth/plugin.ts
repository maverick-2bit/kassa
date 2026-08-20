/**
 * Fastify-Auth-Plugin: registriert @fastify/jwt und stellt die
 * authenticate + requireRolle Decorators bereit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import type { Berechtigung, Rolle } from '@kassa/shared'
import type { Config } from '../config.js'
import './jwt.js'

export async function registerAuth(fastify: FastifyInstance, config: Config): Promise<void> {
  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign:   { expiresIn: config.JWT_EXPIRES_IN },
  })

  // Geräte-Token (langlebig, z. B. KDS-Bildschirm) dürfen NUR ihre
  // Geräte-Routen benutzen — überall sonst zählen sie als nicht angemeldet.
  const geraetGesperrt = (request: FastifyRequest): boolean =>
    request.user.typ === 'kds_geraet' && !request.url.startsWith('/api/kds/')

  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
    }
    if (geraetGesperrt(request)) {
      return reply.status(403).send({ fehler: 'Geräte-Token gilt nur für das KDS' })
    }
  })

  fastify.decorate('requireRolle', (...rollen: Rolle[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
      }
      if (request.user.typ === 'kds_geraet') {
        return reply.status(403).send({ fehler: 'Geräte-Token gilt nur für das KDS' })
      }
      if (!rollen.includes(request.user.rolle)) {
        return reply.status(403).send({ fehler: `Erforderliche Rolle: ${rollen.join(' oder ')}` })
      }
    },
  )

  // Berechtigungs-Decorator: Admin darf immer, Kellner nur wenn Berechtigung im Token
  fastify.decorate('requireBerechtigung', (berechtigung: Berechtigung) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
      }
      if (request.user.typ === 'kds_geraet') {
        return reply.status(403).send({ fehler: 'Geräte-Token gilt nur für das KDS' })
      }
      if (
        request.user.rolle !== 'admin' &&
        !request.user.berechtigungen.includes(berechtigung)
      ) {
        return reply.status(403).send({ fehler: 'Keine Berechtigung' })
      }
    },
  )
}
