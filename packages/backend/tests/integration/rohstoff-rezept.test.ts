/**
 * Integrationstest: Rohstoff-/Stücklisten-Lager gegen echtes PostgreSQL.
 *
 * Automatisiert das Nutzer-Beispiel und macht aus der Einmal-Live-Probe (v0.7.89)
 * einen dauerhaften Regressions-Guard für die Bestandteil-Abbuchung:
 *   „Wiener Schnitzel" = 2× „Schnitzel paniert", „Schnitzelsemmel" = 1×.
 *   Rohstoff-Lager 100 → je 1 verkauft → 97; Tisch parken/stornieren; Sperre bei 0;
 *   und vor allem: KEIN Doppelabzug über die entkoppelten Lager-Hooks.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@rohstoff.at'
const ADMIN_PASSWORT = 'rohstoff-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Schnitzelwirt GmbH',
  uid:        'ATU99999911',
  kassenId:   'SW-001',
  finanzOnline: { teilnehmerId: 'TID-SW', benutzerkennung: 'BID-SW', pin: 'PIN-SW' },
  umgebung: 'test',
  admin: { name: 'SW Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface ArtikelRow {
  id: string
  istBestandteil: boolean
  lagerstandMenge: number | null
  verfuegbareMenge?: number | null
}

describe('Rohstoff-Rezept / Stückliste (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = ''
  let kasseId = ''
  let rohId = ''      // Rohstoff „Schnitzel paniert" (istBestandteil, Lager 100)
  let wienerId = ''   // = 2× Rohstoff
  let semmelId = ''   // = 1× Rohstoff

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function alleArtikel(): Promise<ArtikelRow[]> {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: auth() })
    return res.json() as ArtikelRow[]
  }
  async function rohBestand(): Promise<number | null> {
    return (await alleArtikel()).find(a => a.id === rohId)?.lagerstandMenge ?? null
  }
  async function verfuegbar(id: string): Promise<number | null | undefined> {
    return (await alleArtikel()).find(a => a.id === id)?.verfuegbareMenge
  }
  async function verkaufeDirekt(positionen: { artikelId: string; menge: number }[], barCent: number) {
    return srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: { kasseId, positionen, zahlung: { barCent, karteCent: 0, sonstigeCent: 0 } },
    })
  }
  async function setzeRohstoff(menge: number) {
    return srv.fastify.inject({
      method: 'POST', url: '/api/lagerstand/bulk', headers: auth(),
      payload: { modus: 'absolut', artikel: [{ id: rohId, menge }], modifikatoren: [] },
    })
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Rohstoff (nur Lager) mit Startbestand 100
    const roh = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Schnitzel paniert', preisBruttoCent: 0, mwstSatz: 'normal',
                 istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 100 },
    })
    if (roh.statusCode !== 201) throw new Error(`Rohstoff (${roh.statusCode}): ${roh.body}`)
    rohId = roh.json().id

    // Verkaufsartikel mit Rezept (kein eigener Lagerstand → Verfügbarkeit abgeleitet)
    const wiener = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Wiener Schnitzel', preisBruttoCent: 1500, mwstSatz: 'normal',
                 bestandteile: [{ bestandteilArtikelId: rohId, menge: 2 }] },
    })
    if (wiener.statusCode !== 201) throw new Error(`Wiener (${wiener.statusCode}): ${wiener.body}`)
    wienerId = wiener.json().id

    const semmel = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Schnitzelsemmel', preisBruttoCent: 500, mwstSatz: 'normal',
                 bestandteile: [{ bestandteilArtikelId: rohId, menge: 1 }] },
    })
    if (semmel.statusCode !== 201) throw new Error(`Semmel (${semmel.statusCode}): ${semmel.body}`)
    semmelId = semmel.json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Anfangszustand: Rohstoff 100, abgeleitete Verfügbarkeit korrekt', async () => {
    const liste = await alleArtikel()
    expect(liste.find(a => a.id === rohId)?.istBestandteil).toBe(true)
    expect(liste.find(a => a.id === rohId)?.lagerstandMenge).toBe(100)
    expect(liste.find(a => a.id === wienerId)?.verfuegbareMenge).toBe(50)  // floor(100/2)
    expect(liste.find(a => a.id === semmelId)?.verfuegbareMenge).toBe(100) // floor(100/1)
  })

  it('Direktverkauf 1 Wiener + 1 Semmel → Rohstoff 100 → 97', async () => {
    const res = await verkaufeDirekt([{ artikelId: wienerId, menge: 1 }, { artikelId: semmelId, menge: 1 }], 2000)
    expect(res.statusCode).toBe(201)
    expect(await rohBestand()).toBe(97)                 // 100 - 2 - 1
    expect(await verfuegbar(wienerId)).toBe(48)         // floor(97/2)
  })

  it('Tisch: parken 1 Wiener → 95, stornieren → zurück 97 (Delta-Rückbuchung)', async () => {
    const tab = await srv.fastify.inject({
      method: 'POST', url: '/api/tisch-tabs', headers: auth(),
      payload: { kasseId, tischNummer: 'RT1', kellner: 'Kellner' },
    })
    expect(tab.statusCode).toBe(201)
    const tabId = tab.json().id

    const park = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
      payload: { positionen: [{ artikelId: wienerId, bezeichnung: 'Wiener Schnitzel', preisBruttoCent: 1500, menge: 1 }] },
    })
    expect(park.statusCode).toBe(200)
    expect(await rohBestand()).toBe(95)                 // 97 - 2

    const storno = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
      payload: { positionen: [] },
    })
    expect(storno.statusCode).toBe(200)
    expect(await rohBestand()).toBe(97)                 // 95 + 2 zurück
  })

  it('Sperre: Rohstoff auf 0 → beide Verkaufsartikel verfuegbareMenge 0', async () => {
    expect((await setzeRohstoff(0)).statusCode).toBe(204)
    expect(await rohBestand()).toBe(0)
    expect(await verfuegbar(wienerId)).toBe(0)
    expect(await verfuegbar(semmelId)).toBe(0)
  })

  it('kein Doppelabzug: Rohstoff auf 100, 1 Wiener direkt → 98 (nicht 96)', async () => {
    expect((await setzeRohstoff(100)).statusCode).toBe(204)
    const res = await verkaufeDirekt([{ artikelId: wienerId, menge: 1 }], 1500)
    expect(res.statusCode).toBe(201)
    expect(await rohBestand()).toBe(98)                 // 100 - 2 (genau einmal)
  })
})
