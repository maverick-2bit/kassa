/**
 * Empfang der Meldungen der Boxen.
 *
 *   POST /api/box/meldung     Authorization: Bearer <Token der Box>, Body = PortalMeldung (Schema 1)
 *
 * Kein Benutzer-Login: die Box ist über ihr Token ausgewiesen (gespeichert ist nur der Hash). Die Meldung wird gegen das
 * Schema geprüft; was nicht darin steht, nimmt das Portal nicht an.
 */

import type { FastifyPluginAsync } from 'fastify'
import { PortalMeldungSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { tokenAusAuthorization } from '../auth/box-token.js'
import { findeBoxPerToken, verarbeiteMeldung } from '../services/meldung.service.js'

export interface BoxRouteOptions {
  db:    Db
  jetzt: () => Date
  /** Meldungen je Minute und Token (eine Box meldet im Minutentakt oder seltener) */
  meldungsLimit: number
}

export const boxRoute: FastifyPluginAsync<BoxRouteOptions> = async (fastify, opts) => {
  const { db, jetzt } = opts

  fastify.post('/box/meldung', {
    config: {
      rateLimit: {
        max: opts.meldungsLimit,
        timeWindow: '1 minute',
        // Je Token begrenzen (nicht je Adresse: mehrere Boxen können hinter einem Anschluss stehen)
        keyGenerator: (request) => request.headers.authorization ?? request.ip,
      },
    },
  }, async (request, reply) => {
    const token = tokenAusAuthorization(request.headers.authorization)
    const box = token ? await findeBoxPerToken(db, token) : null
    // Immer dieselbe Antwort — ob das Token falsch geformt, unbekannt oder gesperrt ist, soll man nicht erfahren
    if (!box) return reply.status(401).send({ fehler: 'Token ungültig' })

    const meldung = PortalMeldungSchema.safeParse(request.body)
    if (!meldung.success) {
      return reply.status(400).send({ fehler: 'Meldung ungültig', details: meldung.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`) })
    }

    await verarbeiteMeldung(db, box, meldung.data, jetzt())
    return reply.send({ ok: true })
  })
}
