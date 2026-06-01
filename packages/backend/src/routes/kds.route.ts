/**
 * KDS-Routen für das Browser-basierte Küchen-Display.
 *
 *   GET  /api/kds/events?station=kueche&token=<jwt>   SSE-Stream
 *   GET  /api/kds/bons?station=kueche                 Aktive Bons laden
 *   POST /api/kds/bon/:id/erledigt                    Bon abschließen
 *   POST /api/kds/bon/:id/teilbon                     Teilbon
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { onKdsEvent } from '../sse/kds-event-bus.js'
import {
  kdsOffeneBons,
  kdsUebersicht,
  kdsBonErledigt,
  kdsBonTeilbon,
} from '../services/kds/kds-store.service.js'

export interface KdsRouteOptions { db: Db }

const IdParam          = z.object({ id: z.string().uuid() })
const StationQuery     = z.object({ station: z.string().min(1) })
const TeilbonBody      = z.object({ positionIds: z.array(z.string().uuid()).min(1) })

export const kdsRoute: FastifyPluginAsync<KdsRouteOptions> = async (fastify, opts) => {

  // ── SSE-Stream ──────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { station?: string; token?: string } }>(
    '/kds/events',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            station: { type: 'string' },
            token:   { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { token, station } = request.query

      if (!token)   return reply.status(401).send({ fehler: 'Token fehlt' })
      if (!station) return reply.status(400).send({ fehler: 'Station fehlt' })

      let payload: { mandantId: string }
      try {
        payload = fastify.jwt.verify<{ mandantId: string }>(token)
      } catch {
        return reply.status(401).send({ fehler: 'Token ungültig' })
      }

      const { mandantId } = payload

      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type':     'text/event-stream; charset=utf-8',
        'Cache-Control':    'no-cache, no-transform',
        'Connection':       'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      raw.flushHeaders()

      // Snapshot: alle aktuell offenen Bons dieser Station senden
      const bons = await kdsOffeneBons(opts.db, mandantId, station)
      raw.write(`data: ${JSON.stringify({ typ: 'snapshot', bons })}\n\n`)

      // Heartbeat
      const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), 25_000)

      // KDS-Events dieser Station abonnieren
      const unsubscribe = onKdsEvent(mandantId, station, (event) => {
        raw.write(`data: ${JSON.stringify(event)}\n\n`)
      })

      const cleanup = () => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      request.raw.on('close', cleanup)
      request.raw.on('error', cleanup)

      await new Promise<void>(resolve => {
        request.raw.on('close', resolve)
        request.raw.on('error', resolve)
      })
    },
  )

  // ── Dashboard-Übersicht ────────────────────────────────────────────────────
  fastify.get(
    '/kds/uebersicht',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const data = await kdsUebersicht(opts.db, request.user.mandantId)
      return reply.send(data)
    },
  )

  // ── Aktive Bons laden ───────────────────────────────────────────────────────
  fastify.get(
    '/kds/bons',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const q = StationQuery.safeParse(request.query)
      if (!q.success) return reply.status(400).send({ fehler: 'Station fehlt oder ungültig' })

      const bons = await kdsOffeneBons(opts.db, request.user.mandantId, q.data.station)
      return reply.send(bons)
    },
  )

  // ── Bon erledigt ────────────────────────────────────────────────────────────
  fastify.post(
    '/kds/bon/:id/erledigt',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const p = IdParam.safeParse(request.params)
      if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

      const ok = await kdsBonErledigt(opts.db, p.data.id, request.user.mandantId)
      if (!ok) return reply.status(404).send({ fehler: 'Bon nicht gefunden oder bereits erledigt' })

      return reply.send({ erfolgreich: true })
    },
  )

  // ── Teilbon ─────────────────────────────────────────────────────────────────
  fastify.post(
    '/kds/bon/:id/teilbon',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const p = IdParam.safeParse(request.params)
      if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

      const b = TeilbonBody.safeParse(request.body)
      if (!b.success) return reply.status(400).send({ fehler: b.error.issues })

      const result = await kdsBonTeilbon(
        opts.db,
        p.data.id,
        request.user.mandantId,
        b.data.positionIds,
      )
      if (!result) return reply.status(404).send({ fehler: 'Bon nicht gefunden oder bereits erledigt' })

      return reply.send({ erfolgreich: true })
    },
  )
}
