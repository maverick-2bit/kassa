/**
 * Integrationstest: Der Artikelbericht zählt den HAUPTARTIKEL — unabhängig von den gewählten Optionen.
 *
 * Wie viele Wiener Schnitzel gingen, egal ob mit Pommes oder Kartoffelsalat; wie viel Apfelsaft, egal ob pur oder
 * gespritzt. Eigene Datei, weil die Belege dieses Tests die Zählungen anderer Berichtstests verändern würden.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { ArtikelBerichtResponse, BelegResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@hauptartikel.at'
const ADMIN_PASSWORT = 'hauptartikel-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const heuteWien = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })

describe('Artikelbericht: Hauptartikel statt Optionen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = '', artikelId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function verkaufe(menge: number, zusatz?: string): Promise<BelegResponse> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ artikelId, menge, ...(zusatz ? { bezeichnungZusatz: zusatz } : {}) }],
        zahlung: { barCent: 350 * menge, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as BelegResponse
  }

  const bericht = async () => (await srv.fastify.inject({
    method: 'GET', url: `/api/berichte/artikel?kasseIds=${kasseId}&von=${heuteWien()}&bis=${heuteWien()}`, headers: auth(),
  })).json() as ArtikelBerichtResponse

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Hauptartikel GmbH', uid: 'ATU99999914', kassenId: 'HA-001',
        finanzOnline: { teilnehmerId: 'TID-HA', benutzerkennung: 'BID-HA', pin: 'PIN-HA' },
        umgebung: 'test', admin: { name: 'HA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    const art = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Apfelsaft', preisBruttoCent: 350, mwstSatz: 'normal' },
    })
    if (art.statusCode !== 201) throw new Error(`Artikel (${art.statusCode}): ${art.body}`)
    artikelId = (art.json() as { id: string }).id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('pur, gespritzt und ohne Option ergeben EINE Zeile mit der Gesamtmenge', async () => {
    await verkaufe(2, 'pur')
    await verkaufe(1, 'gespritzt')
    await verkaufe(1)

    const zeilen = (await bericht()).zeilen.filter(z => z.bezeichnung.startsWith('Apfelsaft'))
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]).toMatchObject({ bezeichnung: 'Apfelsaft', mengeSumme: 4, umsatzCent: 4 * 350 })
  })

  it('ein Storno steht in EINER Zeile „Storno: Apfelsaft", nicht je Option', async () => {
    const beleg = await verkaufe(1, 'mit Zitrone')
    const s = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(),
      payload: { kasseId, verweisBelegId: beleg.id, grund: 'Hauptartikel-Test' },
    })
    expect(s.statusCode, s.body).toBe(201)

    const zeilen = (await bericht()).zeilen.filter(z => z.bezeichnung.includes('Apfelsaft'))
    expect(zeilen.map(z => [z.bezeichnung, z.mengeSumme]).sort()).toEqual([
      ['Apfelsaft', 5],
      ['Storno: Apfelsaft', 1],
    ])
  })
})
