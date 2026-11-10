/**
 * Integrationstest: POST /api/sprache/bestellung gegen echtes PostgreSQL.
 *
 * Kern: Modul-Sperre, Berechtigung, Text → Vorschläge + Vorlesetext aus dem echten Katalog (Artikel,
 * Synonyme, Optionen), Katalog-Cache (geänderte Synonyme sofort wirksam), und dass die Route NICHTS bucht.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { count } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { SpracheBestellungErgebnis } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, tischTabs } from '../../src/db/schema.js'

const ADMIN_EMAIL = 'admin@sprachroute.at', ADMIN_PASSWORT = 'sprachroute-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SR-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Sprachroute GmbH', uid: 'ATU99999907', kassenId: 'SR-001',
  finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
  admin: { name: 'SR Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Sprachbestellung — Route (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let adminToken: string
  let mandantId: string
  let bierId = '', burgerId = '', zwiebelId = ''

  const admin = () => ({ authorization: `Bearer ${adminToken}` })
  const kellner = () => srv.authHeader({ mandantId, rolle: 'kellner', berechtigungen: ['tische'] })
  const sagen = (text: string, headers: Record<string, string> = kellner()) =>
    srv.fastify.inject({ method: 'POST', url: '/api/sprache/bestellung', headers, payload: { text } })
  const ergebnis = async (text: string) => {
    const res = await sagen(text)
    expect(res.statusCode).toBe(200)
    return res.json() as SpracheBestellungErgebnis
  }
  const modulSetzen = (aktiv: boolean) => srv.fastify.inject({
    method: 'PATCH', url: '/api/mandanten/module', headers: admin(), payload: { modulSpracheAktiv: aktiv },
  })
  const anlegen = (bezeichnung: string) => srv.fastify.inject({
    method: 'POST', url: '/api/artikel', headers: admin(),
    payload: { bezeichnung, preisBruttoCent: 400, mwstSatz: 'normal' },
  }).then(r => { expect(r.statusCode).toBe(201); return r.json().id as string })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })).json()
    adminToken = login.token
    mandantId = login.mandant.id

    bierId   = await anlegen('Bier vom Fass 0,5l')
    burgerId = await anlegen('Burger')
    const gruppe = await srv.fastify.inject({ method: 'POST', url: '/api/modifikator-gruppen', headers: admin(), payload: { name: 'Extras', typ: 'optional' } })
    const gruppeId = gruppe.json().id
    const mod = await srv.fastify.inject({ method: 'POST', url: `/api/modifikator-gruppen/${gruppeId}/modifikatoren`, headers: admin(), payload: { name: 'ohne Zwiebel', aufschlagCent: 0 } })
    zwiebelId = mod.json().modifikatoren[0].id
    await srv.fastify.inject({ method: 'PUT', url: `/api/artikel/${burgerId}/modifikator-gruppen`, headers: admin(), payload: { gruppenIds: [gruppeId] } })
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('Modul aus → 403, der Katalog wird gar nicht erst geladen', async () => {
    const res = await sagen('ein Bier')
    expect(res.statusCode).toBe(403)
    expect(res.json().fehler).toMatch(/nicht aktiviert/)
    expect((await modulSetzen(true)).statusCode).toBe(200)
  })

  it('Berechtigung: Kellner mit „tische" und Admin dürfen, „nur Artikel verwalten" nicht', async () => {
    expect((await sagen('ein Bier')).statusCode).toBe(200)
    expect((await sagen('ein Bier', admin())).statusCode).toBe(200)
    const nurArtikel = srv.authHeader({ mandantId, rolle: 'kellner', berechtigungen: ['artikel.verwalten'] })
    expect((await sagen('ein Bier', nurArtikel)).statusCode).toBe(403)
  })

  it('Text → Vorschläge mit Tisch, Optionen und Vorlesetext aus dem echten Katalog', async () => {
    const e = await ergebnis('Tisch zwölf, zwei Bier und ein Burger ohne Zwiebel')
    expect(e.tisch).toBe('12')
    expect(e.vorschlaege.map(v => [v.menge, v.artikel?.id, v.status])).toEqual([
      [2, bierId,   'sicher'],
      [1, burgerId, 'sicher'],
    ])
    expect(e.vorschlaege[1]!.modifikatoren.map(m => m.id)).toEqual([zwiebelId])
    expect(e.vorlesetext).toBe('Tisch 12: zwei Bier vom Fass 0,5l, ein Burger ohne Zwiebel. Richtig?')
  })

  it('Unbekanntes wird als solches gemeldet statt geraten', async () => {
    const e = await ergebnis('ein Sushi')
    expect(e.vorschlaege).toHaveLength(1)
    expect(e.vorschlaege[0]).toMatchObject({ artikel: null, status: 'unbekannt' })
    expect(e.vorlesetext).toContain('unklar: sushi')
  })

  it('Synonyme wirken sofort: nach dem Speichern erkennt dieselbe Äußerung den Artikel', async () => {
    expect((await ergebnis('ein Seidl')).vorschlaege[0]!.artikel).toBeNull() // Katalog ist jetzt im Speicher
    const put = await srv.fastify.inject({ method: 'PUT', url: `/api/sprache/artikel/${bierId}/synonyme`, headers: admin(), payload: { synonyme: ['Seidl'] } })
    expect(put.statusCode).toBe(200)
    const v = (await ergebnis('ein Seidl')).vorschlaege[0]!
    expect(v.artikel?.id).toBe(bierId)
    expect(v.status).toBe('sicher')
  })

  it('bekannte Grenze: ein NEUER Artikel wird erst nach Ablauf der Katalog-Lebensdauer (30 s) erkannt, ein Synonym-Speichern überspringt das', async () => {
    const suppeId = await anlegen('Gulaschsuppe')
    expect((await ergebnis('eine Gulaschsuppe')).vorschlaege[0]!.artikel).toBeNull() // noch der zwischengespeicherte Katalog
    // Beliebige Synonym-Änderung dieses Betriebs verwirft den Katalog → neuer Artikel sofort sichtbar
    await srv.fastify.inject({ method: 'PUT', url: `/api/sprache/artikel/${bierId}/synonyme`, headers: admin(), payload: { synonyme: ['Seidl', 'Krügerl'] } })
    expect((await ergebnis('eine Gulaschsuppe')).vorschlaege[0]!.artikel?.id).toBe(suppeId)
  })

  it('bucht nichts: Zahl der Belege und Tisch-Tabs bleibt gleich', async () => {
    // Belege sind nicht leer: die Einrichtung legt den RKSV-Startbeleg an — verglichen wird vorher/nachher
    const zaehle = async () => {
      const [b] = await idb.db.select({ n: count() }).from(belege)
      const [t] = await idb.db.select({ n: count() }).from(tischTabs)
      return { belege: Number(b!.n), tabs: Number(t!.n) }
    }
    const vorher = await zaehle()
    await ergebnis('Tisch 5, drei Bier und ein Burger')
    await ergebnis('ein Sushi und zwei Cola')
    expect(await zaehle()).toEqual(vorher)
    expect(vorher.tabs).toBe(0)
  })
})
