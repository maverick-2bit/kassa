/**
 * JWT-Payload-Typen und Fastify-Typ-Erweiterungen.
 *
 * Der Payload steckt im JWT und ist nach Verifikation als `request.user` verfügbar.
 */

import type { Rolle } from '@kassa/shared'

export interface JwtPayload {
  /** User-UUID */
  sub:       string
  /** Mandanten-UUID (für Multi-Tenant-Scoping) */
  mandantId: string
  /** Rolle für Berechtigungs-Checks */
  rolle:     Rolle
  /** Anzeigename (für UI) */
  name:      string
}

// Fastify-Typ-Erweiterung für @fastify/jwt
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user:    JwtPayload
  }
}

// FastifyInstance-Erweiterung für unseren authenticate-Decorator
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
    requireRolle: (...rollen: Rolle[]) =>
      (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
}
