/**
 * SB-Terminal-Routen (öffentlich — kein JWT; Gating über das Mandanten-Modul).
 *
 *   GET  /api/terminal/sortiment?kasseId=        — Terminal-sichtbares Sortiment
 *   POST /api/terminal/bestellung                — Bestellung anlegen (startet Kartenzahlung)
 *   GET  /api/terminal/bestellung/:id            — Status-Poll (finalisiert idempotent bei Zahlungserfolg)
 *   POST /api/terminal/bestellung/:id/bestaetigen — Demo-Zahlung bestätigen (nur Kassen ohne ZVT)
 *   POST /api/terminal/bestellung/:id/abbrechen  — Zahlung/Bestellung abbrechen
 *   GET  /sse/abholung?kasseId=                  — Abholmonitor-Stream (Snapshot + Updates)
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TerminalBestellungInputSchema } from '@kassa/shared'
import {
  SbBestellungError,
  bestaetigeDemoZahlung,
  bricheSbBestellungAb,
  erstelleSbBestellung,
  heutigeAbholungEintraege,
  holeSbBestellungStatus,
  holeTerminalSortiment,
  ladeTerminalKasse,
  type SbServiceDeps,
} from '../services/sb-bestellung.service.js'
import { ZvtError } from '../services/zvt/zvt.service.js'
import { onAbholungEvent } from '../sse/abholung-event-bus.js'

export interface TerminalRouteOptions { deps: SbServiceDeps }

const KasseQuery = z.object({ kasseId: z.string().uuid() })
const IdParam    = z.object({ id: z.string().uuid() })

function fehlerAntwort(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, err: unknown): unknown {
  if (err instanceof SbBestellungError) return reply.status(err.httpStatus).send({ fehler: err.message })
  if (err instanceof ZvtError)          return reply.status(err.httpStatus).send({ fehler: err.message })
  throw err
}

export async function registerTerminalRoutes(fastify: FastifyInstance, opts: TerminalRouteOptions): Promise<void> {
  const { deps } = opts

  // ── GET /api/terminal/sortiment ─────────────────────────────────────────────
  fastify.get('/api/terminal/sortiment', async (request, reply) => {
    const q = KasseQuery.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: 'kasseId fehlt oder ungültig' })
    try {
      return reply.send(await holeTerminalSortiment(deps.db, q.data.kasseId))
    } catch (err) {
      return fehlerAntwort(reply, err)
    }
  })

  // ── POST /api/terminal/bestellung ───────────────────────────────────────────
  fastify.post('/api/terminal/bestellung', async (request, reply) => {
    const b = TerminalBestellungInputSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      return reply.status(201).send(await erstelleSbBestellung(b.data, deps))
    } catch (err) {
      return fehlerAntwort(reply, err)
    }
  })

  // ── GET /api/terminal/bestellung/:id ────────────────────────────────────────
  fastify.get('/api/terminal/bestellung/:id', async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await holeSbBestellungStatus(p.data.id, deps))
    } catch (err) {
      return fehlerAntwort(reply, err)
    }
  })

  // ── POST /api/terminal/bestellung/:id/bestaetigen (Demo-Modus) ─────────────
  fastify.post('/api/terminal/bestellung/:id/bestaetigen', async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await bestaetigeDemoZahlung(p.data.id, deps))
    } catch (err) {
      return fehlerAntwort(reply, err)
    }
  })

  // ── POST /api/terminal/bestellung/:id/abbrechen ────────────────────────────
  fastify.post('/api/terminal/bestellung/:id/abbrechen', async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await bricheSbBestellungAb(p.data.id, deps))
    } catch (err) {
      return fehlerAntwort(reply, err)
    }
  })

  // ── GET /sse/abholung?kasseId — Abholmonitor (öffentlich) ──────────────────
  fastify.get<{ Querystring: { kasseId?: string } }>(
    '/sse/abholung',
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
      if (!kasseId || !z.string().uuid().safeParse(kasseId).success) {
        return reply.status(400).send({ fehler: 'kasseId fehlt oder ungültig' })
      }

      // Kasse → Mandant auflösen + Modul-Gating (der Monitor zeigt alle SB-Bestellungen des Mandanten)
      let mandantId: string
      try {
        const kasse = await ladeTerminalKasse(deps.db, kasseId)
        mandantId = kasse.mandantId
      } catch (err) {
        return fehlerAntwort(reply, err)
      }

      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type':      'text/event-stream; charset=utf-8',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      raw.flushHeaders()

      // Initialer Snapshot (heutige offene + bereite Bestellungen)
      const snapshot = await heutigeAbholungEintraege(deps.db, mandantId)
      raw.write(`data: ${JSON.stringify({ typ: 'snapshot', bestellungen: snapshot })}\n\n`)

      const heartbeat   = setInterval(() => raw.write(': heartbeat\n\n'), 25_000)
      const unsubscribe = onAbholungEvent(mandantId, (ev) => {
        raw.write(`data: ${JSON.stringify(ev)}\n\n`)
      })

      const cleanup = () => { clearInterval(heartbeat); unsubscribe() }
      request.raw.on('close', cleanup)
      request.raw.on('error', cleanup)

      await new Promise<void>(resolve => {
        request.raw.on('close', resolve)
        request.raw.on('error', resolve)
      })
      return reply
    },
  )
}
