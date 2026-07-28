/**
 * Öffentliche Buchungs-Routen (kein JWT)
 *
 *  GET  /api/buchung/:kasseId
 *    → Restaurant-Info + ob Online-Buchung aktiv
 *
 *  POST /api/buchung/:kasseId
 *    → Neue Reservierung anlegen (landet als status='wartend')
 *    → Sendet Bestätigungs-E-Mail an Gast, wenn E-Mail-Adresse vorhanden
 *
 *  POST /api/buchung/:kasseId/stornieren/:token
 *    → Reservierung via Online-Token stornieren
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { eq } from 'drizzle-orm'
import { kassen } from '../db/schema.js'
import { OnlineBuchungInputSchema } from '@kassa/shared'
import {
  ladeOnlineBuchungInfo,
  erstelleOnlineReservierung,
  listeTischVerfuegbarkeit,
  storniereViaToken,
  ReservierungError,
} from '../services/reservierung.service.js'
import {
  isEmailAktiv,
  sendeReservierungsBestaetigung,
} from '../services/email.service.js'

export interface BuchungRouteOptions { db: Db; config: Config }

const KasseParam    = z.object({ kasseId: z.string().uuid() })
const StorniereParam = z.object({ kasseId: z.string().uuid(), token: z.string().uuid() })

export const buchungRoute: FastifyPluginAsync<BuchungRouteOptions> = async (fastify, opts) => {
  // ---- GET /buchung/:kasseId ----
  fastify.get('/buchung/:kasseId', async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    try {
      const info = await ladeOnlineBuchungInfo(opts.db, p.data.kasseId)
      return reply.send(info)
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  // ---- GET /buchung/:kasseId/tische — freie, online freigegebene Tische ----
  // Öffentlich (wie das Buchungsformular selbst): liefert NUR freigegebene und
  // im Zeitraum freie Tische, ohne Namen fremder Gäste.
  fastify.get('/buchung/:kasseId/tische', async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const q = z.object({
      datum:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      zeitVon:  z.string().regex(/^\d{2}:\d{2}$/),
      dauer:    z.coerce.number().int().min(15).max(720).default(90),
      personen: z.coerce.number().int().min(1).max(100).optional(),
    }).safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

    try {
      // Prüft zugleich, ob die Online-Buchung für diese Kasse aktiv ist
      await ladeOnlineBuchungInfo(opts.db, p.data.kasseId)
      const [kasse] = await opts.db
        .select({ mandantId: kassen.mandantId })
        .from(kassen).where(eq(kassen.id, p.data.kasseId)).limit(1)
      if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

      const alle = await listeTischVerfuegbarkeit(
        opts.db, kasse.mandantId, p.data.kasseId,
        q.data.datum, q.data.zeitVon, q.data.dauer,
        { nurOnline: true, ...(q.data.personen ? { minPlaetze: q.data.personen } : {}) },
      )
      // Nach außen nur freie Tische und ohne Belegt-Details
      return reply.send(alle.filter(t => t.frei).map(t => ({
        id: t.id, bezeichnung: t.bezeichnung, bereichName: t.bereichName, plaetze: t.plaetze,
      })))
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  // ---- POST /buchung/:kasseId ----
  fastify.post('/buchung/:kasseId', async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = OnlineBuchungInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const info = await ladeOnlineBuchungInfo(opts.db, p.data.kasseId)
      const res  = await erstelleOnlineReservierung(opts.db, p.data.kasseId, body.data)

      // Bestätigungs-E-Mail an Gast senden
      if (body.data.email && isEmailAktiv(opts.config)) {
        const baseUrl = (request.headers['x-forwarded-proto'] ?? 'https') +
          '://' + (request.headers['x-forwarded-host'] ?? request.hostname)
        const stornierUrl = `${baseUrl}/buchung?kasseId=${p.data.kasseId}&stornieren=${res.onlineToken}`

        sendeReservierungsBestaetigung(body.data.email, {
          firmenname:     info.firmenname,
          name:           body.data.name,
          datum:          body.data.datum,
          zeitVon:        body.data.zeitVon,
          dauer:          90,
          personenAnzahl: body.data.personenAnzahl,
          tischLabel:     null,
          notiz:          body.data.notiz ?? null,
          stornierUrl,
        }, opts.config).catch((err) => {
          fastify.log.warn({ err }, 'Reservierungs-E-Mail konnte nicht gesendet werden')
        })
      }

      return reply.status(201).send({
        id:          res.id,
        datum:       res.datum,
        zeitVon:     res.zeitVon,
        name:        res.name,
        onlineToken: res.onlineToken,
      })
    } catch (err) {
      // Doppelbelegung / nicht freigegebener Tisch kommen als ReservierungError
      if (err instanceof ReservierungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      const msg    = err instanceof Error ? err.message : 'Fehler'
      const status = msg.includes('nicht gefunden') ? 404
        : msg.includes('nicht aktiviert') ? 403
        : 500
      return reply.status(status).send({ fehler: msg })
    }
  })

  // ---- POST /buchung/:kasseId/stornieren/:token ----
  fastify.post('/buchung/:kasseId/stornieren/:token', async (request, reply) => {
    const p = StorniereParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Parameter' })

    try {
      await storniereViaToken(opts.db, p.data.kasseId, p.data.token)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      const msg    = err instanceof Error ? err.message : 'Fehler'
      const status = msg.includes('nicht gefunden') ? 404 : 409
      return reply.status(status).send({ fehler: msg })
    }
  })
}
