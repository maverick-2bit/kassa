/**
 * Integrationstest: Zeiterfassung gegen echtes PostgreSQL.
 *
 * PIN-basiertes Kommen/Gehen. Prüft: Modul-Gating (403), Ein-/Ausstempeln
 * (Toggle) mit Arbeitsdauer, ungültiger PIN (401), aktuelle Schicht + Liste.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { mandanten } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@zeiterfassung.at'
const ADMIN_PASSWORT = 'zeiterfassung-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Zeiterfassung GmbH',
  uid:        'ATU99999914',
  kassenId:   'ZE-001',
  finanzOnline: { teilnehmerId: 'TID-ZE', benutzerkennung: 'BID-ZE', pin: 'PIN-ZE' },
  umgebung: 'test',
  admin: { name: 'ZE Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Zeiterfassung (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const stempeln = (pin: string) =>
    srv.fastify.inject({ method: 'POST', url: '/api/zeiterfassung/stempeln', payload: { kasseId, pin } })

  async function neuerUser(name: string, email: string, pin: string): Promise<string> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { name, email, passwort: 'user-passwort-123', rolle: 'kellner', berechtigungen: [], kassenIds: [kasseId], pin },
    })
    if (r.statusCode !== 201) throw new Error(`User ${name} (${r.statusCode}): ${r.body}`)
    return r.json().id
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

    await neuerUser('Karl Kellner', 'karl@zeiterfassung.at', '1234')
    await neuerUser('Bea Barkeeper', 'bea@zeiterfassung.at', '5678')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  describe('Modul deaktiviert (Default)', () => {
    it('Stempeln liefert 403, solange das Modul aus ist', async () => {
      const res = await stempeln('1234')
      expect(res.statusCode).toBe(403)
    })
  })

  describe('Modul aktiv', () => {
    beforeAll(async () => {
      await idb.db.update(mandanten).set({ modulZeiterfassungAktiv: true }).where(eq(mandanten.id, mandantId))
    })

    it('stempelt ein und beim zweiten Mal wieder aus (mit Arbeitsdauer)', async () => {
      const ein = await stempeln('1234')
      expect(ein.statusCode).toBe(200)
      expect(ein.json().aktion).toBe('eingestempelt')
      expect(ein.json().userName).toBe('Karl Kellner')

      const aus = await stempeln('1234')
      expect(aus.statusCode).toBe(200)
      const r = aus.json()
      expect(r.aktion).toBe('ausgestempelt')
      expect(r.beginn).toBeTruthy()
      expect(r.ende).toBeTruthy()
      expect(typeof r.dauerMinuten).toBe('number')
      expect(r.dauerMinuten).toBeGreaterThanOrEqual(0)
    })

    it('lehnt einen ungültigen PIN ab (401)', async () => {
      const res = await stempeln('0000')
      expect(res.statusCode).toBe(401)
    })

    it('zeigt eine eingestempelte Schicht unter "aktuell" und in der Liste', async () => {
      // Bea einstempeln (bleibt offen)
      const ein = await stempeln('5678')
      expect(ein.json().aktion).toBe('eingestempelt')

      const aktuell = await srv.fastify.inject({
        method: 'GET', url: '/api/zeiterfassung/aktuell', headers: auth(),
      })
      expect(aktuell.statusCode).toBe(200)
      expect((aktuell.json() as { userName: string }[]).some(s => s.userName === 'Bea Barkeeper')).toBe(true)

      const liste = await srv.fastify.inject({ method: 'GET', url: '/api/zeiterfassung', headers: auth() })
      expect(liste.statusCode).toBe(200)
      // Karls abgeschlossene + Beas offene Schicht
      expect((liste.json() as unknown[]).length).toBeGreaterThanOrEqual(2)
    })
  })
})
