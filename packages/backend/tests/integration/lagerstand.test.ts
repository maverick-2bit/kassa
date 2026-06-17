/**
 * Integrationstest: Lagerstand gegen echtes PostgreSQL.
 *
 * Prüft die serverseitige Bestandsführung: Verkauf (Barzahlungsbeleg)
 * dekrementiert den Artikelbestand atomar, der Bestand fällt nie unter 0
 * (kein Negativbestand), und manuelle Korrekturen (Wareneingang/Inventur)
 * über den Bulk-Endpoint wirken korrekt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@lagerstand.at'
const ADMIN_PASSWORT = 'lagerstand-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Lagerstand GmbH',
  uid:        'ATU99999910',
  kassenId:   'LG-001',
  finanzOnline: { teilnehmerId: 'TID-LG', benutzerkennung: 'BID-LG', pin: 'PIN-LG' },
  umgebung: 'test',
  admin: { name: 'LG Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface ArtikelRow { id: string; lagerstandMenge: number | null }

describe('Lagerstand (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let wasserId = ''   // 200 Cent, lagerstandAktiv, Start 10, kein Bonier-Routing

  const auth = () => ({ authorization: `Bearer ${token}` })

  /** Verkauft `menge` Stück per Barzahlung (Preis 200 → Barbetrag menge*200). */
  async function verkaufe(menge: number) {
    return srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ artikelId: wasserId, menge }],
        zahlung: { barCent: menge * 200, karteCent: 0, sonstigeCent: 0 },
      },
    })
  }

  async function bestand(): Promise<number | null> {
    const liste = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: auth() })
    return (liste.json() as ArtikelRow[]).find(a => a.id === wasserId)?.lagerstandMenge ?? null
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

    // Artikel mit aktivem Lagerstand, OHNE Bonier-Routing (sonst Abzug beim Bonieren)
    const a = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Wasser', preisBruttoCent: 200, mwstSatz: 'normal', lagerstandAktiv: true, lagerstandMenge: 10 },
    })
    if (a.statusCode !== 201) throw new Error(`Artikel (${a.statusCode}): ${a.body}`)
    wasserId = a.json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('startet mit dem konfigurierten Bestand', async () => {
    expect(await bestand()).toBe(10)
  })

  it('dekrementiert den Bestand beim Verkauf', async () => {
    const res = await verkaufe(3)
    expect(res.statusCode).toBe(201)
    expect(await bestand()).toBe(7)
  })

  it('fällt nicht unter 0 (kein Negativbestand bei Überverkauf)', async () => {
    const res = await verkaufe(8)   // 7 - 8 -> Floor 0
    expect(res.statusCode).toBe(201)
    expect(await bestand()).toBe(0)
  })

  it('Wareneingang addiert zum Bestand', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/lagerstand/bulk', headers: auth(),
      payload: { modus: 'wareneingang', artikel: [{ id: wasserId, menge: 20 }], modifikatoren: [] },
    })
    expect(res.statusCode).toBe(204)
    expect(await bestand()).toBe(20)
  })

  it('Inventur (absolut) setzt den Bestand auf den exakten Wert', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/lagerstand/bulk', headers: auth(),
      payload: { modus: 'absolut', artikel: [{ id: wasserId, menge: 5 }], modifikatoren: [] },
    })
    expect(res.statusCode).toBe(204)
    expect(await bestand()).toBe(5)
  })
})
