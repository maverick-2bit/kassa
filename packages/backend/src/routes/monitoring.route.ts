import type { FastifyPluginAsync } from 'fastify'
import { sql } from 'drizzle-orm'
import os from 'node:os'
import type { Db } from '../db/client.js'

export interface MonitoringRouteOptions { db: Db }

const START_TIME = Date.now()

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

export const monitoringRoute: FastifyPluginAsync<MonitoringRouteOptions> = async (fastify, opts) => {

  fastify.get('/api/admin/monitoring', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    if (request.user.rolle !== 'admin') {
      return reply.status(403).send({ fehler: 'Kein Zugriff' })
    }

    const uptimeSek = Math.floor((Date.now() - START_TIME) / 1000)

    // DB-Status + Latenz messen
    let dbOk       = false
    let dbLatenzMs: number | null = null
    try {
      const t0 = Date.now()
      await opts.db.execute(sql`SELECT 1`)
      dbLatenzMs = Date.now() - t0
      dbOk = true
    } catch { /* DB nicht erreichbar */ }

    // Node-Prozess-Speicher
    const mem    = process.memoryUsage()
    const toMb   = (b: number) => Math.round(b / 1024 / 1024 * 10) / 10

    // CPU-Zeit seit Prozessstart
    const cpu    = process.cpuUsage()

    // OS
    const loadAvg = os.loadavg()    // [1min, 5min, 15min]
    const freeMem = os.freemem()
    const totalMem = os.totalmem()

    return reply.send({
      timestamp:  new Date().toISOString(),
      uptimeSek,
      version,
      nodeVersion: process.version,
      platform:   `${process.platform}/${process.arch}`,
      db: {
        ok:       dbOk,
        latenzMs: dbLatenzMs,
      },
      memory: {
        heapUsedMb:  toMb(mem.heapUsed),
        heapTotalMb: toMb(mem.heapTotal),
        rssMb:       toMb(mem.rss),
        externalMb:  toMb(mem.external),
      },
      cpu: {
        userMs:   Math.round(cpu.user   / 1000),
        systemMs: Math.round(cpu.system / 1000),
      },
      system: {
        loadAvg1:   Math.round(loadAvg[0]! * 100) / 100,
        loadAvg5:   Math.round(loadAvg[1]! * 100) / 100,
        freeMemMb:  toMb(freeMem),
        totalMemMb: toMb(totalMem),
      },
    })
  })
}
