import type { FastifyPluginAsync } from 'fastify'
import { UserCreateInputSchema, UserUpdateInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  listUsers,
  createUser,
  updateUser,
  deactivateUser,
  UserError,
} from '../services/user.service.js'

export interface UserRouteOptions { db: Db }

export const userRoute: FastifyPluginAsync<UserRouteOptions> = async (fastify, opts) => {
  const adminOnly = { onRequest: [fastify.requireRolle('admin')] }

  fastify.get('/users', adminOnly, async (request, reply) => {
    const users = await listUsers(request.user.mandantId, { db: opts.db })
    return reply.send(users)
  })

  fastify.post('/users', adminOnly, async (request, reply) => {
    const parsed = UserCreateInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const user = await createUser(parsed.data, request.user.mandantId, { db: opts.db })
      return reply.status(201).send(user)
    } catch (err) {
      if (err instanceof UserError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.put('/users/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = UserUpdateInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const user = await updateUser(id, parsed.data, request.user.mandantId, { db: opts.db })
      return reply.send(user)
    } catch (err) {
      if (err instanceof UserError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.delete('/users/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const user = await deactivateUser(id, request.user.mandantId, request.user.sub, { db: opts.db })
      return reply.send(user)
    } catch (err) {
      if (err instanceof UserError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
