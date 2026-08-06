import type { FastifyPluginAsync } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import os from 'node:os'
import v8 from 'node:v8'
import type { Db } from '../db/client.js'
import { mandanten } from '../db/schema.js'
import { holeBackupStatus, holeSpeicherStatus } from '../services/monitoring.service.js'
import { fuehreKeepAliveDurch, holeDruckerKeepAliveStatus } from '../services/drucker-keepalive.service.js'

export interface MonitoringRouteOptions {
  db: Db
  /** Token für den externen Monitoring-Endpoint; leer = Endpoint deaktiviert. */
  monitoringToken?: string | undefined
  dbBackupMaxStunden:  number
  depBackupMaxStunden: number
  /** Sicherungsverzeichnis — Messpunkt für den freien Plattenplatz. */
  dbBackupDir: string
}

const START_TIME = Date.now()

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

export const monitoringRoute: FastifyPluginAsync<MonitoringRouteOptions> = async (fastify, opts) => {

  // ── Externer Monitoring-Endpoint (token-geschützt, für Uptime-Monitore) ──────
  // 200 = gesund, 503 = degradiert (DB weg ODER eine Sicherung veraltet).
  // Ohne MONITORING_TOKEN deaktiviert (404).
  fastify.get<{ Querystring: { token?: string } }>('/api/monitoring/status', async (request, reply) => {
    if (!opts.monitoringToken) {
      return reply.status(404).send({ fehler: 'Monitoring-Endpoint nicht konfiguriert' })
    }
    if (request.query.token !== opts.monitoringToken) {
      return reply.status(401).send({ fehler: 'Ungültiges Token' })
    }

    let dbOk = false
    try { await opts.db.execute(sql`SELECT 1`); dbOk = true } catch { /* DB weg */ }

    const backups  = await holeBackupStatus(opts.db, opts.dbBackupMaxStunden, opts.depBackupMaxStunden)
    const speicher = await holeSpeicherStatus(opts.dbBackupDir)
    // Nur 'kritisch' degradiert: bei 'knapp' soll gewarnt, aber nicht Alarm
    // ausgelöst werden. 'unbekannt' (Messung fehlgeschlagen) zählt als gesund —
    // ein kaputter Messpunkt ist kein Ausfall.
    const gesund   = dbOk && backups.gesund && speicher.zustand !== 'kritisch'

    return reply.status(gesund ? 200 : 503).send({
      status:    gesund ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version,
      checks: {
        db:        dbOk ? 'ok' : 'unreachable',
        dbBackup:  backups.dbBackup,
        depBackup: backups.depBackup,
        speicher,
      },
    })
  })

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

    // Backup-Frische (DB-Dump + DEP-Archiv)
    const backups = await holeBackupStatus(opts.db, opts.dbBackupMaxStunden, opts.depBackupMaxStunden)

    // Plattenplatz — Datenbank, Dumps und DEP-Archive teilen sich die Platte
    const speicher = await holeSpeicherStatus(opts.dbBackupDir)

    // Drucker-Keep-Alive: letzter Ping-Status + konfiguriertes Intervall
    const [mandant] = await opts.db
      .select({ intervall: mandanten.druckerKeepAliveSekunden })
      .from(mandanten)
      .where(eq(mandanten.id, request.user.mandantId))
      .limit(1)

    return reply.send({
      timestamp:  new Date().toISOString(),
      uptimeSek,
      version,
      druckerKeepAlive: {
        intervallSekunden: mandant?.intervall ?? 0,
        drucker:           holeDruckerKeepAliveStatus(request.user.mandantId),
      },
      nodeVersion: process.version,
      platform:   `${process.platform}/${process.arch}`,
      db: {
        ok:       dbOk,
        latenzMs: dbLatenzMs,
      },
      backups,
      speicher,
      memory: {
        heapUsedMb:  toMb(mem.heapUsed),
        heapTotalMb: toMb(mem.heapTotal),
        // Das ECHTE V8-Limit (max-old-space) — heapTotal ist nur der aktuell
        // reservierte Heap und liegt konstruktionsbedingt knapp über heapUsed
        // (90–98 % „Auslastung" dort sind normal und kein Warnsignal).
        heapLimitMb: toMb(v8.getHeapStatistics().heap_size_limit),
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

  // ── Drucker-Keep-Alive: Intervall einstellen + sofortiger Prüf-Lauf ────────

  fastify.patch('/api/admin/monitoring/keep-alive', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    if (request.user.rolle !== 'admin') {
      return reply.status(403).send({ fehler: 'Kein Zugriff' })
    }
    const body = z.object({
      // 0 = aus; nach oben auf 10 min gedeckelt — längere Pausen lassen Bondrucker
      // wieder in den Schlafmodus fallen und machen das Keep-Alive sinnlos.
      intervallSekunden: z.number().int().min(0).max(600),
    }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    await opts.db
      .update(mandanten)
      .set({ druckerKeepAliveSekunden: body.data.intervallSekunden, updatedAt: new Date() })
      .where(eq(mandanten.id, request.user.mandantId))

    return reply.send({ intervallSekunden: body.data.intervallSekunden })
  })

  fastify.post('/api/admin/monitoring/keep-alive/pruefen', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    if (request.user.rolle !== 'admin') {
      return reply.status(403).send({ fehler: 'Kein Zugriff' })
    }
    const ergebnis = await fuehreKeepAliveDurch(opts.db, Date.now(), {
      nurMandantId: request.user.mandantId,
      force:        true,
    })
    return reply.send({ drucker: ergebnis.get(request.user.mandantId) ?? [] })
  })
}
