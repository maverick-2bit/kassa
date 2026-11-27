/**
 * Baut den Portal-Server (ohne ihn zu starten) — auch für die Tests.
 */

import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { PortalFehler } from './fehler.js'
import { registriereAuth } from './auth/jwt.js'
import { leiteSchluesselAb } from './auth/verschluesselung.js'
import { authRoute } from './routes/auth.route.js'
import { boxRoute } from './routes/box.route.js'
import { verwaltungRoute } from './routes/verwaltung.route.js'

export interface ServerAbhaengigkeiten {
  config: Config
  db:     Db
  /** Uhr (für Tests); Standard: jetzt */
  jetzt?: () => Date
  /** Tests heben die Begrenzungen an */
  anmeldeLimit?:  number
  meldungsLimit?: number
  /** Jede Route mit ihren Wächtern festhalten (nur für den Schutz-Test) */
  routenRegister?: { method: string | string[]; url: string; onRequest: unknown }[]
}

export async function buildServer(deps: ServerAbhaengigkeiten): Promise<FastifyInstance> {
  const { config, db } = deps
  const jetzt = deps.jetzt ?? (() => new Date())

  const fastify = Fastify({
    logger:     config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    // Eine Meldung ist klein (höchstens ein paar hundert Fehlergruppen); alles darüber ist kein Melder
    bodyLimit:  1024 * 1024,
  })

  fastify.setErrorHandler((err: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof PortalFehler) {
      return reply.status(err.httpStatus).send({ fehler: err.message, ...(err.code ? { code: err.code } : {}) })
    }
    const status = (err as FastifyError).statusCode
    if (status && status >= 400 && status < 500) {
      // z. B. kaputtes JSON (400), zu großer Body (413), Rate-Limit (429)
      return reply.status(status).send({ fehler: status === 429 ? 'Zu viele Anfragen. Bitte später erneut versuchen.' : 'Ungültige Anfrage' })
    }
    request.log.error({ err }, 'Unbehandelter Fehler')
    return reply.status(500).send({ fehler: 'Interner Fehler' })
  })

  if (deps.routenRegister) {
    const register = deps.routenRegister
    fastify.addHook('onRoute', (route) => { register.push({ method: route.method, url: route.url, onRequest: route.onRequest }) })
  }

  if (config.CORS_ORIGIN !== '') {
    await fastify.register(cors, { origin: config.CORS_ORIGIN.split(',').map(s => s.trim()), credentials: false })
  }
  await fastify.register(helmet)
  await fastify.register(rateLimit, { global: true, max: config.NODE_ENV === 'test' ? 100_000 : 300, timeWindow: '1 minute' })

  await registriereAuth(fastify, config, db)
  const totpSchluessel = leiteSchluesselAb(config.PORTAL_MASTER_KEY)
  const testModus = config.NODE_ENV === 'test'

  await fastify.register(async (api) => {
    api.get('/health', async (_request, reply) => {
      try {
        await db.execute(sql`SELECT 1`)
        return reply.send({ status: 'ok' })
      } catch {
        return reply.status(503).send({ status: 'db-fehler' })
      }
    })
    await api.register(authRoute, { config, db, totpSchluessel, jetzt, anmeldeLimit: deps.anmeldeLimit ?? (testModus ? 10_000 : 10) })
    await api.register(boxRoute, { db, jetzt, meldungsLimit: deps.meldungsLimit ?? (testModus ? 10_000 : 30) })
    await api.register(verwaltungRoute, { config, db, jetzt })
  }, { prefix: '/api' })

  return fastify
}
