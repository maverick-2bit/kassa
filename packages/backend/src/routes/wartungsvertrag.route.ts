import type { FastifyPluginAsync } from 'fastify'
import {
  WartungslaufInputSchema,
  WartungsvertragInputSchema,
  WartungsvertragStatusSchema,
  WartungsvertragUpdateSchema,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  aktualisiereWartungsvertrag,
  erstelleWartungsvertrag,
  ermittleFaelligeRechnungen,
  fuehreWartungslaufDurch,
  holeWartungsvertrag,
  listeWartungsvertraege,
  rechneWartungsvertragAb,
  WartungError,
} from '../services/wartungsvertrag.service.js'
import { uuidParam, uuidQuery } from './uuid-param.js'

export interface WartungsvertragRouteOptions { db: Db }

export const wartungsvertragRoute: FastifyPluginAsync<WartungsvertragRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  const fehler = (err: unknown, reply: { status: (c: number) => { send: (b: unknown) => unknown } }) => {
    if (err instanceof WartungError) return reply.status(err.httpStatus).send({ fehler: err.message })
    throw err
  }

  fastify.get('/wartungsvertraege', auth, async (request, reply) => {
    const q       = request.query as Record<string, string>
    const kundeId = uuidQuery(q, 'kundeId')
    const status  = WartungsvertragStatusSchema.safeParse(q['status'])
    return reply.send(await listeWartungsvertraege(opts.db, request.user.mandantId, {
      ...(kundeId        ? { kundeId }              : {}),
      ...(status.success ? { status: status.data } : {}),
    }))
  })

  fastify.post('/wartungsvertraege', auth, async (request, reply) => {
    const parsed = WartungsvertragInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.status(201).send(await erstelleWartungsvertrag(opts.db, request.user.mandantId, parsed.data))
    } catch (err) { return fehler(err, reply) }
  })

  /** Offene Verrechnung: Verträge mit fälligen Wartungslieferscheinen */
  fastify.get('/wartungsvertraege/faellige-rechnungen', auth, async (request, reply) => {
    return reply.send(await ermittleFaelligeRechnungen(opts.db, request.user.mandantId, new Date()))
  })

  /** Monatslauf von Hand (Vorschau oder echt) — der Cron erledigt dasselbe automatisch */
  fastify.post('/wartungsvertraege/lauf', auth, async (request, reply) => {
    const parsed = WartungslaufInputSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    return reply.send(await fuehreWartungslaufDurch(opts.db, {
      jetzt: new Date(), mandantId: request.user.mandantId, vorschau: parsed.data.vorschau,
    }))
  })

  fastify.get('/wartungsvertraege/:id', auth, async (request, reply) => {
    const id = uuidParam(request.params)
    try {
      return reply.send(await holeWartungsvertrag(opts.db, id, request.user.mandantId))
    } catch (err) { return fehler(err, reply) }
  })

  fastify.patch('/wartungsvertraege/:id', auth, async (request, reply) => {
    const id     = uuidParam(request.params)
    const parsed = WartungsvertragUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await aktualisiereWartungsvertrag(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) { return fehler(err, reply) }
  })

  /** Sammelrechnung über die fälligen Wartungslieferscheine des Vertrags */
  fastify.post('/wartungsvertraege/:id/abrechnen', auth, async (request, reply) => {
    const id = uuidParam(request.params)
    try {
      return reply.status(201).send(await rechneWartungsvertragAb(opts.db, request.user.mandantId, id, new Date()))
    } catch (err) { return fehler(err, reply) }
  })
}
