/**
 * Einlass — Routen für die Scanner-Geräte (NUR Einlass-Geräte-Token).
 *
 *  GET  /einlass/ich                      Gerät + Firmenname (Kopfzeile der App)
 *  GET  /einlass/events                   Events mit Einlass (Test/veröffentlicht, laufend/kommend)
 *  GET  /einlass/events/:eventId/stand    Besucherzahl & Co. (Mehrfachtickets einmal gezählt)
 *  POST /einlass/scan                     QR-Inhalt/Code prüfen und atomar einlösen
 *  GET  /einlass/events/:eventId/offline-liste[?seit=]  Tickets für den Offline-Betrieb (Codes nur als Hash)
 *  POST /einlass/sync                     offline entschiedene Scans nachreichen (wiederholbar)
 *
 * Der Geräte-Token wird bei jedem Aufruf gegen einlass_geraete geprüft — ein
 * gesperrtes Gerät (verlorenes Handy) ist sofort draußen, obwohl sein Token
 * noch gültig signiert ist.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { EinlassScanInputSchema, EinlassSyncInputSchema, type EinlassIch } from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { EinlassGeraetRow } from '../db/schema.js'
import {
  EinlassError,
  holeFirmenname,
  holeOfflineListe,
  listeEinlassEvents,
  pruefeGeraet,
  scanne,
  synchronisiere,
} from '../services/einlass.service.js'
import { TicketError, holeEinlassStand, ladeBaender, ladeEvent } from '../services/ticket.service.js'

export interface EinlassRouteOptions { db: Db }

const EventParam = z.object({ eventId: z.string().uuid() })
const SeitQuery  = z.object({ seit: z.string().datetime({ offset: true }).optional() })

/**
 * Limit JE GERÄT: alle Scanner kommen über denselben nginx — ohne eigenen
 * Schlüssel teilten sie sich einen Zähler und bremsten sich am Einlass-Ansturm
 * gegenseitig aus. Der globale Schlüssel zählt je GEPRÜFTEM Geräte-Token
 * (auth/rate-limit.ts). 600/min (10 pro Sekunde) je Gerät ist weit über jedem
 * menschlichen Scan-Tempo, bremst aber einen Amoklauf.
 */
const geraeteLimit = { max: 600, timeWindow: '1 minute' }

export const einlassRoute: FastifyPluginAsync<EinlassRouteOptions> = async (fastify, opts) => {
  const { db } = opts
  const geraete = new WeakMap<FastifyRequest, EinlassGeraetRow>()

  async function nurEinlassGeraet(request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ fehler: 'Gerät nicht angemeldet — bitte neu einrichten' })
    }
    if (request.user.typ !== 'einlass_geraet') {
      return reply.status(403).send({ fehler: 'Nur für Einlass-Geräte' })
    }
    try {
      geraete.set(request, await pruefeGeraet(db, request.user.sub, request.user.mandantId))
    } catch (err) {
      if (err instanceof EinlassError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  }
  const guard = { onRequest: [nurEinlassGeraet], config: { rateLimit: geraeteLimit } }
  const geraetVon = (request: FastifyRequest): EinlassGeraetRow => geraete.get(request)!

  fastify.get('/einlass/ich', guard, async (request) => {
    const g = geraetVon(request)
    const antwort: EinlassIch = { geraet: { id: g.id, name: g.name }, firmenname: await holeFirmenname(db, g.mandantId) }
    return antwort
  })

  fastify.get('/einlass/events', guard, async (request) =>
    listeEinlassEvents(db, geraetVon(request).mandantId))

  fastify.get('/einlass/events/:eventId/stand', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      const event = await ladeEvent(db, geraetVon(request).mandantId, p.data.eventId)
      return await holeEinlassStand(db, event, await ladeBaender(db, event.id))
    } catch (err) {
      if (err instanceof TicketError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/einlass/scan', guard, async (request, reply) => {
    const body = EinlassScanInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      return await scanne(db, geraetVon(request), body.data)
    } catch (err) {
      if (err instanceof TicketError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ---- Offline-Einlass ----
  fastify.get('/einlass/events/:eventId/offline-liste', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    const q = SeitQuery.safeParse(request.query)
    if (!p.success || !q.success) return reply.status(400).send({ fehler: 'Ungültige Anfrage' })
    try {
      const liste = await holeOfflineListe(db, geraetVon(request), p.data.eventId, q.data.seit ? new Date(q.data.seit) : null)
      return reply.header('Cache-Control', 'no-store').send(liste)
    } catch (err) {
      if (err instanceof TicketError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/einlass/sync', guard, async (request, reply) => {
    const body = EinlassSyncInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      return await synchronisiere(db, geraetVon(request), body.data)
    } catch (err) {
      if (err instanceof TicketError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
