/**
 * Health-Endpoint — für Load-Balancer, Container-Orchestrierung und Monitoring.
 *
 *  GET /health
 *    Prüft die DB-Verbindung und gibt Status, Version und Uptime zurück.
 *    → 200 wenn alles ok
 *    → 503 wenn die Datenbank nicht erreichbar ist
 */

import type { FastifyPluginAsync } from 'fastify'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'

export interface HealthRouteOptions { db: Db }

const START_TIME = Date.now()

// package.json-Version zur Laufzeit einlesen (ESM-kompatibel über createRequire)
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

export const healthRoute: FastifyPluginAsync<HealthRouteOptions> = async (fastify, opts) => {

  fastify.get('/health', async (_request, reply) => {
    const uptimeSek = Math.floor((Date.now() - START_TIME) / 1000)

    // DB-Verbindung prüfen
    let dbOk = false
    try {
      await opts.db.execute(sql`SELECT 1`)
      dbOk = true
    } catch {
      // DB nicht erreichbar
    }

    const status = dbOk ? 'ok' : 'degraded'

    return reply
      .status(dbOk ? 200 : 503)
      .send({
        status,
        version,
        uptimeSek,
        timestamp: new Date().toISOString(),
        checks: {
          db: dbOk ? 'ok' : 'unreachable',
        },
      })
  })
}
