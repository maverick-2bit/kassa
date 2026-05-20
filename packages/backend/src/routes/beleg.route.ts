/**
 * Beleg-Routen
 *   POST /api/belege/barzahlung    Barzahlungsbeleg
 *   POST /api/belege/storno        Stornobeleg (zu vorhandenem Beleg)
 *   POST /api/belege/nullbeleg     Nullbeleg (Test/Kontroll)
 *   POST /api/belege/monatsbeleg   Monatsabschluss
 *   POST /api/belege/jahresbeleg   Jahresabschluss
 *   GET  /api/belege?kasseId=…     Belege auflisten
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  BarzahlungsbelegInputSchema,
  StornobelegInputSchema,
  NullbelegInputSchema,
  MonatsbelegInputSchema,
  JahresbelegInputSchema,
} from '@kassa/shared'
import {
  erstelleBarzahlungsbeleg,
  erstelleStornobeleg,
  erstelleNullbeleg,
  erstelleMonatsbeleg,
  erstelleJahresbeleg,
  listeBelege,
  BelegError,
  type BelegServiceDeps,
} from '../services/beleg.service.js'
import { tryDruckeBeleg } from '../services/drucker.service.js'

export interface BelegRouteOptions {
  deps: BelegServiceDeps
}

const ListQuerySchema = z.object({
  kasseId: z.string().uuid(),
  limit:   z.coerce.number().int().min(1).max(500).optional(),
})

/**
 * Behandelt einen Service-Aufruf mit einheitlicher Fehlerbehandlung.
 * Nach erfolgreicher Erstellung wird optional ein Auto-Print getriggert
 * (fire-and-forget, Druckfehler propagieren NICHT zum HTTP-Response).
 */
async function fuehreAus<T extends { id: string }>(
  fastify: Parameters<FastifyPluginAsync>[0],
  reply:   { status: (n: number) => { send: (b: unknown) => unknown } },
  deps:    BelegServiceDeps,
  fn:      () => Promise<T>,
  successStatus = 201,
): Promise<unknown> {
  try {
    const result = await fn()
    // Fire-and-forget: Bon zum Drucker schicken (Fehler werden geloggt)
    tryDruckeBeleg(deps.db, result.id, fastify.log)
    return reply.status(successStatus).send(result)
  } catch (err) {
    if (err instanceof BelegError) {
      return reply.status(err.httpStatus).send({ fehler: err.message })
    }
    fastify.log.error({ err }, 'Beleg-Erstellung unerwartet fehlgeschlagen')
    const meldung = err instanceof Error ? err.message : String(err)
    return reply.status(500).send({ fehler: meldung })
  }
}

export const belegRoute: FastifyPluginAsync<BelegRouteOptions> = async (fastify, opts) => {
  // ----- Barzahlung -----
  fastify.post('/belege/barzahlung', async (request, reply) => {
    const parsed = BarzahlungsbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    return fuehreAus(fastify, reply, opts.deps, () => erstelleBarzahlungsbeleg(parsed.data, opts.deps))
  })

  // ----- Storno -----
  fastify.post('/belege/storno', async (request, reply) => {
    const parsed = StornobelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    return fuehreAus(fastify, reply, opts.deps, () => erstelleStornobeleg(parsed.data, opts.deps))
  })

  // ----- Nullbeleg -----
  fastify.post('/belege/nullbeleg', async (request, reply) => {
    const parsed = NullbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    return fuehreAus(fastify, reply, opts.deps, () => erstelleNullbeleg(parsed.data, opts.deps))
  })

  // ----- Monatsbeleg -----
  fastify.post('/belege/monatsbeleg', async (request, reply) => {
    const parsed = MonatsbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    return fuehreAus(fastify, reply, opts.deps, () => erstelleMonatsbeleg(parsed.data, opts.deps))
  })

  // ----- Jahresbeleg -----
  fastify.post('/belege/jahresbeleg', async (request, reply) => {
    const parsed = JahresbelegInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    return fuehreAus(fastify, reply, opts.deps, () => erstelleJahresbeleg(parsed.data, opts.deps))
  })

  // ----- Auflisten -----
  fastify.get('/belege', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const liste = await listeBelege(opts.deps.db, parsed.data.kasseId, {
      ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    })
    return reply.send(liste)
  })
}
