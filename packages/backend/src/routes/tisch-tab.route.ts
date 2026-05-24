import type { FastifyPluginAsync } from 'fastify'
import {
  TischTabErstellenInputSchema,
  TischTabPositionenUpdateSchema,
  TischTabBezahlenInputSchema,
  TischTabUmbuchenInputSchema,
  TischTabUmbenennenInputSchema,
  TischTabSplittenInputSchema,
} from '@kassa/shared'
import {
  listOffeneTabs,
  erstelleTab,
  getTab,
  getTabVerlauf,
  aktualisierePositionen,
  bezahleTab,
  umbenneneTab,
  umbucheTab,
  splitteUndBezahleTab,
  TischTabError,
  type TischTabServiceDeps,
} from '../services/tisch-tab.service.js'

export interface TischTabRouteOptions {
  deps: TischTabServiceDeps
}

export const tischTabRoute: FastifyPluginAsync<TischTabRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/tisch-tabs', auth, async (request, reply) => {
    const { kasseId } = request.query as { kasseId?: string }
    if (!kasseId) return reply.status(400).send({ fehler: 'kasseId fehlt' })
    const tabs = await listOffeneTabs(request.user.mandantId, kasseId, opts.deps)
    return reply.send(tabs)
  })

  fastify.post('/tisch-tabs', auth, async (request, reply) => {
    const parsed = TischTabErstellenInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const tab = await erstelleTab(parsed.data, request.user.mandantId, opts.deps)
      return reply.status(201).send(tab)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/tisch-tabs/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const tab = await getTab(id, request.user.mandantId, opts.deps)
      return reply.send(tab)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.put('/tisch-tabs/:id/positionen', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = TischTabPositionenUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const tab = await aktualisierePositionen(id, parsed.data.positionen, request.user.mandantId, opts.deps)
      return reply.send(tab)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/tisch-tabs/:id/bezahlen', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = TischTabBezahlenInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const result = await bezahleTab(id, parsed.data, request.user.mandantId, opts.deps)
      return reply.send(result)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/tisch-tabs/:id/kellner', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = TischTabUmbenennenInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const tab = await umbenneneTab(id, parsed.data, request.user.mandantId, opts.deps)
      return reply.send(tab)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/tisch-tabs/:id/tisch', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = TischTabUmbuchenInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const tab = await umbucheTab(id, parsed.data, request.user.mandantId, opts.deps)
      return reply.send(tab)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/tisch-tabs/:id/verlauf', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const verlauf = await getTabVerlauf(id, request.user.mandantId, opts.deps)
      return reply.send(verlauf)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/tisch-tabs/:id/splitten', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = TischTabSplittenInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const result = await splitteUndBezahleTab(id, parsed.data, request.user.mandantId, opts.deps)
      return reply.send(result)
    } catch (err) {
      if (err instanceof TischTabError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
