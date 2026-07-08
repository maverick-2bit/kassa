/**
 * Kundendisplay-Routen.
 *
 *   POST /api/display          — Kassafrontend pusht Warenkorb-State (JWT-geschützt)
 *   GET  /sse/display?kasseId  — SSE-Stream für das Kundendisplay (öffentlich)
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { emitDisplayEvent, onDisplayEvent, type DisplayEvent } from '../sse/display-event-bus.js'

const DisplayPositionSchema = z.object({
  bezeichnung: z.string(),
  menge:       z.number().int().positive(),
  preisCent:   z.number().int(),
})

const DisplayPushSchema = z.object({
  kasseId: z.string().uuid(),
  event:   z.discriminatedUnion('typ', [
    z.object({
      typ:        z.literal('warenkorb'),
      positionen: z.array(DisplayPositionSchema),
      summeCent:  z.number().int(),
    }),
    z.object({
      typ:         z.literal('beleg_erstellt'),
      belegNummer: z.number().int(),
      summeCent:   z.number().int(),
      belegId:     z.string().uuid().optional(),
    }),
    z.object({ typ: z.literal('leer') }),
  ]),
})

export async function registerDisplayRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /api/display — Kassafrontend → Display ────────────────────────────
  fastify.post(
    '/api/display',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = DisplayPushSchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

      emitDisplayEvent(parsed.data.kasseId, parsed.data.event as DisplayEvent)
      return reply.send({ ok: true })
    },
  )

  // ── GET /sse/display?kasseId — Display → SSE ───────────────────────────────
  fastify.get<{ Querystring: { kasseId?: string } }>(
    '/sse/display',
    {
      schema: {
        querystring: {
          type:       'object',
          properties: { kasseId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { kasseId } = request.query
      if (!kasseId) return reply.status(400).send({ fehler: 'kasseId fehlt' })

      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type':      'text/event-stream; charset=utf-8',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      raw.flushHeaders()

      // Initiales Leer-Event
      raw.write(`data: ${JSON.stringify({ typ: 'leer' })}\n\n`)

      const heartbeat   = setInterval(() => raw.write(': heartbeat\n\n'), 25_000)
      const unsubscribe = onDisplayEvent(kasseId, (ev) => {
        raw.write(`data: ${JSON.stringify(ev)}\n\n`)
      })

      const cleanup = () => { clearInterval(heartbeat); unsubscribe() }
      request.raw.on('close', cleanup)
      request.raw.on('error', cleanup)

      await new Promise<void>(resolve => {
        request.raw.on('close', resolve)
        request.raw.on('error', resolve)
      })
    },
  )
}
