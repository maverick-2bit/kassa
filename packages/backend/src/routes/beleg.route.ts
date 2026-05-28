/**
 * Beleg-Routen — alle auth-protected.
 * Kasse-Zugehörigkeit wird gegen JWT-mandantId geprüft.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  BarzahlungsbelegInputSchema,
  StornobelegInputSchema,
  NullbelegInputSchema,
  MonatsbelegInputSchema,
  JahresbelegInputSchema,
  TagesabschlussQuerySchema,
} from '@kassa/shared'
import {
  erstelleBarzahlungsbeleg,
  erstelleStornobeleg,
  erstelleNullbeleg,
  erstelleMonatsbeleg,
  erstelleJahresbeleg,
  listeBelege,
  erstelleDep7Json,
  erstelleDep131Json,
  BelegError,
  type BelegServiceDeps,
} from '../services/beleg.service.js'
import {
  holeTagesabschluss,
  TagesabschlussError,
} from '../services/tagesabschluss.service.js'
import { tryDruckeBeleg, druckerConfigVonKasse, sendBytes } from '../services/drucker.service.js'
import { baueZBon, baueKassensturzBon } from '../services/escpos/layout.js'
import { listeKassenbuchBuchungen } from '../services/kassenbuch.service.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import { eq } from 'drizzle-orm'
import { kassen, mandanten } from '../db/schema.js'

export interface BelegRouteOptions {
  deps: BelegServiceDeps
}

const ListQuerySchema = z.object({
  kasseId: z.string().uuid(),
  limit:   z.coerce.number().int().min(1).max(500).optional(),
  kundeId: z.string().uuid().optional(),
})

const DepExportQuerySchema = z.object({
  kasseId:  z.string().uuid(),
  vonDatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bisDatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

async function fuehreAus<T extends { id: string }>(
  fastify: { log: { error: (obj: unknown, msg?: string) => void } },
  reply:   FastifyReply,
  deps:    BelegServiceDeps,
  fn:      () => Promise<T>,
  successStatus = 201,
): Promise<unknown> {
  try {
    const result = await fn()
    tryDruckeBeleg(deps.db, result.id, fastify.log)
    return reply.status(successStatus).send(result)
  } catch (err) {
    if (err instanceof BelegError) {
      return reply.status(err.httpStatus).send({ fehler: err.message })
    }
    fastify.log.error({ err }, 'Beleg-Erstellung unerwartet fehlgeschlagen')
    return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
  }
}

/** Mandant-Scope-Check, wenn die Eingabe eine kasseId enthält */
async function pruefeKasseScope(
  request:    FastifyRequest,
  reply:      FastifyReply,
  deps:       BelegServiceDeps,
  kasseId:    string,
): Promise<boolean> {
  const ok = await pruefeKasseGehoertZuMandant(deps.db, kasseId, request.user.mandantId)
  if (!ok) {
    void reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return false
  }
  return true
}

export const belegRoute: FastifyPluginAsync<BelegRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.post('/belege/barzahlung', guard, async (request, reply) => {
    const parsed = BarzahlungsbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return
    return fuehreAus(fastify, reply, opts.deps, () => erstelleBarzahlungsbeleg(parsed.data, opts.deps))
  })

  fastify.post('/belege/storno', guard, async (request, reply) => {
    const parsed = StornobelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return
    return fuehreAus(fastify, reply, opts.deps, () => erstelleStornobeleg(parsed.data, opts.deps))
  })

  fastify.post('/belege/nullbeleg', guard, async (request, reply) => {
    const parsed = NullbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return
    return fuehreAus(fastify, reply, opts.deps, () => erstelleNullbeleg(parsed.data, opts.deps))
  })

  fastify.post('/belege/monatsbeleg', guard, async (request, reply) => {
    const parsed = MonatsbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return
    return fuehreAus(fastify, reply, opts.deps, () => erstelleMonatsbeleg(parsed.data, opts.deps))
  })

  fastify.post('/belege/jahresbeleg', guard, async (request, reply) => {
    const parsed = JahresbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return
    return fuehreAus(fastify, reply, opts.deps, () => erstelleJahresbeleg(parsed.data, opts.deps))
  })

  fastify.get('/belege', guard, async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return
    const liste = await listeBelege(opts.deps.db, parsed.data.kasseId, {
      ...(parsed.data.limit   !== undefined && { limit:   parsed.data.limit }),
      ...(parsed.data.kundeId !== undefined && { kundeId: parsed.data.kundeId }),
    })
    return reply.send(liste)
  })

  // -------------------------------------------------------------------------
  // Tagesabschluss (Z-Bon)
  // -------------------------------------------------------------------------

  fastify.get('/belege/tagesabschluss', guard, async (request, reply) => {
    const parsed = TagesabschlussQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const ta = await holeTagesabschluss(
        parsed.data.kasseId,
        parsed.data.datum,
        request.user.mandantId,
        opts.deps,
      )
      return reply.send(ta)
    } catch (err) {
      if (err instanceof TagesabschlussError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Tagesabschluss unerwartet fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  // -------------------------------------------------------------------------
  // DEP-Export (DEP7 + DEP131)
  // -------------------------------------------------------------------------

  fastify.get('/belege/dep7', guard, async (request, reply) => {
    const parsed = DepExportQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return

    try {
      const { json, kassenId, anzahl } = await erstelleDep7Json(opts.deps.db, parsed.data)
      const datei = `DEP7-${kassenId}-${new Date().toISOString().slice(0, 10)}.json`
      return reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="${datei}"`)
        .header('X-Anzahl-Belege', String(anzahl))
        .send(json)
    } catch (err) {
      if (err instanceof BelegError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'DEP7-Export fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.get('/belege/dep131', guard, async (request, reply) => {
    const parsed = DepExportQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    if (!(await pruefeKasseScope(request, reply, opts.deps, parsed.data.kasseId))) return

    try {
      const { json, kassenId, anzahl } = await erstelleDep131Json(opts.deps.db, parsed.data)
      const datei = `DEP131-${kassenId}-${new Date().toISOString().slice(0, 10)}.json`
      return reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="${datei}"`)
        .header('X-Anzahl-Belege', String(anzahl))
        .send(json)
    } catch (err) {
      if (err instanceof BelegError) return reply.status(err.httpStatus).send({ fehler: err.message })
      fastify.log.error({ err }, 'DEP131-Export fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  // ---------------------------------------------------------------------------
  // Kassensturz-Bon drucken
  // ---------------------------------------------------------------------------

  const KassensturzDruckenSchema = z.object({
    kasseId:       z.string().uuid(),
    datum:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    istCent:       z.number().int(),
    sollCent:      z.number().int(),
    differenzCent: z.number().int(),
    startgeldCent: z.number().int().default(0),
    stueck: z.array(z.object({
      label:     z.string(),
      anzahl:    z.number().int().min(0),
      summeCent: z.number().int(),
    })),
  })

  fastify.post('/kassensturz/drucken', guard, async (request, reply) => {
    const parsed = KassensturzDruckenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const { kasseId } = parsed.data
    const mandantId   = request.user.mandantId

    const [kasse] = await opts.deps.db
      .select()
      .from(kassen)
      .where(eq(kassen.id, kasseId))
      .limit(1)

    if (!kasse || kasse.mandantId !== mandantId) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const druckerConfig = druckerConfigVonKasse(kasse)
    if (!druckerConfig) {
      return reply.status(409).send({ fehler: 'Drucker ist nicht konfiguriert oder deaktiviert' })
    }

    const [mandant] = await opts.deps.db
      .select({ firmenname: mandanten.firmenname })
      .from(mandanten)
      .where(eq(mandanten.id, kasse.mandantId))
      .limit(1)
    if (!mandant) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })

    try {
      const bytes = baueKassensturzBon({
        ...parsed.data,
        kassenId:   kasse.kassenId,
        firmenname: mandant.firmenname,
      }, { breite: druckerConfig.breite })

      await sendBytes(bytes, druckerConfig)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      fastify.log.error({ err }, 'Kassensturz-Druck fehlgeschlagen')
      return reply.status(502).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  fastify.post('/belege/tagesabschluss/drucken', guard, async (request, reply) => {
    const parsed = TagesabschlussQuerySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    try {
      const ta = await holeTagesabschluss(
        parsed.data.kasseId,
        parsed.data.datum,
        request.user.mandantId,
        opts.deps,
      )

      // Kasse + Mandant für Drucker-Config und Bon-Header laden
      const [kasse] = await opts.deps.db
        .select()
        .from(kassen)
        .where(eq(kassen.id, parsed.data.kasseId))
        .limit(1)
      if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

      const druckerConfig = druckerConfigVonKasse(kasse)
      if (!druckerConfig) {
        return reply.status(409).send({ fehler: 'Drucker ist nicht konfiguriert oder deaktiviert' })
      }

      const [mandant] = await opts.deps.db
        .select()
        .from(mandanten)
        .where(eq(mandanten.id, kasse.mandantId))
        .limit(1)
      if (!mandant) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })

      // Kassenbuch des Tages nachladen (optional — kein Fehler wenn leer)
      const kassenbuch = await listeKassenbuchBuchungen(
        opts.deps.db,
        parsed.data.kasseId,
        parsed.data.datum,
        parsed.data.datum,
      ).catch(() => null)

      const bytes = baueZBon(ta, {
        firmenname: mandant.firmenname,
        uid:        mandant.uid,
        kassenId:   kasse.kassenId,
      }, { breite: druckerConfig.breite }, {
        kassenbuch:    kassenbuch ?? undefined,
        belegFusstext: mandant.belegFusstext ?? undefined,
      })

      await sendBytes(bytes, druckerConfig)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof TagesabschlussError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Z-Bon-Druck fehlgeschlagen')
      return reply.status(502).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
