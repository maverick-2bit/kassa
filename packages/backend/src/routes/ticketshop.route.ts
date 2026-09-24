/**
 * Ticketshop — öffentliche Routen (kein Login). Die Ticket-App leitet nur
 * `/api/ticketshop/` an das Backend weiter.
 *
 *  GET /ticketshop/ticket/:code       Ticket für die Ticketseite (ohne Geburtsdatum/E-Mail)
 *  GET /ticketshop/ticket/:code/pdf   dasselbe als A4-PDF
 *
 * Der Code ist nicht erratbar (≈ 79 Bit); das Rate-Limit bremst trotzdem
 * jedes massenhafte Durchprobieren.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { TICKET_CODE_REGEX } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { holeOeffentlichesTicket, holeTicketDruckdaten } from '../services/ticket.service.js'
import { erzeugeTicketPdf } from '../services/ticket-pdf.service.js'

export interface TicketshopRouteOptions { db: Db }

const CodeParam = z.object({ code: z.string().regex(TICKET_CODE_REGEX) })
const oeffentlichLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

/**
 * Adresse der Ticket-App aus der Anfrage (hinter nginx/Caddy) — Rückfall für den
 * QR-Inhalt im PDF, solange keine Ticket-Adresse eingerichtet ist.
 */
function basisAusAnfrage(request: FastifyRequest): string {
  // Leere Header zählen als „nicht gesetzt" — sonst entstünde „://host"
  const erster = (wert: string | string[] | undefined): string | undefined => {
    const text = (Array.isArray(wert) ? wert[0] : wert)?.split(',')[0]?.trim()
    return text ? text : undefined
  }
  const proto = erster(request.headers['x-forwarded-proto']) ?? request.protocol
  const host  = erster(request.headers['x-forwarded-host']) ?? erster(request.headers.host) ?? request.hostname
  return `${proto}://${host}`
}

export const ticketshopRoute: FastifyPluginAsync<TicketshopRouteOptions> = async (fastify, opts) => {
  fastify.get('/ticketshop/ticket/:code', oeffentlichLimit, async (request, reply) => {
    const p = CodeParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Ticket nicht gefunden' })
    const ticket = await holeOeffentlichesTicket(opts.db, p.data.code)
    if (!ticket) return reply.status(404).send({ fehler: 'Ticket nicht gefunden' })
    // Status ändert sich beim Einlass — nie zwischenspeichern
    return reply.header('Cache-Control', 'no-store').send(ticket)
  })

  fastify.get('/ticketshop/ticket/:code/pdf', oeffentlichLimit, async (request, reply) => {
    const p = CodeParam.safeParse(request.params)
    if (!p.success) return reply.status(404).send({ fehler: 'Ticket nicht gefunden' })
    const daten = await holeTicketDruckdaten(opts.db, [p.data.code], basisAusAnfrage(request))
    if (daten.length === 0) return reply.status(404).send({ fehler: 'Ticket nicht gefunden' })
    const pdf = await erzeugeTicketPdf(daten)
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="Ticket-${p.data.code}.pdf"`)
      .header('Cache-Control', 'no-store')
      .send(pdf)
  })
}
