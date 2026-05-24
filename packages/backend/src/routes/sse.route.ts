/**
 * SSE-Route: GET /sse/events?token=<jwt>
 *
 * EventSource im Browser kann keine Authorization-Header senden,
 * daher JWT als Query-Parameter. Der Token wird serverseitig verifiziert.
 */

import type { FastifyPluginAsync } from 'fastify'
import { onKasseEvent } from '../sse/event-bus.js'

export const sseRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { token?: string } }>(
    '/sse/events',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const token = request.query.token
      if (!token) {
        return reply.status(401).send({ fehler: 'Token fehlt' })
      }

      let payload: { mandantId: string }
      try {
        payload = fastify.jwt.verify<{ mandantId: string }>(token)
      } catch {
        return reply.status(401).send({ fehler: 'Token ungültig' })
      }

      const { mandantId } = payload

      // SSE-Header setzen — Fastify-reply nicht serialisieren
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type':  'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection:      'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      raw.flushHeaders()

      // Heartbeat alle 25s um Proxies/Load-Balancer-Timeouts zu verhindern
      const heartbeat = setInterval(() => {
        raw.write(': heartbeat\n\n')
      }, 25_000)

      const unsubscribe = onKasseEvent(mandantId, (event) => {
        raw.write(`data: ${JSON.stringify(event)}\n\n`)
      })

      const cleanup = () => {
        clearInterval(heartbeat)
        unsubscribe()
      }

      request.raw.on('close', cleanup)
      request.raw.on('error', cleanup)

      // Reply nie beenden — Verbindung bleibt offen bis Client disconnect
      await new Promise<void>((resolve) => {
        request.raw.on('close', resolve)
        request.raw.on('error', resolve)
      })
    },
  )
}
