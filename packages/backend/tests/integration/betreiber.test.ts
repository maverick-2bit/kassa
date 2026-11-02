/**
 * Integrationstest: Betreiber der Installation.
 *
 * Eine Installation hostet mehrere Mandanten. Dinge, die den ganzen Rechner betreffen — ein Dump der
 * GANZEN Datenbank (alle Mandanten), das Update, die Systemwerte, ein weiterer Mandant — darf nicht jeder
 * Mandanten-Admin. Früher genügte `rolle === 'admin'`: der Admin des kleinsten Betriebs zog die Daten aller
 * anderen herunter. Jetzt zählt `users.ist_betreiber`, und zwar der Stand in der Datenbank (nicht das Token).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { count, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { dbSicherungen, mandanten, users } from '../../src/db/schema.js'
import { exportiereMandant, importiereMandant } from '../../src/services/mandant-transfer.service.js'
import { buildTestServer, TEST_MASTER, TEST_SETUP_TOKEN, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'betreiber-passwort-123'

function fo(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BT-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const einrichtung = (nr: number) => ({
  firmenname: `Betreiber ${nr} GmbH`,
  uid:        `ATU7777770${nr}`,
  kassenId:   `BT-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-BT-${nr}`, benutzerkennung: `BID-BT-${nr}`, pin: `PIN-BT-${nr}` },
  umgebung: 'test',
  admin: { name: `Admin ${nr}`, email: `admin${nr}@betreiber.at`, passwort: PASSWORT },
})

describe('Betreiber-Rechte (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let verzeichnis: string
  let tokenA: string    // Admin des ersten Mandanten = Betreiber
  let tokenB: string    // Admin eines zweiten Mandanten — kein Betreiber
  let tokenA2: string   // zweiter Admin DESSELBEN Mandanten wie A — kein Betreiber
  let idA = '', idA2 = ''
  let sicherungId = ''

  const h = (token: string) => ({ authorization: `Bearer ${token}` })
  const login = async (email: string): Promise<{ token: string; id: string }> => {
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, passwort: PASSWORT } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { token: string; user: { id: string } }
    return { token: body.token, id: body.user.id }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    // DATABASE_URL: der Übergabe-Export öffnet eine eigene Verbindung
    srv = await buildTestServer(idb.db, { finanzOnlineClient: fo(), config: { DATABASE_URL: idb.url } })
    verzeichnis = mkdtempSync(join(tmpdir(), 'kassa-betreiber-'))

    expect((await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: einrichtung(1) })).statusCode).toBe(201)
    expect((await srv.fastify.inject({
      method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: einrichtung(2),
    })).statusCode).toBe(201)

    const a = await login('admin1@betreiber.at'); tokenA = a.token; idA = a.id
    tokenB = (await login('admin2@betreiber.at')).token

    // Zweiter Admin im Mandanten von A — vom Betreiber angelegt, aber selbst kein Betreiber
    const neu = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: h(tokenA),
      payload: { name: 'Zweiter Admin', email: 'a2@betreiber.at', passwort: PASSWORT, rolle: 'admin', berechtigungen: [], kassenIds: [] },
    })
    expect(neu.statusCode).toBe(201)
    const a2 = await login('a2@betreiber.at'); tokenA2 = a2.token; idA2 = a2.id

    // Eine Sicherung zum Herunterladen (Datei + Zeile; pg_dump selbst testet db-backup.test.ts)
    const datei = join(verzeichnis, 'dump.sql.gz')
    writeFileSync(datei, 'SELECT 1;')
    const [zeile] = await idb.db.insert(dbSicherungen).values({
      dateiname: 'dump.sql.gz', dateipfad: datei, dateigroesse: 9, erfolgreich: true,
    }).returning()
    sicherungId = zeile!.id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
    if (verzeichnis) rmSync(verzeichnis, { recursive: true, force: true })
  })

  it('der erste Admin ist Betreiber, weitere Admins und Mandanten nicht', async () => {
    const alle = await idb.db.select({ email: users.email, istBetreiber: users.istBetreiber }).from(users)
    expect(Object.fromEntries(alle.map(u => [u.email, u.istBetreiber]))).toEqual({
      'admin1@betreiber.at': true,
      'admin2@betreiber.at': false,
      'a2@betreiber.at':     false,
    })
  })

  it('System-Status meldet jedem, ob er Betreiber ist (frisch aus der Datenbank)', async () => {
    const status = async (token: string) =>
      (await srv.fastify.inject({ method: 'GET', url: '/api/system/status', headers: h(token) })).json() as { istBetreiber: boolean }
    expect((await status(tokenA)).istBetreiber).toBe(true)
    expect((await status(tokenB)).istBetreiber).toBe(false)
    expect((await status(tokenA2)).istBetreiber).toBe(false)
  })

  describe('Datenbank-Sicherung (Dump der GANZEN Datenbank)', () => {
    it('der Betreiber sieht die Liste und lädt Sicherungen herunter', async () => {
      const liste = await srv.fastify.inject({ method: 'GET', url: '/api/db-sicherungen', headers: h(tokenA) })
      expect(liste.statusCode).toBe(200)
      expect((liste.json() as { id: string }[]).map(s => s.id)).toContain(sicherungId)

      const datei = await srv.fastify.inject({ method: 'GET', url: `/api/db-sicherungen/${sicherungId}/download`, headers: h(tokenA) })
      expect(datei.statusCode).toBe(200)
      expect(datei.body).toBe('SELECT 1;')
    })

    it.each([
      ['Admin eines anderen Mandanten', () => tokenB],
      ['zweiter Admin im Mandanten des Betreibers', () => tokenA2],
    ])('%s: Liste, Anlegen und Download sind 403', async (_name, token) => {
      const vorher = (await idb.db.select({ n: count() }).from(dbSicherungen))[0]!.n
      for (const [method, url] of [
        ['GET',  '/api/db-sicherungen'],
        ['POST', '/api/db-sicherungen'],
        ['GET',  `/api/db-sicherungen/${sicherungId}/download`],
      ] as const) {
        const res = await srv.fastify.inject({ method, url, headers: h(token()) })
        expect(res.statusCode, `${method} ${url}`).toBe(403)
        expect(res.body).not.toContain('SELECT 1;')
      }
      // Es wurde keine Sicherung angestoßen
      expect((await idb.db.select({ n: count() }).from(dbSicherungen))[0]!.n).toBe(vorher)
    })

    it('ohne Anmeldung 401', async () => {
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/db-sicherungen' })).statusCode).toBe(401)
    })
  })

  describe('Update der Kassa', () => {
    it('nur der Betreiber löst es aus (hier ohne Update-Dienst: 409 statt 403)', async () => {
      expect((await srv.fastify.inject({ method: 'POST', url: '/api/system/update', headers: h(tokenA) })).statusCode).toBe(409)
      expect((await srv.fastify.inject({ method: 'POST', url: '/api/system/update', headers: h(tokenB) })).statusCode).toBe(403)
      expect((await srv.fastify.inject({ method: 'POST', url: '/api/system/update', headers: h(tokenA2) })).statusCode).toBe(403)
    })
  })

  describe('Systemüberwachung', () => {
    it('der Betreiber sieht die Werte des Rechners', async () => {
      const res = await srv.fastify.inject({ method: 'GET', url: '/api/admin/monitoring', headers: h(tokenA) })
      expect(res.statusCode).toBe(200)
      const b = res.json() as Record<string, unknown>
      for (const feld of ['uptimeSek', 'db', 'speicher', 'backups', 'memory', 'cpu', 'system', 'nodeVersion', 'platform', 'druckerKeepAlive']) {
        expect(b, feld).toHaveProperty(feld)
      }
    })

    it('ein anderer Admin sieht nur die Drucker seines Betriebs', async () => {
      for (const token of [tokenB, tokenA2]) {
        const res = await srv.fastify.inject({ method: 'GET', url: '/api/admin/monitoring', headers: h(token) })
        expect(res.statusCode).toBe(200)
        expect(Object.keys(res.json() as object).sort()).toEqual(['druckerKeepAlive', 'timestamp', 'version'])
      }
    })

    it('das Keep-Alive des eigenen Betriebs stellt jeder Admin selbst ein', async () => {
      const res = await srv.fastify.inject({
        method: 'PATCH', url: '/api/admin/monitoring/keep-alive', headers: h(tokenB), payload: { intervallSekunden: 60 },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('Mandant einspielen (legt einen weiteren Mandanten an)', () => {
    it('nur der Betreiber; das Exportieren des eigenen Mandanten bleibt jedem Admin', async () => {
      const body = { passwort: 'irgendein-passwort', datei: 'AAAA' }
      const a = await srv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/import', headers: h(tokenA), payload: body })
      expect(a.statusCode).toBe(400)   // Betreiber kommt durch — die Datei ist natürlich ungültig
      const b = await srv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/import', headers: h(tokenB), payload: body })
      expect(b.statusCode).toBe(403)

      const export_ = await srv.fastify.inject({
        method: 'POST', url: '/api/mandant-uebergabe/export', headers: h(tokenB),
        payload: { passwort: 'zehn-zeichen-mindestens', sperren: false },
      })
      expect(export_.statusCode).toBe(200)
    })
  })

  describe('Betreiber-Konten', () => {
    it('ein anderer Admin desselben Mandanten kann sie nicht ändern (sonst: Passwort zurücksetzen = Betreiber werden)', async () => {
      const aenderung = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${idA}`, headers: h(tokenA2), payload: { passwort: 'ein-neues-passwort-1' },
      })
      expect(aenderung.statusCode).toBe(403)
      const pin = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${idA}`, headers: h(tokenA2), payload: { pin: '1357' },
      })
      expect(pin.statusCode).toBe(403)
      const sperren = await srv.fastify.inject({ method: 'DELETE', url: `/api/users/${idA}`, headers: h(tokenA2) })
      expect(sperren.statusCode).toBe(403)

      // Das alte Passwort gilt unverändert
      const [a] = await idb.db.select().from(users).where(eq(users.id, idA))
      expect(a!.aktiv).toBe(true)
      expect(a!.pinHash).toBeNull()
      const noch = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: 'admin1@betreiber.at', passwort: PASSWORT },
      })
      expect(noch.statusCode).toBe(200)
    })

    it('der Betreiber ändert andere Konten und sich selbst — nur nicht den letzten Betreiber stilllegen', async () => {
      const name = await srv.fastify.inject({ method: 'PUT', url: `/api/users/${idA2}`, headers: h(tokenA), payload: { name: 'Zweiter Admin (neu)' } })
      expect(name.statusCode).toBe(200)

      const selbst = await srv.fastify.inject({ method: 'PUT', url: `/api/users/${idA}`, headers: h(tokenA), payload: { name: 'Betreiber A' } })
      expect(selbst.statusCode).toBe(200)

      const still = await srv.fastify.inject({ method: 'PUT', url: `/api/users/${idA}`, headers: h(tokenA), payload: { aktiv: false } })
      expect(still.statusCode).toBe(409)
      const [a] = await idb.db.select().from(users).where(eq(users.id, idA))
      expect(a!.aktiv).toBe(true)
    })

    it('das Betreiber-Flag lässt sich über keine API setzen — weder beim Anlegen noch beim Ändern', async () => {
      const neu = await srv.fastify.inject({
        method: 'POST', url: '/api/users', headers: h(tokenA),
        payload: { name: 'Eingeschleust', email: 'x@betreiber.at', passwort: PASSWORT, rolle: 'admin', berechtigungen: [], kassenIds: [], istBetreiber: true, ist_betreiber: true },
      })
      expect(neu.statusCode).toBe(201)
      const geaendert = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${idA2}`, headers: h(tokenA), payload: { istBetreiber: true, ist_betreiber: true },
      })
      expect(geaendert.statusCode).toBe(200)

      const alle = await idb.db.select({ email: users.email, istBetreiber: users.istBetreiber }).from(users)
      expect(alle.filter(u => u.istBetreiber).map(u => u.email)).toEqual(['admin1@betreiber.at'])
    })
  })

  it('ein deaktivierter Betreiber verliert sofort alle Rechte — sein Token gilt noch, aber nicht mehr dafür', async () => {
    await idb.db.update(users).set({ aktiv: false }).where(eq(users.id, idA))
    try {
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/db-sicherungen', headers: h(tokenA) })).statusCode).toBe(403)
      expect((await srv.fastify.inject({ method: 'POST', url: '/api/system/update', headers: h(tokenA) })).statusCode).toBe(403)
      const mon = await srv.fastify.inject({ method: 'GET', url: '/api/admin/monitoring', headers: h(tokenA) })
      expect(Object.keys(mon.json() as object)).not.toContain('db')
    } finally {
      await idb.db.update(users).set({ aktiv: true }).where(eq(users.id, idA))
    }
  })
})

describe('Mandanten-Übergabe darf kein Betreiber-Konto mitbringen (Integration)', () => {
  let quelle: IntegrationsDb, ziel: IntegrationsDb
  let quellSrv: TestServer
  let quellSql: ReturnType<typeof postgres>, zielSql: ReturnType<typeof postgres>
  let mandantA = '', mandantB = ''

  beforeAll(async () => {
    quelle = await erstelleIntegrationsDb()
    ziel   = await erstelleIntegrationsDb()
    quellSrv = await buildTestServer(quelle.db, { finanzOnlineClient: fo() })
    expect((await quellSrv.fastify.inject({ method: 'POST', url: '/api/setup', payload: einrichtung(1) })).statusCode).toBe(201)
    expect((await quellSrv.fastify.inject({
      method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: einrichtung(2),
    })).statusCode).toBe(201)
    const ms = await quelle.db.select().from(mandanten)
    mandantA = ms.find(m => m.firmenname === 'Betreiber 1 GmbH')!.id
    mandantB = ms.find(m => m.firmenname === 'Betreiber 2 GmbH')!.id
    quellSql = postgres(quelle.url, { max: 2, onnotice: () => {}, fetch_types: false })
    zielSql  = postgres(ziel.url,   { max: 2, onnotice: () => {}, fetch_types: false })
  })

  afterAll(async () => {
    await quellSql?.end(); await zielSql?.end()
    await quellSrv?.close()
    await quelle?.zerstoeren(); await ziel?.zerstoeren()
  })

  it('der Export enthält die Spalte nicht — auch nicht für den Betreiber selbst', async () => {
    const daten = await exportiereMandant(quellSql, mandantA, TEST_MASTER)
    expect(daten.tabellen['users']).toHaveLength(1)
    expect(Object.keys(daten.tabellen['users']![0]!)).not.toContain('ist_betreiber')
  })

  it('eine präparierte Datei macht ihren Admin im Ziel NICHT zum Betreiber', async () => {
    const daten = JSON.parse(JSON.stringify(await exportiereMandant(quellSql, mandantB, TEST_MASTER))) as
      Awaited<ReturnType<typeof exportiereMandant>>
    // Wer eine Übergabedatei einspielen darf, kann sie auch selbst bauen
    daten.tabellen['users']![0]!['ist_betreiber'] = true

    await importiereMandant(zielSql, daten, 'ziel-passphrase-ganz-anders-2')

    const [admin] = await ziel.db.select().from(users).where(eq(users.mandantId, mandantB))
    expect(admin).toBeDefined()
    expect(admin!.istBetreiber).toBe(false)
    expect((await ziel.db.select({ n: count() }).from(users).where(eq(users.istBetreiber, true)))[0]!.n).toBe(0)
  })
})
