/**
 * Integrationstest gegen echtes PostgreSQL — ergänzt die (gemockten) Unit-Tests
 * für bonier/drucker/zvt um echte DB-Flows:
 *   - Bonieren mit aktivem KDS: erzeugt einen KDS-Bon in der DB + zieht den
 *     Lagerstand bonierbarer Artikel ab; "nichts zu bonieren" -> 400
 *   - Drucker-Konfiguration: PATCH persistiert, GET liefert den neuen Stand
 *   - ZVT-Konfiguration: dito
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { kassen, kdsBons } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@bonier-int.at'
const ADMIN_PASSWORT = 'bonier-int-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Bonier-Int GmbH',
  uid:        'ATU99999917',
  kassenId:   'BI-001',
  finanzOnline: { teilnehmerId: 'TID-BI', benutzerkennung: 'BID-BI', pin: 'PIN-BI' },
  umgebung: 'test',
  admin: { name: 'BI Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface ArtikelRow { id: string; lagerstandMenge: number | null }

describe('Bonieren + Drucker/ZVT-Config (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function neuerArtikel(payload: Record<string, unknown>): Promise<string> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { mwstSatz: 'normal', ...payload },
    })
    if (r.statusCode !== 201) throw new Error(`Artikel (${r.statusCode}): ${r.body}`)
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
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  describe('Bonieren (KDS-Routing + Lagerstand)', () => {
    beforeAll(async () => {
      // KDS auf der Kasse aktivieren (Station "kueche" ohne IP genügt für den Bon)
      await idb.db.update(kassen).set({ kdsAktiv: true, kdsStationen: {} }).where(eq(kassen.id, kasseId))
    })

    it('erzeugt einen KDS-Bon und zieht den Lagerstand ab', async () => {
      const pizzaId = await neuerArtikel({
        bezeichnung: 'Pizza', preisBruttoCent: 990, station: 'kueche',
        lagerstandAktiv: true, lagerstandMenge: 10,
      })

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
        payload: { kasseId, tisch: 'Tisch 1', kellner: 'Anna', positionen: [{ artikelId: pizzaId, menge: 2 }] },
      })
      // 200 = alle Stationen zugestellt, 207 = Bon erstellt aber Station(en)
      // physisch nicht erreichbar (hier: KDS-Station ohne IP). Beides ok — der
      // Bon ist erstellt und der Lagerstand wird gezogen.
      expect([200, 207]).toContain(res.statusCode)
      expect(res.json().bonNummer).toBeTruthy()

      // KDS-Bon in der DB
      const bons = await idb.db.select().from(kdsBons).where(eq(kdsBons.mandantId, mandantId))
      expect(bons.length).toBeGreaterThanOrEqual(1)
      expect(bons.some(b => b.station === 'kueche')).toBe(true)

      // Lagerstand abgezogen (10 - 2)
      const liste = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: auth() })
      const pizza = (liste.json() as ArtikelRow[]).find(a => a.id === pizzaId)
      expect(pizza?.lagerstandMenge).toBe(8)
    })

    it('207 wenn der Bonierdrucker den Bon nicht bekommt (nicht 200)', async () => {
      // Regression: bis v0.7.142 prüfte die Route NUR die KDS-Stationen. Ein
      // toter Drucker in der Küche lieferte glatte 200 — die Kasse zeigte grün,
      // die Bestellung stand am Tisch und in der Küche kam nie etwas an.
      const drucker = await srv.fastify.inject({
        method: 'POST', url: '/api/bonierdrucker', headers: auth(),
        // 127.0.0.1:9 ist zu — gibt sofort ECONNREFUSED statt in einen Timeout zu laufen.
        payload: { name: 'Toter Küchendrucker', ip: '127.0.0.1', port: 9 },
      })
      expect(drucker.statusCode).toBe(201)

      const schnitzelId = await neuerArtikel({
        bezeichnung: 'Schnitzel', preisBruttoCent: 1490,
        bonierdruckerId: drucker.json().id,
      })

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
        payload: { kasseId, tisch: 'Tisch 7', kellner: 'Cem', positionen: [{ artikelId: schnitzelId, menge: 1 }] },
      })

      expect(res.statusCode).toBe(207)
      const ergebnis = res.json()
      expect(ergebnis.bonNummer).toBeTruthy()          // Bon existiert, nur zugestellt wurde er nicht
      expect(ergebnis.drucker).toHaveLength(1)
      expect(ergebnis.drucker[0].erfolgreich).toBe(false)
      expect(ergebnis.drucker[0].name).toBe('Toter Küchendrucker')
      expect(ergebnis.drucker[0].fehler).toBeTruthy()  // Grund steht drin, damit ihn die Kasse anzeigen kann
    })

    it('400 wenn kein Artikel bonierbar ist (keine Station/kein Drucker)', async () => {
      const wasserId = await neuerArtikel({ bezeichnung: 'Wasser ohne Station', preisBruttoCent: 200 })
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
        payload: { kasseId, tisch: 'Tisch 2', kellner: 'Bob', positionen: [{ artikelId: wasserId, menge: 1 }] },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('Drucker-Konfiguration (Persistenz)', () => {
    it('PATCH persistiert und GET liefert den neuen Stand', async () => {
      const patch = await srv.fastify.inject({
        method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(),
        payload: { druckerIp: '10.0.0.50', druckerPort: 9100, druckerAktiv: true },
      })
      expect(patch.statusCode).toBe(200)

      const get = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/drucker`, headers: auth() })
      const cfg = get.json()
      expect(cfg.druckerIp).toBe('10.0.0.50')
      expect(cfg.druckerPort).toBe(9100)
      expect(cfg.druckerAktiv).toBe(true)
    })
  })

  describe('ZVT-Konfiguration (Persistenz)', () => {
    it('PATCH persistiert und GET liefert den neuen Stand', async () => {
      const patch = await srv.fastify.inject({
        method: 'PATCH', url: `/api/kassen/${kasseId}/zvt`, headers: auth(),
        payload: { zvtIp: '10.0.0.60', zvtPort: 20007, zvtAktiv: true },
      })
      expect(patch.statusCode).toBe(200)

      const get = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/zvt`, headers: auth() })
      const cfg = get.json()
      expect(cfg.zvtIp).toBe('10.0.0.60')
      expect(cfg.zvtAktiv).toBe(true)
    })
  })

  describe('Warengruppen-Stations-Vorgabe (Vererbung an Artikel)', () => {
    it('Artikel ohne eigene Station erbt die Station der Warengruppe; eigene Station geht vor', async () => {
      await idb.db.update(kassen).set({ kdsAktiv: true, kdsStationen: {} }).where(eq(kassen.id, kasseId))

      // Warengruppe mit Vorgabe Schank
      const kat = (await srv.fastify.inject({
        method: 'POST', url: '/api/kategorien', headers: auth(),
        payload: { name: 'Getränke (Vorgabe Schank)', farbe: 'blau', reihenfolge: 0, station: 'schank' },
      })).json() as { id: string; station: string }
      expect(kat.station).toBe('schank')

      // Erbt: keine eigene Station | Weicht ab: eigene Station 'dessert'
      const erbtId    = await neuerArtikel({ bezeichnung: 'Spritzer (erbt)', preisBruttoCent: 400, kategorieId: kat.id })
      const eigeneId  = await neuerArtikel({ bezeichnung: 'Eiskaffee (eigen)', preisBruttoCent: 550, kategorieId: kat.id, station: 'dessert' })

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
        payload: {
          kasseId, tisch: 'Tisch 9', kellner: 'Vera',
          positionen: [{ artikelId: erbtId, menge: 1 }, { artikelId: eigeneId, menge: 1 }],
        },
      })
      expect([200, 207]).toContain(res.statusCode)

      // Je ein KDS-Bon auf Schank (geerbt) und Dessert (eigene Station schlägt Vorgabe)
      const schankBons = await idb.db.select().from(kdsBons)
        .where(and(eq(kdsBons.mandantId, mandantId), eq(kdsBons.station, 'schank')))
      const dessertBons = await idb.db.select().from(kdsBons)
        .where(and(eq(kdsBons.mandantId, mandantId), eq(kdsBons.station, 'dessert')))
      expect(schankBons.some(b => JSON.stringify(b.positionen).includes('Spritzer'))).toBe(true)
      expect(dessertBons.some(b => JSON.stringify(b.positionen).includes('Eiskaffee'))).toBe(true)
      // Der abweichende Artikel darf NICHT zusätzlich auf der Vorgabe-Station landen
      expect(schankBons.some(b => JSON.stringify(b.positionen).includes('Eiskaffee'))).toBe(false)
    })

    it('ohne Vorgabe und ohne eigene Station wird weiterhin nichts boniert (400)', async () => {
      const ohneAlles = await neuerArtikel({ bezeichnung: 'Pfand ohne Routing', preisBruttoCent: 100 })
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
        payload: { kasseId, tisch: 'Tisch 9', kellner: 'Vera', positionen: [{ artikelId: ohneAlles, menge: 1 }] },
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
