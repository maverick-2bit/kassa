/**
 * Integrationstest: Gang abrufen und Position nachschicken ziehen KEIN Lager ab.
 *
 * Am Tisch bucht allein das Speichern der Positionen (PUT /positionen →
 * aktualisiereStockDeltas) den Lagerstand — auch für Positionen eines späteren
 * Gangs und für die Bestandteile eines Rezepts. Gang-Abruf und Nachschicken
 * drucken nur. Früher stand das Flag `ohneLagerabzug` dort nur im Input, der
 * Bonier-Service liest es aber allein aus seinen Optionen: Jeder Abruf und jedes
 * Nachschicken zog die Menge ein zweites Mal ab.
 *
 * Der Fake-Bonierdrucker (net.createServer) ist Pflicht: Ohne Drucker oder
 * Station endet bonierBestellung mit „nichts zu bonieren" VOR dem Lagerabzug —
 * der Fehler bliebe unsichtbar.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { inArray } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { TabPosition } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel } from '../../src/db/schema.js'

const ADMIN_EMAIL = 'admin@gang-lager.at', ADMIN_PASSWORT = 'gang-lager-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'GL-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Gang-Lager GmbH', uid: 'ATU99999913', kassenId: 'GL-001',
  finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
  admin: { name: 'GL Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Gang abrufen / nachschicken ohne Lagerabzug (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = ''
  let kasseId = ''
  let tabId = ''
  let suppeId = ''   // eigener Lagerstand 20
  let filetId = ''   // Rohstoff „Rinderfilet", Lager 50
  let steakId = ''   // Rezept: 2× Rinderfilet, kein eigener Lagerstand
  let fakeDrucker: net.Server
  let empfangen: Buffer[] = []

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function lager(): Promise<{ suppe: number | null; filet: number | null }> {
    const rows = await idb.db
      .select({ id: artikel.id, menge: artikel.lagerstandMenge })
      .from(artikel)
      .where(inArray(artikel.id, [suppeId, filetId]))
    const menge = new Map(rows.map(r => [r.id, r.menge]))
    return { suppe: menge.get(suppeId) ?? null, filet: menge.get(filetId) ?? null }
  }

  /** Der Bon kam am Küchendrucker an — der Bonier-Service lief also bis zum Lagerabzug durch. */
  async function erwarteBon(zeile: string): Promise<void> {
    await vi.waitFor(() => {
      expect(Buffer.concat(empfangen).toString('latin1')).toContain(zeile)
    })
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    fakeDrucker = net.createServer((sock) => { sock.on('data', (c) => empfangen.push(c)) })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    const port = (fakeDrucker.address() as net.AddressInfo).port
    const drucker = await srv.fastify.inject({
      method: 'POST', url: '/api/bonierdrucker', headers: auth(),
      payload: { name: 'Küche (Fake)', ip: '127.0.0.1', port },
    })
    if (drucker.statusCode !== 201) throw new Error(`Bonierdrucker: ${drucker.body}`)
    const bonierdruckerId = drucker.json().id as string

    const neuerArtikel = async (payload: Record<string, unknown>): Promise<string> => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/artikel', headers: auth(), payload: { mwstSatz: 'normal', ...payload },
      })
      if (res.statusCode !== 201) throw new Error(`Artikel ${String(payload.bezeichnung)}: ${res.body}`)
      return res.json().id as string
    }
    suppeId = await neuerArtikel({
      bezeichnung: 'Suppe', preisBruttoCent: 450, bonierdruckerId, lagerstandAktiv: true, lagerstandMenge: 20,
    })
    filetId = await neuerArtikel({
      bezeichnung: 'Rinderfilet', preisBruttoCent: 0, istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 50,
    })
    steakId = await neuerArtikel({
      bezeichnung: 'Steak', preisBruttoCent: 2400, bonierdruckerId,
      bestandteile: [{ bestandteilArtikelId: filetId, menge: 2 }],
    })

    tabId = (await srv.fastify.inject({
      method: 'POST', url: '/api/tisch-tabs', headers: auth(),
      payload: { kasseId, tischNummer: 'Tisch 7', kellner: 'Anna' },
    })).json().id
  })

  afterAll(async () => {
    await new Promise<void>((res) => fakeDrucker.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Buchen zieht genau einmal ab: Suppe 20 → 18, Rinderfilet 50 → 44', async () => {
    const positionen: TabPosition[] = [
      { artikelId: suppeId, bezeichnung: 'Suppe', preisBruttoCent: 450,  menge: 2, gang: 1 },
      { artikelId: steakId, bezeichnung: 'Steak', preisBruttoCent: 2400, menge: 3, gang: 2 },
    ]
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(), payload: { positionen },
    })
    expect(put.statusCode).toBe(200)
    expect(await lager()).toEqual({ suppe: 18, filet: 44 })   // 3 Steak × 2 Filet
  })

  // Ab hier je Test vorher/nachher vergleichen: Ein Fehlabzug soll nur den Test
  // rot machen, der ihn auslöst, nicht alle folgenden.

  it('1. Gang abrufen: Bon an der Küche, Suppe unverändert', async () => {
    const vorher = await lager()
    empfangen = []
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/gang-abrufen`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().gang).toBe(1)
    await erwarteBon('2x Suppe')
    expect(await lager()).toEqual(vorher)
  })

  it('2. Gang abrufen (Rezept-Artikel): Bon an der Küche, Rinderfilet unverändert', async () => {
    const vorher = await lager()
    empfangen = []
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/gang-abrufen`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().gang).toBe(2)
    await erwarteBon('3x Steak')
    expect(await lager()).toEqual(vorher)
  })

  it('Position nachschicken: Bon ein zweites Mal, Lager unverändert', async () => {
    const vorher = await lager()
    for (const [positionIndex, zeile] of [[0, '2x Suppe'], [1, '3x Steak']] as const) {
      empfangen = []
      const res = await srv.fastify.inject({
        method: 'POST', url: `/api/tisch-tabs/${tabId}/position-nachschicken`, headers: auth(),
        payload: { positionIndex },
      })
      expect(res.statusCode).toBe(204)
      await erwarteBon(zeile)
    }
    expect(await lager()).toEqual(vorher)
  })

  it('POST /bestellung/bonieren: ohneLagerabzug im Body wirkt, ohne Flag zieht der Service ab', async () => {
    // Über diese Route bonieren Kasse und Kellner-App die übrigen Tisch-Positionen.
    // Das Flag kommt dort als Feld im Body und muss in die Service-Optionen wandern.
    const bonieren = (flag: { ohneLagerabzug?: true }) => srv.fastify.inject({
      method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
      payload: {
        kasseId, tisch: 'Tisch 7', kellner: 'Anna', ...flag,
        positionen: [{ artikelId: suppeId, menge: 1 }, { artikelId: steakId, menge: 1 }],
      },
    })

    const vorher = await lager()
    empfangen = []
    expect((await bonieren({ ohneLagerabzug: true })).statusCode).toBe(200)
    await erwarteBon('1x Steak')
    expect(await lager()).toEqual(vorher)

    // Gegenprobe (Direktbonierung ohne Tisch-Buchung): Hier zieht der Service
    // selbst ab — die Prüfungen oben könnten einen Abzug also sehen.
    empfangen = []
    expect((await bonieren({})).statusCode).toBe(200)
    await erwarteBon('1x Steak')
    expect(await lager()).toEqual({ suppe: vorher.suppe! - 1, filet: vorher.filet! - 2 })
  })
})
