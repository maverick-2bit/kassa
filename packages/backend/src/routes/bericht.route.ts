/**
 * Berichts-Routen — alle auth-protected, mandant-scoped.
 */

import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import { kassen, mandanten } from '../db/schema.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import { druckerConfigVonKasse, resolveZielDrucker, sendBytes, DruckerError } from '../services/drucker.service.js'
import { baueBerichtBon } from '../services/escpos/layout.js'
import { BerichtDruckInputSchema, ArtikelBerichtFilterSchema, BerichtFilterSchema, BuchungsjournalFilterSchema, KassenVergleichFilterSchema, KellnerBerichtFilterSchema, KuechenBerichtFilterSchema, StundenBerichtFilterSchema, WarengruppeBerichtFilterSchema } from '@kassa/shared'
import {
  erstelleBuchungsjournalCsv,
  holeKassenVergleich,
  holeKuechenBericht,
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
      // Uhrzeit-Filter nur mitgeben, wenn beide Grenzen da sind
      ...(raw['zeitVon'] && raw['zeitBis']
        ? { zeitVon: raw['zeitVon'], zeitBis: raw['zeitBis'] }
        : {}),
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
      throw err
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
      throw err
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
      throw err
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
      throw err
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
      throw err
    }
  })

  fastify.get('/berichte/kassen-vergleich', guard, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const parsed = KassenVergleichFilterSchema.safeParse({ von: raw['von'], bis: raw['bis'] })
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const bericht = await holeKassenVergleich(parsed.data, request.user.mandantId, opts.deps)
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/berichte/kueche', guard, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const parsed = KuechenBerichtFilterSchema.safeParse({ von: raw['von'], bis: raw['bis'] })
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const bericht = await holeKuechenBericht(parsed.data, request.user.mandantId, opts.deps)
      return reply.send(bericht)
    } catch (err) {
      if (err instanceof BerichtError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // POST /berichte/drucken — Berichts-Tabelle auf dem Bondrucker der Kasse ausgeben
  fastify.post('/berichte/drucken', guard, async (request, reply) => {
    const parsed = BerichtDruckInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const { kasseId, druckerId, ...bericht } = parsed.data
    const db = opts.deps.db

    if (!(await pruefeKasseGehoertZuMandant(db, kasseId, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }
    const [kasse] = await db.select().from(kassen).where(eq(kassen.id, kasseId)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    let druckerConfig
    try {
      // Gewählter Bibliotheks-Drucker hat Vorrang, egal wie der Kassen-Drucker eingestellt ist
      druckerConfig = druckerId
        ? await resolveZielDrucker(db, request.user.mandantId, kasse.id, druckerId)
        : druckerConfigVonKasse(kasse)
    } catch (err) {
      if (err instanceof DruckerError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
    if (!druckerConfig) {
      return reply.status(409).send({ fehler: 'Drucker ist nicht konfiguriert oder deaktiviert' })
    }
    const [mandant] = await db.select({ firmenname: mandanten.firmenname })
      .from(mandanten).where(eq(mandanten.id, kasse.mandantId)).limit(1)
    if (!mandant) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })

    try {
      const bytes = baueBerichtBon(
        bericht,
        { firmenname: mandant.firmenname, kassenId: kasse.kassenId },
        { breite: druckerConfig.breite },
      )
      await sendBytes(bytes, druckerConfig)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof DruckerError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
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
      throw err
    }
  })
}
