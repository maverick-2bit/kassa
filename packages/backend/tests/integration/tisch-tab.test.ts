/**
 * Integrationstest: Tisch-Tab-Lifecycle + Splitrechnung gegen echtes PostgreSQL.
 *
 * Gastro-Kern + Geld-Aufteilung. Prüft: Tab öffnen, Positionen (nachbestellen),
 * Voll-Zahlung -> ein Beleg, Splitrechnung -> ein Beleg je Zahler mit korrekten
 * Beträgen (Summe == Tab-Summe), Status-Übergänge.
 *
 * Wichtig: Beim Split werden die Preise serverseitig aus der DB gezogen
 * (Service übergibt nur artikelId+menge an die Belegerstellung).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { BelegResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@tischtab.at'
const ADMIN_PASSWORT = 'tischtab-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Tisch-Tab GmbH',
  uid:        'ATU99999907',
  kassenId:   'TT-001',
  finanzOnline: { teilnehmerId: 'TID-TT', benutzerkennung: 'BID-TT', pin: 'PIN-TT' },
  umgebung: 'test',
  admin: { name: 'TT Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface TabResponse { id: string; status: string; tischNummer: string; positionen: unknown[] }

describe('Tisch-Tab + Splitrechnung (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let bierId = ''       // 500 Cent
  let schnitzelId = ''  // 1490 Cent

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function neuerArtikel(bezeichnung: string, preisBruttoCent: number): Promise<string> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung, preisBruttoCent, mwstSatz: 'normal' },
    })
    if (r.statusCode !== 201) throw new Error(`Artikel ${bezeichnung} (${r.statusCode}): ${r.body}`)
    return r.json().id
  }

  async function oeffneTab(tisch: string): Promise<string> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/tisch-tabs', headers: auth(),
      payload: { kasseId, tischNummer: tisch, kellner: 'Anna' },
    })
    if (r.statusCode !== 201) throw new Error(`Tab öffnen (${r.statusCode}): ${r.body}`)
    return r.json().id
  }

  const pos = (artikelId: string, bezeichnung: string, preisBruttoCent: number, menge: number) =>
    ({ artikelId, bezeichnung, preisBruttoCent, menge })

  async function setzePositionen(tabId: string, positionen: unknown[]) {
    return srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
      payload: { positionen },
    })
  }

  async function holeBeleg(id: string): Promise<BelegResponse> {
    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    const beleg = (liste.json() as BelegResponse[]).find(b => b.id === id)
    if (!beleg) throw new Error(`Beleg ${id} nicht gefunden`)
    return beleg
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
    token   = login.token
    kasseId = login.kassen[0].id
    bierId      = await neuerArtikel('Bier', 500)
    schnitzelId = await neuerArtikel('Schnitzel', 1490)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert die Tab-Liste ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}` })
    expect(res.statusCode).toBe(401)
  })

  it('öffnet einen Tab, nimmt Bestellungen auf und listet ihn als offen', async () => {
    const tabId = await oeffneTab('Tisch 1')

    const upd = await setzePositionen(tabId, [
      pos(bierId, 'Bier', 500, 2),
      pos(schnitzelId, 'Schnitzel', 1490, 1),
    ])
    expect(upd.statusCode).toBe(200)
    expect((upd.json() as TabResponse).positionen).toHaveLength(2)

    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}`, headers: auth(),
    })
    const offene = liste.json() as TabResponse[]
    expect(offene.some(t => t.id === tabId && t.status === 'offen')).toBe(true)
  })

  it('Voll-Zahlung erzeugt einen Beleg und schliesst den Tab', async () => {
    const tabId = await oeffneTab('Tisch 2')
    await setzePositionen(tabId, [pos(bierId, 'Bier', 500, 3)]) // 1500

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/bezahlen`, headers: auth(),
      payload: { zahlung: { barCent: 1500, karteCent: 0, sonstigeCent: 0 } },
    })
    expect(res.statusCode).toBe(200)
    const { tab, belegId } = res.json() as { tab: TabResponse; belegId: string }
    expect(tab.status).toBe('bezahlt')

    const beleg = await holeBeleg(belegId)
    expect(beleg.gesamtbetragCent).toBe(1500)

    // nicht mehr in der Liste der offenen Tabs
    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}`, headers: auth(),
    })
    expect((liste.json() as TabResponse[]).some(t => t.id === tabId)).toBe(false)

    // erneutes Bezahlen -> 409
    const nochmal = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/bezahlen`, headers: auth(),
      payload: { zahlung: { barCent: 1500, karteCent: 0, sonstigeCent: 0 } },
    })
    expect(nochmal.statusCode).toBe(409)
  })

  it('Splitrechnung: ein Beleg je Zahler, Summe == Tab-Summe (Preise aus DB)', async () => {
    const tabId = await oeffneTab('Tisch 3')
    // Tab-Summe: 2×500 + 1×1490 = 2490
    await setzePositionen(tabId, [
      pos(bierId, 'Bier', 500, 2),
      pos(schnitzelId, 'Schnitzel', 1490, 1),
    ])

    // Zahler 1: 1 Bier (500) bar | Zahler 2: 1 Bier + Schnitzel (1990) karte
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/splitten`, headers: auth(),
      payload: {
        zahlungen: [
          { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 } },
          { positionen: [pos(bierId, 'Bier', 500, 1), pos(schnitzelId, 'Schnitzel', 1490, 1)], zahlung: { barCent: 0, karteCent: 1990, sonstigeCent: 0 } },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const { tab, belegIds } = res.json() as { tab: TabResponse; belegIds: string[] }
    expect(tab.status).toBe('bezahlt')
    expect(belegIds).toHaveLength(2)

    const betraege = await Promise.all(belegIds.map(async id => (await holeBeleg(id)).gesamtbetragCent))
    expect(betraege).toContain(500)
    expect(betraege).toContain(1990)
    // Summe der Teilbelege == Tab-Summe
    expect(betraege.reduce((a, b) => a + b, 0)).toBe(2490)
  })

  it('Splitrechnung mit nur einem Zahler wird abgewiesen (400)', async () => {
    const tabId = await oeffneTab('Tisch 4')
    await setzePositionen(tabId, [pos(bierId, 'Bier', 500, 1)])
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/splitten`, headers: auth(),
      payload: { zahlungen: [{ positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 } }] },
    })
    expect(res.statusCode).toBe(400)
  })
})
