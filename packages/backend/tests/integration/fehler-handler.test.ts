/**
 * Integrationstest: globaler Fehler-Handler (echtes PostgreSQL).
 *
 * Befund 2026-09-24: setErrorHandler stand am Ende von buildServer, NACH allen
 * Routen-Plugins. Fastify gibt den Handler aber nur an Plugin-Kontexte weiter,
 * die danach entstehen — unerwartete Fehler landeten im Fastify-Standard-
 * Handler, und der schickte die interne Meldung an den Client: bei DB-Fehlern
 * „Failed query: <SQL> params: <Werte>" samt Constraint-Namen und Eingaben.
 *
 * Kernpunkte:
 *  - unerwarteter Fehler → 500 { fehler: 'Interner Serverfehler' } ohne SQL,
 *    Constraint-Namen oder Eingabewerte; die Einzelheiten stehen im Log
 *  - gilt in jedem Registrierungs-Kontext (Funktion direkt an der Root-Instanz,
 *    /api-Plugin, Plugin nach dem /api-Plugin)
 *  - Fehler mit Status < 500 bleiben unverändert: Schema-Validierung 400,
 *    kaputtes JSON 400, Rate-Limit 429 { statusCode, fehler } — und sie stehen
 *    nicht als Serverfehler im Log
 *  - Fachfehler, den eine Route nicht abfängt, behält Status und Meldung
 *  - SSE-Route, die NACH raw.writeHead scheitert: Stream endet (der Client
 *    verbindet neu), statt ohne Daten offen zu hängen
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { schema, type Db } from '../../src/db/client.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'FH-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const EMAIL    = 'admin@fehler-handler.at'
const PASSWORT = 'fehler-handler-passwort-1'

const INTERN = { fehler: 'Interner Serverfehler' }

/** Nichts davon darf je beim Client ankommen. */
const INTERNE_DETAILS = /Failed query|params:|duplicate key|constraint|insert into|select |kassa_test_|kassa_gibt_es_nicht/i

/** Log-Zeilen eines Test-Servers (pino-JSON) — gefiltert auf den Handler-Eintrag. */
function logSammler() {
  const zeilen: string[] = []
  return {
    stream: { write: (zeile: string) => { zeilen.push(zeile) } },
    leeren: () => { zeilen.length = 0 },
    serverfehler: () => zeilen
      .map(z => JSON.parse(z) as { msg?: string; err?: { message?: string } })
      .filter(e => e.msg === 'Unbehandelter Serverfehler'),
  }
}

describe('Globaler Fehler-Handler (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  const log = logSammler()

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, {
      finanzOnlineClient: mockFoClient(),
      config:    { LOG_LEVEL: 'error' },
      logStream: log.stream,
    })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Fehler Handler OG', uid: 'ATU99999942', kassenId: 'FH-001',
        finanzOnline: { teilnehmerId: 'TID-FH', benutzerkennung: 'BID-FH', pin: 'PIN-FH' },
        umgebung: 'test',
        admin: { name: 'FH Admin', email: EMAIL, passwort: PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup: ${setup.body}`)
    const login = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, passwort: PASSWORT } })
    if (login.statusCode !== 200) throw new Error(`Login: ${login.body}`)
    token   = login.json().token
    kasseId = login.json().kassen[0].id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  beforeEach(() => log.leeren())

  it('unerwarteter DB-Fehler: 500 ohne interne Meldung, Einzelheiten nur im Log', async () => {
    // Echte Constraint-Verletzung wie im Befund (users_email_key) — hier über
    // einen Test-Index, den keine Route vorab prüft.
    await idb.db.execute(sql.raw('CREATE UNIQUE INDEX fehlertest_kategorie_name ON kategorien (name)'))
    try {
      const anlegen = () => srv.fastify.inject({
        method: 'POST', url: '/api/kategorien', headers: auth(),
        payload: { name: 'Geheimsache 4711', farbe: 'rot' },
      })
      expect((await anlegen()).statusCode).toBe(201)

      const res = await anlegen()
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual(INTERN)
      expect(res.body).not.toMatch(INTERNE_DETAILS)
      expect(res.body).not.toContain('Geheimsache 4711')

      // Die Diagnose geht nicht verloren: SQL-Text im Log
      const eintraege = log.serverfehler()
      expect(eintraege).toHaveLength(1)
      expect(eintraege[0]!.err?.message).toContain('insert into "kategorien"')
    } finally {
      await idb.db.execute(sql.raw('DROP INDEX IF EXISTS fehlertest_kategorie_name'))
    }
  })

  it('Fachfehler, den die Route nicht abfängt: Status + Meldung statt 500', async () => {
    // Die Angebots-Route fängt nur AngebotError — der KundeError für einen
    // fremden Kunden rutscht bis zum globalen Handler durch.
    const fremderKunde = '40000000-0000-0000-0000-000000000001'
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/angebote', headers: auth(),
      payload: {
        kasseId,
        kundeId: fremderKunde,
        positionen: [{ bezeichnung: 'Beratung', menge: 1, einzelpreisBreutto: 1000, mwstSatz: 'normal' }],
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ fehler: `Kunde ${fremderKunde} nicht gefunden` })
    expect(log.serverfehler()).toHaveLength(0)
  })

  describe('Datenbank nicht erreichbar — jeder Registrierungs-Kontext', () => {
    let kaputtSql: ReturnType<typeof postgres>
    let srvOhneDb: TestServer
    const logOhneDb = logSammler()

    beforeAll(async () => {
      const url = new URL(idb.url)
      url.pathname = '/kassa_gibt_es_nicht'
      kaputtSql = postgres(url.toString(), { max: 1, fetch_types: false, onnotice: () => {} })
      srvOhneDb = await buildTestServer(drizzle(kaputtSql, { schema }) as Db, {
        finanzOnlineClient: mockFoClient(),
        config:    { LOG_LEVEL: 'error' },
        logStream: logOhneDb.stream,
      })
    })

    afterAll(async () => {
      await srvOhneDb?.close()
      await kaputtSql?.end()
    })

    it.each([
      ['Funktion direkt an der Root-Instanz (vor /api)', 'GET',   '/api/terminal/sortiment?kasseId=30000000-0000-0000-0000-000000000001', undefined],
      ['Plugin im /api-Prefix',                          'GET',   '/api/kategorien', undefined],
      ['Plugin nach dem /api-Plugin',                    'PATCH', '/api/admin/monitoring/keep-alive', { intervallSekunden: 60 }],
    ] as const)('%s: 500 ohne interne Meldung', async (_kontext, method, url, payload) => {
      logOhneDb.leeren()
      const res = await srvOhneDb.fastify.inject({
        method, url, headers: srvOhneDb.authHeader(), ...(payload && { payload }),
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual(INTERN)
      expect(res.body).not.toMatch(INTERNE_DETAILS)
      expect(logOhneDb.serverfehler()).toHaveLength(1)
    })

    it('SSE-Route scheitert nach raw.writeHead: Stream endet statt offen zu hängen', async () => {
      // /api/kds/events prüft das Token, schreibt die SSE-Header und holt DANACH
      // den Bon-Snapshot aus der DB. Ohne Abschluss hinge inject hier bis zum
      // Test-Timeout, und Fastifys Antwortversuch endete als unbehandelte
      // Rejection (ERR_HTTP_HEADERS_SENT), die vitest als Fehler meldet.
      logOhneDb.leeren()
      const token = srvOhneDb.signTestToken()
      const res = await srvOhneDb.fastify.inject({ method: 'GET', url: `/api/kds/events?station=kueche&token=${token}` })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.body).toBe('')
      expect(logOhneDb.serverfehler()).toHaveLength(1)
    })
  })

  it('Schema-Validierung: 400 im Fastify-Format bleibt unverändert', async () => {
    // Querystring-Schema der KDS-SSE-Route: station muss ein String sein
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/kds/events?station=a&station=b' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      statusCode: 400,
      code:       'FST_ERR_VALIDATION',
      error:      'Bad Request',
      message:    'querystring/station must be string',
    })
    expect(log.serverfehler()).toHaveLength(0)
  })

  it('kaputtes JSON: 400 im Fastify-Format bleibt unverändert', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: '{"name": "abgeschnitten',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      statusCode: 400,
      code:       'FST_ERR_CTP_INVALID_JSON_BODY',
      error:      'Bad Request',
      message:    "Body is not valid JSON but content-type is set to 'application/json'",
    })
    expect(log.serverfehler()).toHaveLength(0)
  })

  it('Rate-Limit: 429 mit { statusCode, fehler } bleibt unverändert', async () => {
    const logLimit = logSammler()
    const srvLimit = await buildTestServer(idb.db, {
      finanzOnlineClient: mockFoClient(),
      rateLimitMax: 2,
      config:    { LOG_LEVEL: 'error' },
      logStream: logLimit.stream,
    })
    try {
      const health = () => srvLimit.fastify.inject({ method: 'GET', url: '/api/health' })
      expect((await health()).statusCode).toBe(200)
      expect((await health()).statusCode).toBe(200)

      const res = await health()
      expect(res.statusCode).toBe(429)
      expect(res.json()).toEqual({ statusCode: 429, fehler: expect.stringContaining('Zu viele Anfragen') })
      expect(res.headers['retry-after']).toBeDefined()
      expect(logLimit.serverfehler()).toHaveLength(0)
    } finally {
      await srvLimit.close()
    }
  })
})
