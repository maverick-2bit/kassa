/**
 * KDS-Routen für das Browser-basierte Küchen-Display.
 *
 *   GET  /api/kds/events?station=kueche&token=<jwt>   SSE-Stream
 *   GET  /api/kds/bons?station=kueche                 Aktive Bons laden
 *   GET  /api/kds/kassen                              Kassen-Liste (für Chat-Targeting)
 *   POST /api/kds/bon/:id/erledigt                    Bon abschließen
 *   POST /api/kds/bon/:id/teilbon                     Teilbon
 *   POST /api/kds/nachricht                           Nachricht an Kellner
 */

import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { onKdsEvent, emitKdsEvent } from '../sse/kds-event-bus.js'
import { emitKasseEvent } from '../sse/event-bus.js'
import { kassen, kdsBons } from '../db/schema.js'
import {
  kdsOffeneBons,
  kdsUebersicht,
  kdsBonErledigt,
  kdsBonTeilbon,
  kdsArchivBons,
  kdsBonNachdrucken,
} from '../services/kds/kds-store.service.js'
import { sbAutoBereitNachBonErledigt } from '../services/sb-bestellung.service.js'

export interface KdsRouteOptions { db: Db }

const IdParam          = z.object({ id: z.string().uuid() })
const StationQuery     = z.object({ station: z.string().min(1) })
const ArchivQuery      = z.object({
  station: z.string().optional(),
  limit:   z.coerce.number().int().min(1).max(200).default(50),
  offset:  z.coerce.number().int().min(0).default(0),
})
const TeilbonBody      = z.object({
  positionsMengen: z.array(z.object({
    id:    z.string().uuid(),
    menge: z.number().int().positive().max(999),
  })).min(1).refine(
    arr => new Set(arr.map(p => p.id)).size === arr.length,
    { message: 'Doppelte positionId' },
  ),
})
const NachrichtBody    = z.object({
  text:     z.string().min(1).max(500),
  station:  z.string().min(1),
  /** Leer = Broadcast an alle Kassen des Mandanten */
  kasseIds: z.array(z.string().uuid()).default([]),
})
const AntwortBody      = z.object({
  text:    z.string().min(1).max(500),
  /** Station, an die geantwortet wird (aus dem Original-Event) */
  station: z.string().min(1),
})

export const kdsRoute: FastifyPluginAsync<KdsRouteOptions> = async (fastify, opts) => {

  /**
   * SB-Auto-„bereit": Bon gehört zu einer Terminal-Bestellung und ALLE ihre
   * Bons sind erledigt → Bestellung springt am Abholmonitor auf „bereit".
   */
  const pruefeSbBereit = async (bonId: string, mandantId: string): Promise<void> => {
    const [bon] = await opts.db
      .select({ sbBestellungId: kdsBons.sbBestellungId })
      .from(kdsBons)
      .where(eq(kdsBons.id, bonId))
      .limit(1)
    if (bon?.sbBestellungId) {
      await sbAutoBereitNachBonErledigt(opts.db, bon.sbBestellungId, mandantId)
    }
  }

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

      await pruefeSbBereit(p.data.id, request.user.mandantId)

      return reply.send({ erfolgreich: true })
    },
  )

  // ── Antwort vom Kellner ans KDS ────────────────────────────────────────────
  fastify.post(
    '/kds/antwort',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const b = AntwortBody.safeParse(request.body)
      if (!b.success) return reply.status(400).send({ fehler: b.error.issues })

      // Kassen-Bezeichnung für die Anzeige im KDS ermitteln
      const identity = await opts.db
        .select({ kassenId: kassen.kassenId, bezeichnung: kassen.bezeichnung })
        .from(kassen)
        .where(eq(kassen.mandantId, request.user.mandantId))
        .limit(1)
      const kasseBezeichnung = identity[0]?.bezeichnung ?? identity[0]?.kassenId ?? 'Kasse'

      emitKdsEvent(request.user.mandantId, b.data.station, {
        typ:              'kellner_antwort',
        text:             b.data.text,
        kasseBezeichnung,
        zeit:             new Date().toISOString(),
      })

      return reply.send({ erfolgreich: true })
    },
  )

  // ── Kassen-Liste für Chat-Targeting ────────────────────────────────────────
  fastify.get(
    '/kds/kassen',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const rows = await opts.db
        .select({ id: kassen.id, kassenId: kassen.kassenId, bezeichnung: kassen.bezeichnung })
        .from(kassen)
        .where(eq(kassen.mandantId, request.user.mandantId))
        .orderBy(kassen.kassenId)
      return reply.send(rows)
    },
  )

  // ── Nachricht an Kellner senden ────────────────────────────────────────────
  fastify.post(
    '/kds/nachricht',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const b = NachrichtBody.safeParse(request.body)
      if (!b.success) return reply.status(400).send({ fehler: b.error.issues })

      emitKasseEvent(request.user.mandantId, {
        typ:      'kds_nachricht',
        text:     b.data.text,
        station:  b.data.station,
        zeit:     new Date().toISOString(),
        kasseIds: b.data.kasseIds,
      })

      return reply.send({ erfolgreich: true })
    },
  )

  // ── Archiv ──────────────────────────────────────────────────────────────────
  fastify.get(
    '/kds/archiv',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const q = ArchivQuery.safeParse(request.query)
      if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

      const bons = await kdsArchivBons(
        opts.db,
        request.user.mandantId,
        q.data.station ?? null,
        q.data.limit,
        q.data.offset,
      )
      return reply.send(bons)
    },
  )

  // ── Nachdrucken ─────────────────────────────────────────────────────────────
  fastify.post(
    '/kds/bon/:id/nachdrucken',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const p = IdParam.safeParse(request.params)
      if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

      const ergebnis = await kdsBonNachdrucken(opts.db, p.data.id, request.user.mandantId)
      return reply.send(ergebnis)
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
        b.data.positionsMengen,
      )
      if (!result) return reply.status(404).send({ fehler: 'Bon nicht gefunden oder bereits erledigt' })

      // Teilbon kann den Bon vervollständigen → SB-Auto-„bereit" prüfen
      await pruefeSbBereit(p.data.id, request.user.mandantId)

      return reply.send({ erfolgreich: true })
    },
  )
}
