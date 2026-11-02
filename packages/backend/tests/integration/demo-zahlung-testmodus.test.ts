/**
 * Integrationstest: Demo-Zahlungen gibt es nur an Kassen im Testmodus.
 *
 * Zwei Dinge lassen eine Zahlung als erfolgreich gelten, ohne dass Geld fließt:
 *   - SB-Terminal ohne Kartenterminal: das ÖFFENTLICHE „Bestätigen" (POST /api/terminal/bestellung/:id/bestaetigen)
 *     macht jede Bestellung zur bezahlten — Essen und Beleg ohne Geld, für jeden im Netz
 *   - die ZVT-„IP" `stub`: simulierte Transaktion statt Kartenterminal
 * Beides bleibt für Vorführungen und Tests, aber nur an Kassen mit RKSV-Umgebung „test" (das setzt /setup beim
 * Einrichten; nachträglich ändert sie keine API). Eine Kasse im Produktivbetrieb lehnt beides ab.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@demo-zahlung.at'
const ADMIN_PASSWORT = 'demo-zahlung-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'DZ-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Demo-Zahlung nur im Testmodus (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let artikelId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const setzeUmgebung = (umgebung: 'test' | 'produktion') =>
    idb.db.update(kassen).set({ umgebung }).where(eq(kassen.id, kasseId))
  const setzeZvt = (zvtAktiv: boolean, zvtIp: string | null) =>
    idb.db.update(kassen).set({ zvtAktiv, zvtIp }).where(eq(kassen.id, kasseId))
  const bestellen = () => srv.fastify.inject({
    method: 'POST', url: '/api/terminal/bestellung', payload: { kasseId, positionen: [{ artikelId, menge: 1 }] },
  })
  const bestaetigen = (id: string) => srv.fastify.inject({ method: 'POST', url: `/api/terminal/bestellung/${id}/bestaetigen` })
  const zvtConfig = (zvtIp: string) => srv.fastify.inject({
    method: 'PATCH', url: `/api/kassen/${kasseId}/zvt`, headers: auth(), payload: { zvtIp, zvtAktiv: true },
  })
  const zvtZahlung = () => srv.fastify.inject({
    method: 'POST', url: '/api/zvt/zahlung', headers: auth(), payload: { kasseId, betragCent: 500 },
  })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Demo Zahlung GmbH', uid: 'ATU99999962', kassenId: 'DZ-001', umgebung: 'test',
        finanzOnline: { teilnehmerId: 'TID-DZ', benutzerkennung: 'BID-DZ', pin: 'PIN-DZ' },
        admin: { name: 'DZ Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup (${setup.statusCode}): ${setup.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    expect((await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulSbTerminalAktiv: true },
    })).statusCode).toBe(200)
    const kat = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'SB Speisen', farbe: 'rot', reihenfolge: 0, terminalSichtbar: true },
    })
    const art = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'SB Burger', preisBruttoCent: 890, mwstSatz: 'ermaessigt1', kategorieId: kat.json().id },
    })
    artikelId = art.json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  describe('SB-Terminal ohne Kartenterminal', () => {
    it('Testmodus: Bestellung und Demo-Bestätigung gehen (Vorführung)', async () => {
      await setzeUmgebung('test'); await setzeZvt(false, null)
      const bestellung = await bestellen()
      expect(bestellung.statusCode).toBe(201)
      expect(bestellung.json().demoZahlung).toBe(true)

      const bezahlt = await bestaetigen(bestellung.json().id)
      expect(bezahlt.statusCode).toBe(200)
      expect(bezahlt.json().status).not.toBe('zahlung')
    })

    it('Produktivbetrieb: keine Bestellung ohne Kartenterminal — es gibt nichts, was „bezahlt" tippen könnte', async () => {
      await setzeUmgebung('produktion'); await setzeZvt(false, null)
      const res = await bestellen()
      expect(res.statusCode).toBe(409)
      expect(res.json().fehler).toMatch(/Kartenterminal/)
    })

    it('Produktivbetrieb: eine noch offene Bestellung lässt sich nicht mehr per Demo-Bestätigung bezahlen', async () => {
      // Bestellung entsteht noch im Testmodus (z. B. kurz vor der Umstellung) …
      await setzeUmgebung('test'); await setzeZvt(false, null)
      const offen = (await bestellen()).json().id as string
      // … die Kasse geht in den Produktivbetrieb, danach versucht jemand das öffentliche „Bestätigen"
      await setzeUmgebung('produktion')
      const res = await bestaetigen(offen)
      expect(res.statusCode).toBe(403)
      expect(res.json().fehler).toMatch(/Testmodus/)

      const status = await srv.fastify.inject({ method: 'GET', url: `/api/terminal/bestellung/${offen}` })
      expect(status.json().status).toBe('zahlung')
      expect(status.json().bestellNummer).toBeNull()
    })
  })

  describe('ZVT-Adresse „stub"', () => {
    it('Testmodus: speichern und zahlen gehen', async () => {
      await setzeUmgebung('test')
      expect((await zvtConfig('stub')).statusCode).toBe(200)
      const zahlung = await zvtZahlung()
      expect(zahlung.statusCode).toBe(200)
      expect(zahlung.json().jobId).toBeTruthy()
    })

    it('Produktivbetrieb: „stub" (auch in anderer Schreibweise) lässt sich nicht einstellen', async () => {
      await setzeUmgebung('produktion'); await setzeZvt(false, null)
      for (const ip of ['stub', 'STUB', ' Stub ']) {
        const res = await zvtConfig(ip)
        expect(res.statusCode, ip).toBe(400)
        expect(res.json().fehler).toMatch(/Testmodus/)
      }
      const [kasse] = await idb.db.select({ ip: kassen.zvtIp, aktiv: kassen.zvtAktiv }).from(kassen).where(eq(kassen.id, kasseId))
      expect(kasse).toEqual({ ip: null, aktiv: false })

      // eine echte Terminal-Adresse bleibt natürlich einstellbar
      expect((await zvtConfig('192.168.1.99')).statusCode).toBe(200)
    })

    it('Produktivbetrieb: auch eine schon gespeicherte „stub"-Adresse bezahlt nichts mehr (Altbestand)', async () => {
      await setzeUmgebung('produktion'); await setzeZvt(true, 'stub')
      const res = await zvtZahlung()
      expect(res.statusCode).toBe(409)
      expect(res.json().fehler).toMatch(/Testmodus/)
    })
  })
})
