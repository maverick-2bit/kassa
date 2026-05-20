/**
 * Fastify-Server-Aufbau.
 * Wird sowohl von index.ts (Produktion) als auch von Tests verwendet.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { SetupServiceDeps } from './services/setup.service.js'
import type { BelegServiceDeps } from './services/beleg.service.js'
import { setupRoute } from './routes/setup.route.js'
import { healthRoute } from './routes/health.route.js'
import { artikelRoute } from './routes/artikel.route.js'
import { belegRoute } from './routes/beleg.route.js'

export interface ServerDeps {
  config:    Config
  db:        Db
  setupDeps: SetupServiceDeps
  belegDeps: BelegServiceDeps
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
    },
    disableRequestLogging: deps.config.NODE_ENV === 'test',
  })

  await fastify.register(cors, {
    origin: deps.config.CORS_ORIGIN.split(',').map(s => s.trim()),
    credentials: true,
  })

  await fastify.register(async (api) => {
    await api.register(healthRoute)
    await api.register(setupRoute,   { deps: deps.setupDeps })
    await api.register(artikelRoute, { db:   deps.db })
    await api.register(belegRoute,   { deps: deps.belegDeps })
  }, { prefix: '/api' })

  return fastify
}
