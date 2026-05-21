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
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

export interface BelegRouteOptions {
  deps: BelegServiceDeps
}

const ListQuerySchema = z.object({
  kasseId: z.string().uuid(),
  limit:   z.coerce.number().int().min(1).max(500).optional(),
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
      ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
    })
    return reply.send(liste)
  })
}
