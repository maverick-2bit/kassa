/**
 * Integrationstest: öffentlicher Self-Checkout gegen echtes PostgreSQL.
 *
 *  GET  /api/selfcheckout?kasseId=&tisch=     — offenen Tab anzeigen
 *  POST /api/selfcheckout/zahlung-anfordern   — Zahlung anfordern (SSE an Kasse)
 *
 * Geprüft: Aktivierungs-Gating (403 wenn deaktiviert), Tab-Summe, "kein Tab"-
 * Antwort, sowie der 30s-Debounce gegen Spam (429 bei sofortiger Wiederholung).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@selfcheckout.at'
const ADMIN_PASSWORT = 'selfcheckout-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Selfcheckout Test GmbH',
  uid:        'ATU99999905',
  kassenId:   'SCO-001',
  finanzOnline: { teilnehmerId: 'TID-SCO', benutzerkennung: 'BID-SCO', pin: 'PIN-SCO' },
  umgebung: 'test',
  admin: { name: 'SCO Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Self-Checkout (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const TISCH = 'Tisch 5'

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Artikel anlegen und per Gast-Bestellung einen offenen Tab auf TISCH erzeugen
    const kat = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'Speisen', farbe: 'gruen', reihenfolge: 0 },
    })
    const a = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Schnitzel', preisBruttoCent: 1490, mwstSatz: 'normal', kategorieId: kat.json().id },
    })
    const artikelId = a.json().id
    await srv.fastify.inject({
      method: 'POST', url: '/api/gast/bestellung',
      payload: { kasseId, tischNummer: TISCH, positionen: [{ artikelId, menge: 2 }] },
    })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Self-Checkout deaktiviert (Default) ──────────────────────────────────────
  describe('deaktiviert (Default)', () => {
    it('GET liefert 403', async () => {
      const res = await srv.fastify.inject({
        method: 'GET', url: `/api/selfcheckout?kasseId=${kasseId}&tisch=${encodeURIComponent(TISCH)}`,
      })
      expect(res.statusCode).toBe(403)
    })

    it('POST zahlung-anfordern liefert 403', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/selfcheckout/zahlung-anfordern',
        payload: { kasseId, tisch: TISCH },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  // ── Self-Checkout aktiviert ──────────────────────────────────────────────────
  describe('aktiviert', () => {
    beforeAll(async () => {
      await idb.db.update(kassen).set({ selfCheckoutAktiv: true }).where(eq(kassen.id, kasseId))
    })

    it('zeigt den offenen Tab mit korrekter Summe', async () => {
      const res = await srv.fastify.inject({
        method: 'GET', url: `/api/selfcheckout?kasseId=${kasseId}&tisch=${encodeURIComponent(TISCH)}`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.offen).toBe(true)
      expect(body.tisch).toBe(TISCH)
      expect(body.summeCent).toBe(2 * 1490)
      expect(body.positionen[0].gesamtCent).toBe(2 * 1490)
    })

    it('liefert offen=false für einen Tisch ohne Tab', async () => {
      const res = await srv.fastify.inject({
        method: 'GET', url: `/api/selfcheckout?kasseId=${kasseId}&tisch=Tisch%2099`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ offen: false, summeCent: 0 })
    })

    it('fordert Zahlung an und debounced Wiederholungen (429)', async () => {
      const erste = await srv.fastify.inject({
        method: 'POST', url: '/api/selfcheckout/zahlung-anfordern',
        payload: { kasseId, tisch: TISCH },
      })
      expect(erste.statusCode).toBe(200)
      expect(erste.json()).toMatchObject({ erfolgreich: true, summeCent: 2 * 1490 })

      // sofortige Wiederholung -> 429 (30s-Sperre)
      const zweite = await srv.fastify.inject({
        method: 'POST', url: '/api/selfcheckout/zahlung-anfordern',
        payload: { kasseId, tisch: TISCH },
      })
      expect(zweite.statusCode).toBe(429)
    })

    it('liefert 404 für unbekannte Kasse', async () => {
      const res = await srv.fastify.inject({
        method: 'GET', url: `/api/selfcheckout?kasseId=11111111-1111-1111-1111-111111111111&tisch=${encodeURIComponent(TISCH)}`,
      })
      expect(res.statusCode).toBe(404)
    })
  })
})
