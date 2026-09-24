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
  /**
   * Geräte-Token (fest verbauter KDS-Bildschirm, Einlass-Scanner): langlebig,
   * aber auf seine Geräte-Routen beschränkt — die authenticate/require*-
   * Decorators lehnen ihn überall sonst ab. Beim Einlass-Gerät ist `sub` die
   * Geräte-ID (einzeln sperrbar über einlass_geraete.widerrufen_at).
   */
  typ?:           'kds_geraet' | 'einlass_geraet'
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
