/**
 * Ticketshop — Kauf (öffentlich, kein Login). Die Ticket-App leitet nur
 * `/api/ticketshop/` an das Backend weiter; alle Routen liegen darunter.
 *
 *  GET  /ticketshop/veranstalter/:mandantId      kommende Events eines Veranstalters
 *  GET  /ticketshop/events/:eventId              Eventseite: Ticketarten + Verfügbarkeit
 *  POST /ticketshop/bestellungen                 bestellen → Stripe-Bezahlseite
 *  GET  /ticketshop/bestellungen/:id             Bestellstand (nach der Rückkehr von Stripe)
 *  POST /ticketshop/bestellungen/:id/abbrechen   Zahlung abgebrochen → Tickets sofort frei
 *  GET  /ticketshop/bestellungen/:id/pdf         alle Tickets der Bestellung als PDF
 *  GET  /ticketshop/bestellungen/:id/rechnung    Rechnung als A4-HTML (drucken/speichern)
 *
 * Wie bei der Gast-Bestellung schützt die nicht erratbare Bestell-ID (UUID v4)
 * die Bestellseite — sie steht nur in der Rücksprung-Adresse und der E-Mail.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ShopBestellungInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import type { BelegServiceDeps } from '../services/beleg.service.js'
import { getClientIp } from '../services/audit.service.js'
import { erzeugeTicketPdf } from '../services/ticket-pdf.service.js'
import { holeTicketDruckdaten } from '../services/ticket.service.js'
import {
  TicketShopError,
  brecheShopBestellungAb,
  erstelleShopBestellung,
  holeBestellRechnungHtml,
  holeShopBestellung,
  holeShopEvent,
  holeVeranstalter,
  type ShopStripe,
  type TicketShopDeps,
} from '../services/ticketshop.service.js'

export interface TicketverkaufRouteOptions {
  db:        Db
  config:    Config
  belegDeps: BelegServiceDeps
  /** Nur Tests: Stripe ersetzen */
  stripe?:   ShopStripe
}

const IdParam          = z.object({ id: z.string().uuid() })
const EventParam       = z.object({ eventId: z.string().uuid() })
const VeranstalterParam = z.object({ mandantId: z.string().uuid() })

/**
 * Limit je Gast (Client-IP), nicht je nginx — sonst teilten sich alle Käufer
 * einen Zähler. In Tests (ein Absender für alles) praktisch aus, wie global.
 */
const limitFuer = (config: Config) => (max: number) => ({
  config: { rateLimit: {
    max: config.NODE_ENV === 'test' ? 10_000 : max,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => `shop:${getClientIp(req)}`,
  } },
})

/** Adresse der Ticket-App aus der Anfrage (hinter nginx/Caddy) — für den Rücksprung von Stripe. */
function basisAusAnfrage(request: FastifyRequest): string {
  const erster = (wert: string | string[] | undefined): string | undefined => {
    const text = (Array.isArray(wert) ? wert[0] : wert)?.split(',')[0]?.trim()
    return text ? text : undefined
  }
  const proto = erster(request.headers['x-forwarded-proto']) ?? request.protocol
  const host  = erster(request.headers['x-forwarded-host']) ?? erster(request.headers.host) ?? request.hostname
  return `${proto}://${host}`
}

function fehler(reply: FastifyReply, err: unknown) {
  if (err instanceof TicketShopError) return reply.status(err.httpStatus).send({ fehler: err.message })
  throw err
}

export const ticketverkaufRoute: FastifyPluginAsync<TicketverkaufRouteOptions> = async (fastify, opts) => {
  const deps: TicketShopDeps = {
    db: opts.db, config: opts.config, belegDeps: opts.belegDeps, ...(opts.stripe ? { stripe: opts.stripe } : {}),
  }
  const limit = limitFuer(opts.config)

  fastify.get('/ticketshop/veranstalter/:mandantId', limit(60), async (request, reply) => {
    const p = VeranstalterParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Veranstalter nicht gefunden' })
    try { return await holeVeranstalter(deps, p.data.mandantId) } catch (err) { return fehler(reply, err) }
  })

  fastify.get('/ticketshop/events/:eventId', limit(60), async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Event nicht gefunden' })
    try {
      // Verfügbarkeit ändert sich laufend — nie zwischenspeichern
      return reply.header('Cache-Control', 'no-store').send(await holeShopEvent(deps, p.data.eventId))
    } catch (err) { return fehler(reply, err) }
  })

  fastify.post('/ticketshop/bestellungen', limit(10), async (request, reply) => {
    const body = ShopBestellungInputSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ fehler: body.error.issues[0]?.message ?? 'Ungültige Eingabe', details: body.error.issues })
    }
    try {
      const antwort = await erstelleShopBestellung(deps, body.data, basisAusAnfrage(request))
      return reply.status(201).send(antwort)
    } catch (err) {
      if (err instanceof TicketShopError) return fehler(reply, err)
      request.log.error({ err }, 'Ticket-Bestellung fehlgeschlagen')
      return reply.status(502).send({ fehler: 'Die Bezahlung konnte nicht gestartet werden. Bitte später erneut versuchen.' })
    }
  })

  fastify.get('/ticketshop/bestellungen/:id', limit(120), async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Bestellung nicht gefunden' })
    try {
      return reply.header('Cache-Control', 'no-store').send(await holeShopBestellung(deps, p.data.id))
    } catch (err) { return fehler(reply, err) }
  })

  fastify.post('/ticketshop/bestellungen/:id/abbrechen', limit(20), async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Bestellung nicht gefunden' })
    try { return await brecheShopBestellungAb(deps, p.data.id) } catch (err) { return fehler(reply, err) }
  })

  fastify.get('/ticketshop/bestellungen/:id/pdf', limit(30), async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Bestellung nicht gefunden' })
    try {
      const bestellung = await holeShopBestellung(deps, p.data.id)
      if (bestellung.tickets.length === 0) return reply.status(404).send({ fehler: 'Noch keine Tickets' })
      const daten = await holeTicketDruckdaten(opts.db, bestellung.tickets.map(t => t.code), basisAusAnfrage(request))
      const pdf = await erzeugeTicketPdf(daten)
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="Tickets-${bestellung.event.titel.replace(/[^\p{L}\p{N}]+/gu, '-')}.pdf"`)
        .header('Cache-Control', 'no-store')
        .send(pdf)
    } catch (err) { return fehler(reply, err) }
  })

  fastify.get('/ticketshop/bestellungen/:id/rechnung', limit(30), async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Rechnung nicht gefunden' })
    const html = await holeBestellRechnungHtml(deps, p.data.id)
    if (!html) return reply.status(404).send({ fehler: 'Rechnung nicht gefunden' })
    return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html)
  })
}
