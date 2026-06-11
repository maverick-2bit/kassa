/**
 * Reservierungs-Routen (authentifiziert)
 *
 *  GET    /api/reservierungen?kasseId=&datumVon=&datumBis=&limit=
 *  POST   /api/reservierungen
 *  PATCH  /api/reservierungen/:id
 *    → Sendet Bestätigungs-E-Mail wenn status='bestaetigt' und E-Mail vorhanden
 *  DELETE /api/reservierungen/:id
 *
 *  GET    /api/kassen/:kasseId/online-buchung
 *  PATCH  /api/kassen/:kasseId/online-buchung
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { kassen, mandanten } from '../db/schema.js'
import { ReservierungInputSchema, ReservierungUpdateSchema } from '@kassa/shared'
import {
  erstelleReservierung,
  listeReservierungen,
  aktualisiereReservierung,
  loescheReservierung,
} from '../services/reservierung.service.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import {
  isEmailAktiv,
  sendeReservierungsBestaetigung,
} from '../services/email.service.js'

export interface ReservierungRouteOptions { db: Db; config: Config }

const ListQuerySchema = z.object({
  kasseId:  z.string().uuid().optional(),
  datumVon: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  datumBis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit:    z.coerce.number().int().min(1).max(1000).optional(),
})

const IdParam    = z.object({ id: z.string().uuid() })
const KasseParam = z.object({ kasseId: z.string().uuid() })

export const reservierungRoute: FastifyPluginAsync<ReservierungRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  // ---- GET /reservierungen ----
  fastify.get('/reservierungen', guard, async (request, reply) => {
    const q = ListQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

    if (q.data.kasseId) {
      const ok = await pruefeKasseGehoertZuMandant(opts.db, q.data.kasseId, request.user.mandantId)
      if (!ok) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const liste = await listeReservierungen(opts.db, request.user.mandantId, {
      ...(q.data.kasseId  !== undefined && { kasseId:  q.data.kasseId  }),
      ...(q.data.datumVon !== undefined && { datumVon: q.data.datumVon }),
      ...(q.data.datumBis !== undefined && { datumBis: q.data.datumBis }),
      ...(q.data.limit    !== undefined && { limit:    q.data.limit    }),
    })
    return reply.send(liste)
  })

  // ---- POST /reservierungen ----
  fastify.post('/reservierungen', guard, async (request, reply) => {
    const body = ReservierungInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const res = await erstelleReservierung(opts.db, request.user.mandantId, body.data)
      return reply.status(201).send(res)
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  // ---- PATCH /reservierungen/:id ----
  fastify.patch('/reservierungen/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = ReservierungUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const res = await aktualisiereReservierung(opts.db, p.data.id, request.user.mandantId, body.data)

      // Bestätigungs-E-Mail versenden wenn Status auf 'bestaetigt' gesetzt wird
      if (body.data.status === 'bestaetigt' && res.email && isEmailAktiv(opts.config)) {
        const [mandant] = await opts.db.select({ firmenname: mandanten.firmenname }).from(mandanten).where(eq(mandanten.id, request.user.mandantId)).limit(1)

        if (mandant) {
          sendeReservierungsBestaetigung(res.email, {
            firmenname:     mandant.firmenname,
            name:           res.name,
            datum:          res.datum,
            zeitVon:        res.zeitVon,
            dauer:          res.dauer,
            personenAnzahl: res.personenAnzahl,
            tischLabel:     res.tischLabel ?? null,
            notiz:          res.notiz ?? null,
          }, opts.config).catch((err) => {
            fastify.log.warn({ err }, 'Reservierungs-Bestätigungs-E-Mail konnte nicht gesendet werden')
          })
        }
      }

      return reply.send(res)
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  // ---- DELETE /reservierungen/:id ----
  fastify.delete('/reservierungen/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    try {
      await loescheReservierung(opts.db, p.data.id, request.user.mandantId)
      return reply.status(204).send()
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  // ---- GET /kassen/:kasseId/online-buchung ----
  fastify.get('/kassen/:kasseId/online-buchung', guard, async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [kasse] = await opts.db
      .select({ onlineBuchungAktiv: kassen.onlineBuchungAktiv })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const baseUrl = (request.headers['x-forwarded-proto'] ?? 'https') +
      '://' + (request.headers['x-forwarded-host'] ?? request.hostname)

    return reply.send({
      onlineBuchungAktiv: kasse.onlineBuchungAktiv,
      buchungUrl: `${baseUrl}/buchung?kasseId=${p.data.kasseId}`,
    })
  })

  // ---- PATCH /kassen/:kasseId/online-buchung ----
  fastify.patch('/kassen/:kasseId/online-buchung', guard, async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = z.object({ aktiv: z.boolean() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [updated] = await opts.db
      .update(kassen)
      .set({ onlineBuchungAktiv: body.data.aktiv, updatedAt: new Date() })
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .returning({ onlineBuchungAktiv: kassen.onlineBuchungAktiv })

    if (!updated) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const baseUrl = (request.headers['x-forwarded-proto'] ?? 'https') +
      '://' + (request.headers['x-forwarded-host'] ?? request.hostname)

    return reply.send({
      onlineBuchungAktiv: updated.onlineBuchungAktiv,
      buchungUrl: `${baseUrl}/buchung?kasseId=${p.data.kasseId}`,
    })
  })

  // ---- GET /kassen/:kasseId/self-checkout ----
  fastify.get('/kassen/:kasseId/self-checkout', guard, async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [kasse] = await opts.db
      .select({ selfCheckoutAktiv: kassen.selfCheckoutAktiv })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const baseUrl = (request.headers['x-forwarded-proto'] ?? 'https') +
      '://' + (request.headers['x-forwarded-host'] ?? request.hostname)

    return reply.send({
      selfCheckoutAktiv: kasse.selfCheckoutAktiv,
      selfCheckoutUrl:   `${baseUrl}/selfcheckout?kasseId=${p.data.kasseId}`,
    })
  })

  // ---- PATCH /kassen/:kasseId/self-checkout ----
  fastify.patch('/kassen/:kasseId/self-checkout', guard, async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = z.object({ aktiv: z.boolean() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [updated] = await opts.db
      .update(kassen)
      .set({ selfCheckoutAktiv: body.data.aktiv, updatedAt: new Date() })
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .returning({ selfCheckoutAktiv: kassen.selfCheckoutAktiv })

    if (!updated) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    return reply.send({ selfCheckoutAktiv: updated.selfCheckoutAktiv })
  })

  // ---- GET /kassen/:kasseId/abschluss-email ----
  fastify.get('/kassen/:kasseId/abschluss-email', guard, async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const [kasse] = await opts.db
      .select({ abschlussEmail: kassen.abschlussEmail })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    return reply.send({ abschlussEmail: kasse.abschlussEmail })
  })

  // ---- PATCH /kassen/:kasseId/abschluss-email ----
  fastify.patch('/kassen/:kasseId/abschluss-email', guard, async (request, reply) => {
    const p = KasseParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = z.object({ abschlussEmail: z.string().email().nullable() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [updated] = await opts.db
      .update(kassen)
      .set({ abschlussEmail: body.data.abschlussEmail, updatedAt: new Date() })
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .returning({ abschlussEmail: kassen.abschlussEmail })

    if (!updated) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    return reply.send({ abschlussEmail: updated.abschlussEmail })
  })
}
