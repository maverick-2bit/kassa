/**
 * Fastify-Auth-Plugin: registriert @fastify/jwt und stellt die
 * authenticate + requireRolle Decorators bereit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import type { Rolle } from '@kassa/shared'
import type { Config } from '../config.js'
import './jwt.js'

export async function registerAuth(fastify: FastifyInstance, config: Config): Promise<void> {
  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign:   { expiresIn: config.JWT_EXPIRES_IN },
  })

  // Standard-Decorator: prüft JWT, schreibt Payload in request.user
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
    }
  })

  // Rollen-Decorator: erst authenticate, dann Rollen-Check
  fastify.decorate('requireRolle', (...rollen: Rolle[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
      }
      if (!rollen.includes(request.user.rolle)) {
        return reply.status(403).send({ fehler: `Erforderliche Rolle: ${rollen.join(' oder ')}` })
      }
    },
  )
}
