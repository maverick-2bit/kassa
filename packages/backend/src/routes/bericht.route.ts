/**
 * Berichts-Routen — alle auth-protected, mandant-scoped.
 */

import type { FastifyPluginAsync } from 'fastify'
import { ArtikelBerichtFilterSchema, BerichtFilterSchema, BuchungsjournalFilterSchema, KellnerBerichtFilterSchema, StundenBerichtFilterSchema, WarengruppeBerichtFilterSchema } from '@kassa/shared'
import {
  erstelleBuchungsjournalCsv,
  holeKellnerBericht,
  holeUmsatzbericht,
  holeArtikelBericht,
  holeWarengruppeBericht,
  holeStundenbericht,
  BerichtError,
  type BerichtServiceDeps,
} from '../services/bericht.service.js'

export interface BerichtRouteOptions {
  deps: BerichtServiceDeps
}

export const berichtRoute: FastifyPluginAsync<BerichtRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/berichte/umsatz', guard, async (request, reply) => {
    // Query-Parameter nach BerichtFilter parsen
    const raw = request.query as Record<string, unknown>

    // kasseIds kann als kasseIds[]=... oder kasseIds=... kommen
    const kasseIdsRaw = raw['kasseIds']
    const kasseIds = Array.isArray(kasseIdsRaw)
      ? kasseIdsRaw
      : kasseIdsRaw ? [kasseIdsRaw] : []

    const parsed = BerichtFilterSchema.safeParse({
      kasseIds,
      von:               raw['von'],
      bis:               raw['bis'],
      nurZielrechnungen: raw['nurZielrechnungen'] === 'true',
      gruppierung:       raw['gruppierung'],
    })
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }

    try {
      const bericht = await holeUmsatzbericht(
        parsed.data,
        request.user.mandantId,
        opts.deps,
      )
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Umsatzbericht unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/berichte/artikel', guard, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const kasseIdsRaw = raw['kasseIds']
    const kasseIds = Array.isArray(kasseIdsRaw)
      ? kasseIdsRaw
      : kasseIdsRaw ? [kasseIdsRaw] : []

    const parsed = ArtikelBerichtFilterSchema.safeParse({
      kasseIds,
      von:   raw['von'],
      bis:   raw['bis'],
      limit: raw['limit'],
    })
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }

    try {
      const bericht = await holeArtikelBericht(parsed.data, request.user.mandantId, opts.deps)
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Artikelbericht unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/berichte/warengruppe', guard, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const kasseIdsRaw = raw['kasseIds']
    const kasseIds = Array.isArray(kasseIdsRaw)
      ? kasseIdsRaw
      : kasseIdsRaw ? [kasseIdsRaw] : []

    const parsed = WarengruppeBerichtFilterSchema.safeParse({
      kasseIds, von: raw['von'], bis: raw['bis'], limit: raw['limit'],
    })
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    try {
      const bericht = await holeWarengruppeBericht(parsed.data, request.user.mandantId, opts.deps)
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'Warengruppenbericht unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/berichte/stunden', guard, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const kasseIdsRaw = raw['kasseIds']
    const kasseIds = Array.isArray(kasseIdsRaw)
      ? kasseIdsRaw
      : kasseIdsRaw ? [kasseIdsRaw] : []

    const parsed = StundenBerichtFilterSchema.safeParse({
      kasseIds, von: raw['von'], bis: raw['bis'],
    })
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    try {
      const bericht = await holeStundenbericht(parsed.data, request.user.mandantId, opts.deps)
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'Stundenbericht unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/berichte/kellner', guard, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const kasseIdsRaw = raw['kasseIds']
    const kasseIds = Array.isArray(kasseIdsRaw) ? kasseIdsRaw : kasseIdsRaw ? [kasseIdsRaw] : []
    const parsed = KellnerBerichtFilterSchema.safeParse({ kasseIds, von: raw['von'], bis: raw['bis'] })
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const bericht = await holeKellnerBericht(parsed.data, request.user.mandantId, opts.deps)
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'Kellnerbericht unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/berichte/buchungsjournal', guard, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const kasseIdsRaw = raw['kasseIds']
    const kasseIds = Array.isArray(kasseIdsRaw) ? kasseIdsRaw : kasseIdsRaw ? [kasseIdsRaw] : []
    const parsed = BuchungsjournalFilterSchema.safeParse({ kasseIds, von: raw['von'], bis: raw['bis'] })
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const { csv, dateiname, anzahl } = await erstelleBuchungsjournalCsv(parsed.data, request.user.mandantId, opts.deps)
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${dateiname}"`)
        .header('X-Anzahl-Belege', String(anzahl))
        .send(csv)
    } catch (err) {
      if (err instanceof BerichtError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'Buchungsjournal-Export unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
