import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { SetupServiceDeps } from './services/setup.service.js'
import type { BelegServiceDeps } from './services/beleg.service.js'
import { registerAuth } from './auth/plugin.js'
import { setupRoute } from './routes/setup.route.js'
import { healthRoute } from './routes/health.route.js'
import { authRoute } from './routes/auth.route.js'
import { artikelRoute } from './routes/artikel.route.js'
import { belegRoute } from './routes/beleg.route.js'
import { druckerRoute } from './routes/drucker.route.js'
import { bonierRoute } from './routes/bonier.route.js'
import { tischTabRoute } from './routes/tisch-tab.route.js'
import { userRoute } from './routes/user.route.js'
import { zvtRoute } from './routes/zvt.route.js'
import { berichtRoute } from './routes/bericht.route.js'

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

  // Auth-Plugin registrieren (stellt fastify.jwt + fastify.authenticate bereit)
  await registerAuth(fastify, deps.config)

  await fastify.register(async (api) => {
    // Offene Routen (kein Login nötig)
    await api.register(healthRoute)
    await api.register(authRoute,    { db:   deps.db })
    await api.register(setupRoute,   { deps: deps.setupDeps })

    // Geschützte Routen — alle Handler verlangen JWT via onRequest-Hook in den Routes
    await api.register(artikelRoute, { db:   deps.db })
    await api.register(belegRoute,   { deps: deps.belegDeps })
    await api.register(druckerRoute, { db:   deps.db })
    await api.register(bonierRoute,  { deps: { db: deps.db } })
    await api.register(tischTabRoute, { deps: { db: deps.db, belegDeps: deps.belegDeps } })
    await api.register(userRoute,     { db:   deps.db })
    await api.register(zvtRoute,      { deps: { db: deps.db } })
    await api.register(berichtRoute,  { deps: { db: deps.db } })
  }, { prefix: '/api' })

  return fastify
}
