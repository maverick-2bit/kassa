/**
 * JWT-Payload-Typen und Fastify-Typ-Erweiterungen.
 *
 * Der Payload steckt im JWT und ist nach Verifikation als `request.user` verfügbar.
 */

import type { Berechtigung, Rolle } from '@kassa/shared'

export interface JwtPayload {
  sub:            string
  mandantId:      string
  rolle:          Rolle
  name:           string
  berechtigungen: Berechtigung[]
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user:    JwtPayload
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
    requireRolle: (...rollen: Rolle[]) =>
      (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
    requireBerechtigung: (berechtigung: Berechtigung) =>
      (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>
  }
}
