/**
 * Zeiterfassungs-Routen
 *
 *  POST /api/zeiterfassung/stempeln         (kein JWT — nur kasseId + PIN)
 *  GET  /api/zeiterfassung/aktuell          (JWT) — wer ist eingestempelt
 *  GET  /api/zeiterfassung                  (JWT) — Liste mit Filtern
 *  POST /api/zeiterfassung                  (JWT) — manueller Eintrag
 *  PATCH  /api/zeiterfassung/:id            (JWT)
 *  DELETE /api/zeiterfassung/:id            (JWT)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  ArbeitszeitInputSchema,
  ArbeitszeitUpdateSchema,
  StempelInputSchema,
} from '@kassa/shared'
import {
  stempeln,
  listeArbeitszeiten,
  erstelleArbeitszeit,
  aktualisiereArbeitszeit,
  loescheArbeitszeit,
  ladeAktuelleSchichten,
  ZeiterfassungError,
} from '../services/zeiterfassung.service.js'
import { getClientIp } from '../services/audit.service.js'
import { PinGesperrtError, sendePinGesperrt } from '../services/pin-bremse.js'
import { PinLaengeError, sendePinLaengeFehler } from '../services/pin-laenge.js'

export interface ZeiterfassungRouteOptions { db: Db }

const ListQuerySchema = z.object({
  kasseId:   z.string().uuid().optional(),
  userId:    z.string().uuid().optional(),
  datumVon:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  datumBis:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nurOffen:  z.enum(['true', 'false']).optional(),
  limit:     z.coerce.number().int().min(1).max(1000).optional(),
})

const IdParam = z.object({ id: z.string().uuid() })

export const zeiterfassungRoute: FastifyPluginAsync<ZeiterfassungRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  // ---- POST /zeiterfassung/stempeln (kein JWT, aber unter der PIN-Bremse) ----
  fastify.post('/zeiterfassung/stempeln', async (request, reply) => {
    const body = StempelInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const result = await stempeln(opts.db, body.data.kasseId, body.data.pin, {
        ...(body.data.geraetToken ? { geraetToken: body.data.geraetToken } : {}),
        geraetVertrauen: fastify.geraetVertrauen,
        ipAdresse:       getClientIp(request as Parameters<typeof getClientIp>[0]),
        userAgent:       (request.headers['user-agent'] as string | undefined) ?? null,
        log:             request.log,
      })
      return reply.send(result)
    } catch (err) {
      if (err instanceof PinGesperrtError) return sendePinGesperrt(reply, err)
      if (err instanceof PinLaengeError) return sendePinLaengeFehler(reply, err)
      if (err instanceof ZeiterfassungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ---- GET /zeiterfassung/aktuell ----
  fastify.get('/zeiterfassung/aktuell', guard, async (request, reply) => {
    const list = await ladeAktuelleSchichten(opts.db, request.user.mandantId)
    return reply.send(list)
  })

  // ---- GET /zeiterfassung ----
  fastify.get('/zeiterfassung', guard, async (request, reply) => {
    const q = ListQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

    const list = await listeArbeitszeiten(opts.db, request.user.mandantId, {
      ...(q.data.kasseId  !== undefined && { kasseId:  q.data.kasseId  }),
      ...(q.data.userId   !== undefined && { userId:   q.data.userId   }),
      ...(q.data.datumVon !== undefined && { datumVon: q.data.datumVon }),
      ...(q.data.datumBis !== undefined && { datumBis: q.data.datumBis }),
      ...(q.data.nurOffen !== undefined && { nurOffen: q.data.nurOffen === 'true' }),
      ...(q.data.limit    !== undefined && { limit:    q.data.limit    }),
    })
    return reply.send(list)
  })

  // ---- POST /zeiterfassung ----
  fastify.post('/zeiterfassung', guard, async (request, reply) => {
    const body = ArbeitszeitInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const res = await erstelleArbeitszeit(opts.db, request.user.mandantId, body.data)
      return reply.status(201).send(res)
    } catch (err) {
      if (err instanceof ZeiterfassungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ---- PATCH /zeiterfassung/:id ----
  fastify.patch('/zeiterfassung/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = ArbeitszeitUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const res = await aktualisiereArbeitszeit(opts.db, p.data.id, request.user.mandantId, body.data)
      return reply.send(res)
    } catch (err) {
      if (err instanceof ZeiterfassungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ---- DELETE /zeiterfassung/:id ----
  fastify.delete('/zeiterfassung/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    try {
      await loescheArbeitszeit(opts.db, p.data.id, request.user.mandantId)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof ZeiterfassungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
