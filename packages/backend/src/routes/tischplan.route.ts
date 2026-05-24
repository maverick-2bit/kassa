import type { FastifyPluginAsync } from 'fastify'
import {
  TischplanBereichErstellenSchema,
  TischplanBereichAktualisierenSchema,
  TischplanElementErstellenSchema,
  TischplanElementAktualisierenSchema,
} from '@kassa/shared'
import {
  listeBereiche,
  erstelleBereich,
  aktualisiereBereich,
  loescheBereich,
  erstelleElement,
  aktualisiereElement,
  loescheElement,
  TischplanError,
  type TischplanServiceDeps,
} from '../services/tischplan.service.js'

export interface TischplanRouteOptions {
  deps: TischplanServiceDeps
}

export const tischplanRoute: FastifyPluginAsync<TischplanRouteOptions> = async (fastify, opts) => {
  const auth    = { onRequest: [fastify.authenticate] }
  const adminOk = { onRequest: [fastify.requireRolle('admin')] }

  // GET /api/tischplan/bereiche?kasseId=...
  fastify.get('/tischplan/bereiche', auth, async (request, reply) => {
    const { kasseId } = request.query as { kasseId?: string }
    if (!kasseId) return reply.status(400).send({ fehler: 'kasseId fehlt' })
    const bereiche = await listeBereiche(kasseId, request.user.mandantId, opts.deps)
    return reply.send(bereiche)
  })

  // POST /api/tischplan/bereiche — nur Admin
  fastify.post('/tischplan/bereiche', adminOk, async (request, reply) => {
    const parsed = TischplanBereichErstellenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const bereich = await erstelleBereich(parsed.data, request.user.mandantId, opts.deps)
      return reply.status(201).send(bereich)
    } catch (err) {
      if (err instanceof TischplanError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // PATCH /api/tischplan/bereiche/:id — nur Admin
  fastify.patch('/tischplan/bereiche/:id', adminOk, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = TischplanBereichAktualisierenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      await aktualisiereBereich(id, request.user.mandantId, parsed.data, opts.deps)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof TischplanError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // DELETE /api/tischplan/bereiche/:id — nur Admin
  fastify.delete('/tischplan/bereiche/:id', adminOk, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await loescheBereich(id, request.user.mandantId, opts.deps)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof TischplanError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // POST /api/tischplan/elemente — nur Admin
  fastify.post('/tischplan/elemente', adminOk, async (request, reply) => {
    const parsed = TischplanElementErstellenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const el = await erstelleElement(parsed.data, request.user.mandantId, opts.deps)
      return reply.status(201).send(el)
    } catch (err) {
      if (err instanceof TischplanError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // PATCH /api/tischplan/elemente/:id — nur Admin
  fastify.patch('/tischplan/elemente/:id', adminOk, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = TischplanElementAktualisierenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      await aktualisiereElement(id, request.user.mandantId, parsed.data, opts.deps)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof TischplanError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // DELETE /api/tischplan/elemente/:id — nur Admin
  fastify.delete('/tischplan/elemente/:id', adminOk, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await loescheElement(id, request.user.mandantId, opts.deps)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof TischplanError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
