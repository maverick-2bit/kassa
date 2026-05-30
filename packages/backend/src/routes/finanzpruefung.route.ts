import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import {
  erstellePruefungsToken,
  ladePruefungsDaten,
  listePruefungsTokens,
  widerrufePruefungsToken,
  PruefungError,
} from '../services/finanzpruefung.service.js'
import { erstelleDep7Json } from '../services/beleg.service.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

export interface FinanzpruefungRouteOptions {
  db: Db
}

const TokenErstellenSchema = z.object({
  kasseId:          z.string().uuid(),
  gueltigkeitsTage: z.coerce.number().int().min(1).max(90).default(30),
  beschreibung:     z.string().max(200).optional(),
})
const TokenQuerySchema  = z.object({ kasseId: z.string().uuid() })
const IdParamSchema     = z.object({ id: z.string().uuid() })
const PublicParamSchema = z.object({ token: z.string().length(64).regex(/^[0-9a-f]+$/) })

export const finanzpruefungRoute: FastifyPluginAsync<FinanzpruefungRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  // -------------------------------------------------------------------------
  // Geschützte Verwaltungsrouten (Admin / einstellungen-Berechtigung)
  // -------------------------------------------------------------------------

  fastify.post('/finanzpruefung/tokens', guard, async (request, reply) => {
    const parsed = TokenErstellenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    try {
      const token = await erstellePruefungsToken(
        opts.db,
        parsed.data.kasseId,
        request.user.mandantId,
        request.user.sub,
        parsed.data.gueltigkeitsTage,
        parsed.data.beschreibung,
      )
      return reply.status(201).send(token)
    } catch (err) {
      fastify.log.error({ err }, 'Prüfungstoken erstellen fehlgeschlagen')
      return reply.status(500).send({ fehler: 'Interner Fehler' })
    }
  })

  fastify.get('/finanzpruefung/tokens', guard, async (request, reply) => {
    const parsed = TokenQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId)))
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const tokens = await listePruefungsTokens(opts.db, parsed.data.kasseId, request.user.mandantId)
    return reply.send(tokens)
  })

  fastify.delete('/finanzpruefung/tokens/:id', guard, async (request, reply) => {
    const parsed = IdParamSchema.safeParse(request.params)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const ok = await widerrufePruefungsToken(opts.db, parsed.data.id, request.user.mandantId)
    if (!ok) return reply.status(404).send({ fehler: 'Token nicht gefunden' })
    return reply.status(204).send()
  })

  // -------------------------------------------------------------------------
  // Öffentliche Prüfer-Routen (kein JWT — Token-basierte Validierung)
  // -------------------------------------------------------------------------

  fastify.get('/pruefung/:token', async (request, reply) => {
    const parsed = PublicParamSchema.safeParse(request.params)
    if (!parsed.success) return reply.status(400).send({ fehler: 'Ungültiger Token' })

    try {
      const daten = await ladePruefungsDaten(opts.db, parsed.data.token)
      return reply.send(daten)
    } catch (err) {
      if (err instanceof PruefungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'Prüfungsansicht laden fehlgeschlagen')
      return reply.status(500).send({ fehler: 'Interner Fehler' })
    }
  })

  fastify.get('/pruefung/:token/dep7', async (request, reply) => {
    const parsed = PublicParamSchema.safeParse(request.params)
    if (!parsed.success) return reply.status(400).send({ fehler: 'Ungültiger Token' })

    try {
      const daten = await ladePruefungsDaten(opts.db, parsed.data.token)
      const { json, kassenId, anzahl } = await erstelleDep7Json(opts.db, { kasseId: daten.token.kasseId })
      const datei = `DEP7-${kassenId}-Pruefung-${new Date().toISOString().slice(0, 10)}.json`
      return reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="${datei}"`)
        .header('X-Anzahl-Belege', String(anzahl))
        .send(json)
    } catch (err) {
      if (err instanceof PruefungError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'DEP7 für Prüfung fehlgeschlagen')
      return reply.status(500).send({ fehler: 'Interner Fehler' })
    }
  })
}
