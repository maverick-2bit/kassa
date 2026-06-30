/**
 * Integrationstest: Monitoring-/Health-Status gegen echtes PostgreSQL.
 *
 * Prüft den token-geschützten externen Endpoint (/api/monitoring/status):
 * Token-Gating, Backup-Frische (fehlt/ok/veraltet) und der daraus abgeleitete
 * HTTP-Status (200 gesund / 503 degradiert), sowie den Admin-Monitoring-Block.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { dbSicherungen, depSicherungen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@monitoring.at'
const ADMIN_PASSWORT = 'monitoring-passwort-123'
const TOKEN          = 'test-monitoring-token'   // muss zum testServer-Config-Wert passen

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Monitoring GmbH',
  uid:        'ATU99999916',
  kassenId:   'MON-001',
  finanzOnline: { teilnehmerId: 'TID-MON', benutzerkennung: 'BID-MON', pin: 'PIN-MON' },
  umgebung: 'test',
  admin: { name: 'MON Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

const stundenHer = (h: number) => new Date(Date.now() - h * 3_600_000)

describe('Monitoring-Status (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const status = (t = TOKEN) =>
    srv.fastify.inject({ method: 'GET', url: `/api/monitoring/status?token=${t}` })

  async function resetSicherungen() {
    await idb.db.delete(dbSicherungen)
    await idb.db.delete(depSicherungen)
  }
  async function dbSicherung(alterStunden: number, erfolgreich = true) {
    await idb.db.insert(dbSicherungen).values({
      erstelltAm: stundenHer(alterStunden), dateiname: 'dump.sql', dateipfad: '/backups/dump.sql', erfolgreich,
    })
  }
  async function depSicherung(alterStunden: number) {
    await idb.db.insert(depSicherungen).values({
      mandantId, kasseId, erstelltAm: stundenHer(alterStunden),
      format: 'dep7', anzahlBelege: 5, dateipfad: '/backups/dep.json', dateiname: 'dep.json',
    })
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token     = login.token
    kasseId   = login.kassen[0].id
    mandantId = login.mandant.id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert ohne/mit falschem Token (401)', async () => {
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/monitoring/status' })).statusCode).toBe(401)
    expect((await status('falsch')).statusCode).toBe(401)
  })

  it('ohne Sicherungen: gesund (200), Zustand "fehlt" (z. B. frische Installation)', async () => {
    await resetSicherungen()
    const res = await status()
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.status).toBe('ok')
    expect(b.checks.dbBackup.zustand).toBe('fehlt')
    expect(b.checks.depBackup.zustand).toBe('fehlt')
  })

  it('mit frischen Sicherungen: gesund (200), Zustand "ok"', async () => {
    await resetSicherungen()
    await dbSicherung(1)
    await depSicherung(2)
    const res = await status()
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.status).toBe('ok')
    expect(b.checks.dbBackup.zustand).toBe('ok')
    expect(b.checks.dbBackup.alterStunden).toBeLessThan(2)
    expect(b.checks.depBackup.zustand).toBe('ok')
  })

  it('mit veralteter Sicherung: degradiert (503)', async () => {
    await resetSicherungen()
    await dbSicherung(48)   // > 26h Schwelle
    await depSicherung(1)
    const res = await status()
    expect(res.statusCode).toBe(503)
    const b = res.json()
    expect(b.status).toBe('degraded')
    expect(b.checks.dbBackup.zustand).toBe('veraltet')
  })

  it('ignoriert fehlgeschlagene DB-Sicherungen (nur erfolgreiche zählen)', async () => {
    await resetSicherungen()
    await dbSicherung(1, false)   // frisch, aber fehlgeschlagen -> zählt nicht
    const res = await status()
    expect(res.json().checks.dbBackup.zustand).toBe('fehlt')
  })

  it('Admin-Monitoring enthält den Backup-Block und braucht Auth', async () => {
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/admin/monitoring' })).statusCode).toBe(401)
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/admin/monitoring', headers: auth() })
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.backups).toBeDefined()
    expect(b.backups.dbBackup).toBeDefined()
    expect(b.backups.depBackup).toBeDefined()
  })
})
