/**
 * Ticketing — Backoffice-Routen (Berechtigung „tickets", Admins immer).
 *
 *  GET/PUT  /ticketing/einstellungen                 Ticket-Adresse (für Links/QR in E-Mails)
 *  GET/POST /ticketing/events                        Events auflisten / anlegen
 *  GET/PATCH/DELETE /ticketing/events/:eventId       Detail inkl. Bänder, Arten, Einlass-Stand
 *  PUT      /ticketing/events/:eventId/baender       Bänder komplett ersetzen
 *  POST     /ticketing/events/:eventId/arten         Ticketart anlegen
 *  PATCH/DELETE /ticketing/arten/:artId              Ticketart ändern / löschen
 *  GET      /ticketing/events/:eventId/tickets       Tickets (Suche ?suche=)
 *  POST     /ticketing/events/:eventId/tickets       Intern ausstellen (optional gleich senden)
 *  POST     /ticketing/tickets/:ticketId/stornieren
 *  POST     /ticketing/tickets/senden                Tickets per E-Mail verschicken
 *  GET      /ticketing/tickets/pdf?ids=a,b           PDF der gewählten Tickets
 *  GET/POST /ticketing/einlass-geraete               Scanner-Geräte auflisten / anlegen (Token + QR-Link)
 *  POST     /ticketing/einlass-geraete/:id/sperren   verlorenes Gerät sofort sperren
 *  GET      /ticketing/events/:eventId/einlass-log   Protokoll aller Scans
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  EinlassGeraetAnlegenSchema,
  TicketArtInputSchema,
  TicketArtUpdateSchema,
  TicketAusstellenInputSchema,
  TicketBaenderSetzenSchema,
  TicketEinstellungenSchema,
  TicketEventInputSchema,
  TicketEventUpdateSchema,
  type EinlassGeraetAngelegt,
  type TicketAusstellenAntwort,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import {
  TicketError,
  aktualisiereEvent,
  aktualisiereTicketArt,
  codesFuerTicketIds,
  erstelleEvent,
  erstelleTicketArt,
  holeEventDetail,
  holeTicketDruckdaten,
  holeTicketEinstellungen,
  listeEvents,
  listeTickets,
  loescheEvent,
  loescheTicketArt,
  setzeBaender,
  setzeTicketEinstellungen,
  stelleTicketsAus,
  storniereTicket,
} from '../services/ticket.service.js'
import { erzeugeTicketPdf } from '../services/ticket-pdf.service.js'
import { isEmailAktiv, sendeTicketEmail } from '../services/email.service.js'
import { getClientIp, logAudit } from '../services/audit.service.js'
import {
  EinlassError,
  legeGeraetAn,
  listeEinlassLog,
  listeGeraete,
  widerrufeGeraet,
} from '../services/einlass.service.js'

export interface TicketingRouteOptions { db: Db; config: Config }

const EventParam  = z.object({ eventId:  z.string().uuid() })
const ArtParam    = z.object({ artId:    z.string().uuid() })
const TicketParam = z.object({ ticketId: z.string().uuid() })
const GeraetParam = z.object({ geraetId: z.string().uuid() })

const SendenSchema = z.object({
  ticketIds: z.array(z.string().uuid()).min(1).max(200),
  email:     z.string().trim().email('Ungültige E-Mail-Adresse').max(254),
})

function fehler(reply: FastifyReply, err: unknown) {
  if (err instanceof TicketError) return reply.status(err.httpStatus).send({ fehler: err.message })
  throw err
}

export const ticketingRoute: FastifyPluginAsync<TicketingRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.requireBerechtigung('tickets')] }
  const { db, config } = opts

  /** Tickets versenden — gemeinsam für „ausstellen + senden" und „nachsenden". */
  async function versende(mandantId: string, codes: string[], email: string): Promise<{ erfolgreich: boolean; fehler?: string }> {
    if (!isEmailAktiv(config)) {
      return { erfolgreich: false, fehler: 'E-Mail-Versand ist nicht eingerichtet (SMTP fehlt)' }
    }
    const { ticketBasisUrl } = await holeTicketEinstellungen(db, mandantId)
    if (!ticketBasisUrl) {
      return { erfolgreich: false, fehler: 'Ticket-Adresse fehlt — unter Tickets → Einstellungen eintragen' }
    }
    const daten = await holeTicketDruckdaten(db, codes, null)
    if (daten.length === 0) return { erfolgreich: false, fehler: 'Keine versendbaren Tickets' }
    try {
      await sendeTicketEmail(email, daten, config)
      return { erfolgreich: true }
    } catch (err) {
      fastify.log.warn({ err }, 'Ticket-E-Mail konnte nicht gesendet werden')
      return { erfolgreich: false, fehler: err instanceof Error ? err.message : 'Versand fehlgeschlagen' }
    }
  }

  // ---- Einstellungen ----
  fastify.get('/ticketing/einstellungen', guard, async (request) =>
    holeTicketEinstellungen(db, request.user.mandantId))

  fastify.put('/ticketing/einstellungen', guard, async (request, reply) => {
    const body = TicketEinstellungenSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    return setzeTicketEinstellungen(db, request.user.mandantId, body.data)
  })

  // ---- Einlass-Geräte ----
  fastify.get('/ticketing/einlass-geraete', guard, async (request) => listeGeraete(db, request.user.mandantId))

  fastify.post('/ticketing/einlass-geraete', guard, async (request, reply) => {
    const body = EinlassGeraetAnlegenSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    const geraet = await legeGeraetAn(db, request.user.mandantId, body.data.name)
    // Langlebig wie beim KDS (Eventbetrieb), aber einzeln sperrbar: sub = Geräte-ID,
    // jeder Aufruf prüft einlass_geraete.widerrufen_at.
    const token = fastify.jwt.sign(
      { sub: geraet.id, mandantId: request.user.mandantId, rolle: 'kellner', name: geraet.name, berechtigungen: [], typ: 'einlass_geraet' },
      { expiresIn: '3650d' },
    )
    const { einlassBasisUrl } = await holeTicketEinstellungen(db, request.user.mandantId)
    const antwort: EinlassGeraetAngelegt = {
      geraet, token,
      url: einlassBasisUrl ? `${einlassBasisUrl}/?token=${encodeURIComponent(token)}` : null,
    }
    return reply.status(201).send(antwort)
  })

  fastify.post('/ticketing/einlass-geraete/:geraetId/sperren', guard, async (request, reply) => {
    const p = GeraetParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try { return await widerrufeGeraet(db, request.user.mandantId, p.data.geraetId) }
    catch (err) {
      if (err instanceof EinlassError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/ticketing/events/:eventId/einlass-log', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try { return await listeEinlassLog(db, request.user.mandantId, p.data.eventId) }
    catch (err) { return fehler(reply, err) }
  })

  // ---- Events ----
  fastify.get('/ticketing/events', guard, async (request) => listeEvents(db, request.user.mandantId))

  fastify.post('/ticketing/events', guard, async (request, reply) => {
    const body = TicketEventInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    return reply.status(201).send(await erstelleEvent(db, request.user.mandantId, body.data))
  })

  fastify.get('/ticketing/events/:eventId', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try { return await holeEventDetail(db, request.user.mandantId, p.data.eventId) }
    catch (err) { return fehler(reply, err) }
  })

  fastify.patch('/ticketing/events/:eventId', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const body = TicketEventUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try { return await aktualisiereEvent(db, request.user.mandantId, p.data.eventId, body.data) }
    catch (err) { return fehler(reply, err) }
  })

  fastify.delete('/ticketing/events/:eventId', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await loescheEvent(db, request.user.mandantId, p.data.eventId)
      return reply.status(204).send()
    } catch (err) { return fehler(reply, err) }
  })

  fastify.put('/ticketing/events/:eventId/baender', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const body = TicketBaenderSetzenSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try { return await setzeBaender(db, request.user.mandantId, p.data.eventId, body.data) }
    catch (err) { return fehler(reply, err) }
  })

  // ---- Ticketarten ----
  fastify.post('/ticketing/events/:eventId/arten', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const body = TicketArtInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try { return reply.status(201).send(await erstelleTicketArt(db, request.user.mandantId, p.data.eventId, body.data)) }
    catch (err) { return fehler(reply, err) }
  })

  fastify.patch('/ticketing/arten/:artId', guard, async (request, reply) => {
    const p = ArtParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const body = TicketArtUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try { return await aktualisiereTicketArt(db, request.user.mandantId, p.data.artId, body.data) }
    catch (err) { return fehler(reply, err) }
  })

  fastify.delete('/ticketing/arten/:artId', guard, async (request, reply) => {
    const p = ArtParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await loescheTicketArt(db, request.user.mandantId, p.data.artId)
      return reply.status(204).send()
    } catch (err) { return fehler(reply, err) }
  })

  // ---- Tickets ----
  fastify.get('/ticketing/events/:eventId/tickets', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const q = z.object({ suche: z.string().max(100).optional() }).safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })
    try { return await listeTickets(db, request.user.mandantId, p.data.eventId, { suche: q.data.suche }) }
    catch (err) { return fehler(reply, err) }
  })

  fastify.post('/ticketing/events/:eventId/tickets', guard, async (request, reply) => {
    const p = EventParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const body = TicketAusstellenInputSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      const neu = await stelleTicketsAus(db, request.user.mandantId, request.user.sub, p.data.eventId, body.data)
      void logAudit(db, {
        mandantId: request.user.mandantId, userId: request.user.sub, aktion: 'tickets.ausgestellt',
        details: { eventId: p.data.eventId, typ: body.data.typ, anzahl: neu.length, rolle: body.data.rolle ?? null },
        ipAdresse: getClientIp(request),
      }, fastify.log)

      const antwort: TicketAusstellenAntwort = { tickets: neu }
      if (body.data.senden && body.data.email) {
        antwort.versand = await versende(request.user.mandantId, neu.map(t => t.code), body.data.email)
      }
      return reply.status(201).send(antwort)
    } catch (err) { return fehler(reply, err) }
  })

  fastify.post('/ticketing/tickets/:ticketId/stornieren', guard, async (request, reply) => {
    const p = TicketParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      const t = await storniereTicket(db, request.user.mandantId, p.data.ticketId)
      void logAudit(db, {
        mandantId: request.user.mandantId, userId: request.user.sub, aktion: 'ticket.storniert',
        details: { ticketId: t.id, code: t.code }, ipAdresse: getClientIp(request),
      }, fastify.log)
      return t
    } catch (err) { return fehler(reply, err) }
  })

  fastify.post('/ticketing/tickets/senden', guard, async (request, reply) => {
    const body = SendenSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    const codes = await codesFuerTicketIds(db, request.user.mandantId, body.data.ticketIds)
    if (codes.length === 0) return reply.status(404).send({ fehler: 'Tickets nicht gefunden' })
    const ergebnis = await versende(request.user.mandantId, codes, body.data.email)
    return reply.status(ergebnis.erfolgreich ? 200 : 502).send(ergebnis)
  })

  fastify.get('/ticketing/tickets/pdf', guard, async (request, reply) => {
    const q = z.object({ ids: z.string().max(200 * 37) }).safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: 'ids fehlt' })
    const ids = z.array(z.string().uuid()).min(1).max(200).safeParse(q.data.ids.split(',').filter(Boolean))
    if (!ids.success) return reply.status(400).send({ fehler: 'Ungültige Ticket-IDs' })
    const codes = await codesFuerTicketIds(db, request.user.mandantId, ids.data)
    if (codes.length === 0) return reply.status(404).send({ fehler: 'Tickets nicht gefunden' })
    const { ticketBasisUrl } = await holeTicketEinstellungen(db, request.user.mandantId)
    const pdf = await erzeugeTicketPdf(await holeTicketDruckdaten(db, codes, ticketBasisUrl))
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="Tickets-${codes.length}.pdf"`)
      .send(pdf)
  })
}
