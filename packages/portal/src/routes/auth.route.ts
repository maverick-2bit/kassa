/**
 * Anmeldung am Portal: Passwort + Authenticator-App (TOTP).
 *
 *   POST /api/auth/anmelden            E-Mail + Passwort (+ Code) → Sitzung, oder „TOTP einrichten"
 *   POST /api/auth/totp/einrichten     (Einrichtungs-Token) Geheimnis + otpauth-Adresse für den QR-Code
 *   POST /api/auth/totp/bestaetigen    (Einrichtungs-Token) Code aus der App → Einrichtung abgeschlossen, Sitzung
 *   GET  /api/ich                      (Sitzung) wer bin ich
 */

import type { FastifyPluginAsync } from 'fastify'
import { PortalAnmeldenSchema, TotpBestaetigenSchema, type PortalAnmeldeAntwort } from '@kassa/shared'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { signiereEinrichtung, signiereSitzung } from '../auth/jwt.js'
import { anmelden, bestaetigeTotp, starteTotpEinrichtung } from '../services/benutzer.service.js'

export interface AuthRouteOptions {
  config:         Config
  db:             Db
  totpSchluessel: Buffer
  jetzt:          () => Date
  /** Anmeldeversuche je Minute und Client (Tests heben das an) */
  anmeldeLimit:   number
}

export const authRoute: FastifyPluginAsync<AuthRouteOptions> = async (fastify, opts) => {
  const { config, db, totpSchluessel, jetzt } = opts
  const limit = { config: { rateLimit: { max: opts.anmeldeLimit, timeWindow: '1 minute' } } }

  fastify.post('/auth/anmelden', limit, async (request, reply) => {
    const eingabe = PortalAnmeldenSchema.safeParse(request.body)
    if (!eingabe.success) return reply.status(400).send({ fehler: 'Bitte E-Mail und Passwort eingeben.' })

    const ergebnis = await anmelden(db, totpSchluessel, eingabe.data, jetzt())
    const antwort: PortalAnmeldeAntwort = ergebnis.art === 'angemeldet'
      ? { status: 'angemeldet', token: signiereSitzung(fastify, config, ergebnis.benutzer), benutzer: ergebnis.benutzer }
      : { status: 'totp_einrichten', einrichtungsToken: signiereEinrichtung(fastify, ergebnis.benutzer) }
    return reply.send(antwort)
  })

  fastify.post('/auth/totp/einrichten', { ...limit, onRequest: [fastify.authentifiziereEinrichtung] }, async (request, reply) => {
    return reply.send(await starteTotpEinrichtung(db, totpSchluessel, request.user.sub))
  })

  fastify.post('/auth/totp/bestaetigen', { ...limit, onRequest: [fastify.authentifiziereEinrichtung] }, async (request, reply) => {
    const eingabe = TotpBestaetigenSchema.safeParse(request.body)
    if (!eingabe.success) return reply.status(400).send({ fehler: 'Bitte den 6-stelligen Code aus der App eingeben.' })

    const benutzer = await bestaetigeTotp(db, totpSchluessel, request.user.sub, eingabe.data.code, jetzt())
    const antwort: PortalAnmeldeAntwort = { status: 'angemeldet', token: signiereSitzung(fastify, config, benutzer), benutzer }
    return reply.send(antwort)
  })

  fastify.get('/ich', { onRequest: [fastify.authentifiziere] }, async (request, reply) => {
    return reply.send({ id: request.user.sub, email: request.user.email })
  })
}
