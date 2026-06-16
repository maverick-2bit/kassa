/**
 * Integrationstest: öffentliches Gast-Bestellsystem gegen echtes PostgreSQL.
 *
 *  GET  /api/gast/karte         — Speisekarte (ohne Auth)
 *  POST /api/gast/bestellung    — Bestellung -> Tab auf der Kasse (ohne Auth)
 *
 * Sicherheitsrelevant: Preise kommen IMMER aus der DB, nie vom Client. Der
 * Body akzeptiert nur artikelId+menge — der Tab-Betrag muss den DB-Preisen
 * entsprechen.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@gast.at'
const ADMIN_PASSWORT = 'gast-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Gast Test GmbH',
  uid:        'ATU99999904',
  kassenId:   'GAST-001',
  finanzOnline: { teilnehmerId: 'TID-GAST', benutzerkennung: 'BID-GAST', pin: 'PIN-GAST' },
  umgebung: 'test',
  admin: { name: 'Gast Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface TabPosition { artikelId: string; bezeichnung: string; preisBruttoCent: number; menge: number }
interface Tab { kellner: string; tischNummer: string; status: string; positionen: TabPosition[] }

describe('Gast-Bestellsystem (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let espressoId = ''   // 350 Cent
  let colaId     = ''   // 420 Cent

  const auth = () => ({ authorization: `Bearer ${token}` })

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

    // Kategorie + zwei Artikel anlegen (authentifiziert)
    const kat = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'Getränke', farbe: 'blau', reihenfolge: 0 },
    })
    const katId = kat.json().id

    const a1 = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Espresso', preisBruttoCent: 350, mwstSatz: 'ermaessigt1', kategorieId: katId },
    })
    espressoId = a1.json().id
    const a2 = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Cola', preisBruttoCent: 420, mwstSatz: 'normal', kategorieId: katId },
    })
    colaId = a2.json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Speisekarte ────────────────────────────────────────────────────────────
  it('liefert die Speisekarte mit Kategorien und Artikeln (ohne Auth)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })
    expect(res.statusCode).toBe(200)
    const karte = res.json()
    expect(karte.kasse.id).toBe(kasseId)
    expect(karte.kategorien.map((k: { name: string }) => k.name)).toContain('Getränke')
    const espresso = karte.artikel.find((a: { id: string }) => a.id === espressoId)
    expect(espresso).toBeDefined()
    expect(espresso.preisBruttoCent).toBe(350)
  })

  it('liefert 400 ohne kasseId und 404 bei unbekannter Kasse', async () => {
    const ohne = await srv.fastify.inject({ method: 'GET', url: '/api/gast/karte' })
    expect(ohne.statusCode).toBe(400)
    const unbekannt = await srv.fastify.inject({
      method: 'GET', url: '/api/gast/karte?kasseId=11111111-1111-1111-1111-111111111111',
    })
    expect(unbekannt.statusCode).toBe(404)
  })

  // ── Bestellung ───────────────────────────────────────────────────────────────
  it('legt aus einer Bestellung einen Gast-Tab mit DB-Preisen an', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gast/bestellung',
      payload: {
        kasseId, tischNummer: 'Tisch 7',
        positionen: [
          { artikelId: espressoId, menge: 2 },
          { artikelId: colaId,     menge: 1 },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ erfolgreich: true })

    // Tab erscheint auf der Kasse
    const tabsRes = await srv.fastify.inject({
      method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}`, headers: auth(),
    })
    const tabs = tabsRes.json() as Tab[]
    const gastTab = tabs.find(t => t.kellner === 'Gast' && t.tischNummer === 'Tisch 7')
    expect(gastTab).toBeDefined()

    // Preise stammen aus der DB (2×350 + 1×420)
    const espressoPos = gastTab!.positionen.find(p => p.artikelId === espressoId)!
    expect(espressoPos.preisBruttoCent).toBe(350)
    expect(espressoPos.menge).toBe(2)
    const summe = gastTab!.positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)
    expect(summe).toBe(2 * 350 + 420)
  })

  it('ignoriert einen vom Client mitgeschickten Fantasiepreis (Preise nur aus DB)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gast/bestellung',
      payload: {
        kasseId, tischNummer: 'Tisch 8',
        // preisBruttoCent: 1 wird vom Schema gar nicht akzeptiert/uebernommen
        positionen: [{ artikelId: espressoId, menge: 1, preisBruttoCent: 1 }],
      },
    })
    expect(res.statusCode).toBe(201)
    const tabsRes = await srv.fastify.inject({
      method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}`, headers: auth(),
    })
    const tab = (tabsRes.json() as Tab[]).find(t => t.tischNummer === 'Tisch 8')!
    expect(tab.positionen[0]!.preisBruttoCent).toBe(350) // DB-Preis, nicht 1
  })

  it('weist ungültige Bestellungen ab', async () => {
    // unbekannte Kasse
    const fremdeKasse = await srv.fastify.inject({
      method: 'POST', url: '/api/gast/bestellung',
      payload: { kasseId: '11111111-1111-1111-1111-111111111111', tischNummer: 'T1', positionen: [{ artikelId: espressoId, menge: 1 }] },
    })
    expect(fremdeKasse.statusCode).toBe(404)

    // unbekannter Artikel
    const fremderArtikel = await srv.fastify.inject({
      method: 'POST', url: '/api/gast/bestellung',
      payload: { kasseId, tischNummer: 'T1', positionen: [{ artikelId: '22222222-2222-2222-2222-222222222222', menge: 1 }] },
    })
    expect(fremderArtikel.statusCode).toBe(400)

    // leere Positionen
    const leer = await srv.fastify.inject({
      method: 'POST', url: '/api/gast/bestellung',
      payload: { kasseId, tischNummer: 'T1', positionen: [] },
    })
    expect(leer.statusCode).toBe(400)

    // doppelte artikelId
    const doppelt = await srv.fastify.inject({
      method: 'POST', url: '/api/gast/bestellung',
      payload: { kasseId, tischNummer: 'T1', positionen: [{ artikelId: espressoId, menge: 1 }, { artikelId: espressoId, menge: 2 }] },
    })
    expect(doppelt.statusCode).toBe(400)
  })
})
