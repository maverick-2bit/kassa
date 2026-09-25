/**
 * Fastify-Auth-Plugin: registriert @fastify/jwt und stellt die
 * authenticate + requireRolle Decorators bereit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import type { Berechtigung, Rolle } from '@kassa/shared'
import type { Config } from '../config.js'
import { erstelleGeraetVertrauen } from './geraet-vertrauen.js'
import './jwt.js'

export async function registerAuth(fastify: FastifyInstance, config: Config): Promise<void> {
  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign:   { expiresIn: config.JWT_EXPIRES_IN },
  })

  // Geräte-Merkmal für die PIN-Bremse — eigener Schlüssel, kein JWT (siehe geraet-vertrauen.ts)
  fastify.decorate('geraetVertrauen', erstelleGeraetVertrauen(config.JWT_SECRET))

  // Geräte-Token (langlebig, z. B. KDS-Bildschirm, Einlass-Scanner) dürfen NUR
  // ihre Geräte-Routen benutzen — überall sonst zählen sie als nicht angemeldet.
  const GERAETE_BEREICH = {
    kds_geraet:     { pfad: '/api/kds/',     fehler: 'Geräte-Token gilt nur für das KDS' },
    einlass_geraet: { pfad: '/api/einlass/', fehler: 'Geräte-Token gilt nur für den Einlass' },
  } as const
  const geraetBereich = (request: FastifyRequest) =>
    request.user.typ ? GERAETE_BEREICH[request.user.typ] : undefined

  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
    }
    const bereich = geraetBereich(request)
    if (bereich && !request.url.startsWith(bereich.pfad)) {
      return reply.status(403).send({ fehler: bereich.fehler })
    }
  })

  fastify.decorate('requireRolle', (...rollen: Rolle[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
      }
      // Geräte-Token haben keine Rollen/Berechtigungen — nie hier durchlassen
      const bereich = geraetBereich(request)
      if (bereich) {
        return reply.status(403).send({ fehler: bereich.fehler })
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
      // Geräte-Token haben keine Rollen/Berechtigungen — nie hier durchlassen
      const bereich = geraetBereich(request)
      if (bereich) {
        return reply.status(403).send({ fehler: bereich.fehler })
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
