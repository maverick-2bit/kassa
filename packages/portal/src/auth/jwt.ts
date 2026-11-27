/**
 * Sitzungen des Portals (JWT) und die Wächter, die Routen schützen.
 *
 * Zwei Arten von Token, nie austauschbar:
 *  - 'portal'      die eigentliche Sitzung (nach Passwort UND Code)
 *  - 'totp-setup'  nur für die Einrichtung der Authenticator-App (10 Minuten, nach richtigem Passwort)
 *
 * Jeder Wächter trägt ein Merkmal (`portalSchutz`), damit tests/route-schutz.test.ts nachprüfen kann, dass keine Route
 * versehentlich ungeschützt ist.
 */

import fastifyJwt from '@fastify/jwt'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { holeBenutzer } from '../services/benutzer.service.js'

export type JwtScope = 'portal' | 'totp-setup'

export interface JwtPayload {
  sub:   string
  email: string
  scope: JwtScope
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user:    JwtPayload
  }
}

export type Waechter = ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) & { portalSchutz?: JwtScope }

declare module 'fastify' {
  interface FastifyInstance {
    authentifiziere:           Waechter
    authentifiziereEinrichtung: Waechter
  }
}

export const EINRICHTUNG_MINUTEN = 10

export async function registriereAuth(fastify: FastifyInstance, config: Config, db: Db): Promise<void> {
  await fastify.register(fastifyJwt, { secret: config.PORTAL_JWT_SECRET })

  const waechter = (scope: JwtScope): Waechter => {
    const w: Waechter = async (request, reply) => {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
      }
      if (request.user.scope !== scope) return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
      // Ein deaktivierter oder gelöschter Benutzer verliert seine Sitzung sofort, nicht erst nach Ablauf
      if (!(await holeBenutzer(db, request.user.sub))) return reply.status(401).send({ fehler: 'Authentifizierung erforderlich' })
    }
    w.portalSchutz = scope
    return w
  }

  fastify.decorate('authentifiziere', waechter('portal'))
  fastify.decorate('authentifiziereEinrichtung', waechter('totp-setup'))
}

export function signiereSitzung(fastify: FastifyInstance, config: Config, benutzer: { id: string; email: string }): string {
  return fastify.jwt.sign({ sub: benutzer.id, email: benutzer.email, scope: 'portal' }, { expiresIn: `${config.PORTAL_SITZUNG_STUNDEN}h` })
}

export function signiereEinrichtung(fastify: FastifyInstance, benutzer: { id: string; email: string }): string {
  return fastify.jwt.sign({ sub: benutzer.id, email: benutzer.email, scope: 'totp-setup' }, { expiresIn: `${EINRICHTUNG_MINUTEN}m` })
}
