/**
 * Tests für die Log-Konfiguration von buildServer (Fastify-LogController).
 *
 * Anlass: Seit dem Upgrade fastify 5.8.5 → 5.12.5 meldete jeder Backend-Start
 * und jeder Testlauf FSTDEP023 — die Top-Level-Option disableRequestLogging ist
 * deprecated und fällt in Fastify 6 weg. Bemerkt hat das kein Test. Die
 * Request-Logzeilen steuert jetzt ein LogController.
 *
 * Kernpunkte:
 *  - buildServer löst keine Fastify-Deprecation-Warnung aus (auch nicht im
 *    Nicht-Test-Modus, wo die alte Option `false` hieß und trotzdem warnte);
 *    der Test schlägt damit auch bei künftigen Deprecations an
 *  - NODE_ENV=test: keine Request-Logzeilen — die Tests bleiben still
 *  - sonst: „incoming request" / „request completed" wie gewohnt
 */

import { describe, it, expect, afterEach } from 'vitest'
import { buildTestServer, type TestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

/** Reicht für /api/health: der Aufruf prüft nur, dass die DB antwortet. */
const dbAttrappe = { execute: async () => [] } as unknown as Db

/** Log-Zeilen eines Test-Servers (pino-JSON) einsammeln. */
function logSammler() {
  const zeilen: Array<{ msg?: string }> = []
  return {
    stream:    { write: (zeile: string) => { zeilen.push(JSON.parse(zeile) as { msg?: string }) } },
    meldungen: () => zeilen.map(z => z.msg),
  }
}

describe('Log-Konfiguration (buildServer)', () => {
  let srv: TestServer | undefined

  afterEach(async () => {
    await srv?.close()
    srv = undefined
  })

  it('löst keine Fastify-Deprecation-Warnung aus (test und development)', async () => {
    const warnungen: string[] = []
    const merker = (w: Error & { code?: string }) => {
      if (w.name === 'FastifyDeprecation') warnungen.push(`${w.code}: ${w.message}`)
    }
    process.on('warning', merker)
    try {
      for (const nodeEnv of ['test', 'development'] as const) {
        const s = await buildTestServer(dbAttrappe, { config: { NODE_ENV: nodeEnv } })
        await s.close()
      }
      // process.emitWarning meldet erst im nächsten Tick
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('warning', merker)
    }
    expect(warnungen).toEqual([])
  })

  it('NODE_ENV=test: keine Request-Logzeilen', async () => {
    const log = logSammler()
    srv = await buildTestServer(dbAttrappe, {
      config:    { LOG_LEVEL: 'info', NODE_ENV: 'test' },
      logStream: log.stream,
    })

    expect((await srv.fastify.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/gibt-es-nicht' })).statusCode).toBe(404)

    const meldungen = log.meldungen()
    expect(meldungen).not.toContain('incoming request')
    expect(meldungen).not.toContain('request completed')
    expect(meldungen).not.toContain('Route GET:/api/gibt-es-nicht not found')
  })

  it('NODE_ENV=development: Request-Logzeilen erscheinen wie gewohnt', async () => {
    const log = logSammler()
    srv = await buildTestServer(dbAttrappe, {
      config:    { LOG_LEVEL: 'info', NODE_ENV: 'development' },
      logStream: log.stream,
    })

    expect((await srv.fastify.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/gibt-es-nicht' })).statusCode).toBe(404)

    const meldungen = log.meldungen()
    expect(meldungen.filter(m => m === 'incoming request')).toHaveLength(2)
    expect(meldungen.filter(m => m === 'request completed')).toHaveLength(2)
    expect(meldungen).toContain('Route GET:/api/gibt-es-nicht not found')
  })
})
