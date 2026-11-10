/**
 * Integrationstest: Sprachbestellung — Synonyme je Artikel und Katalog-Lader gegen echtes PostgreSQL.
 *
 * Kern: Modul-Sperre, Synonyme ersetzen (bereinigt), Konflikte mit anderen Artikeln, unbekannter
 * Artikel (404), und der ganze Weg Datenbank → Katalog → Parser („zwei Seidl" findet den Artikel,
 * Optionen aus den Modifikator-Gruppen werden erkannt).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { ladeSprachArtikel } from '../../src/services/sprache.service.js'
import { baueKatalog, parseBestellung } from '../../src/services/sprache/index.js'

const ADMIN_EMAIL = 'admin@synonyme.at', ADMIN_PASSWORT = 'synonyme-passwort-123'
const UNBEKANNT = '00000000-0000-4000-8000-000000000099'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SY-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Synonyme GmbH', uid: 'ATU99999906', kassenId: 'SY-001',
  finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
  admin: { name: 'SY Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Sprachbestellung — Synonyme (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let mandantId: string
  let seidlId = '', krugerlId = '', burgerId = ''
  let gruppeId = '', ohneZwiebelId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })
  const anlegen = (bezeichnung: string) => srv.fastify.inject({
    method: 'POST', url: '/api/artikel', headers: auth(),
    payload: { bezeichnung, preisBruttoCent: 400, mwstSatz: 'normal' },
  }).then(r => { expect(r.statusCode).toBe(201); return r.json().id as string })
  const put = (id: string, synonyme: string[]) => srv.fastify.inject({
    method: 'PUT', url: `/api/sprache/artikel/${id}/synonyme`, headers: auth(), payload: { synonyme },
  })
  const holeEinen = (id: string) => srv.fastify.inject({ method: 'GET', url: `/api/sprache/artikel/${id}/synonyme`, headers: auth() })
  const holeListe = () => srv.fastify.inject({ method: 'GET', url: '/api/sprache/synonyme', headers: auth() })
  const modulSetzen = (aktiv: boolean) => srv.fastify.inject({
    method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulSpracheAktiv: aktiv },
  })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })).json()
    token = login.token
    mandantId = login.mandant.id

    seidlId   = await anlegen('Bier vom Fass 0,3l')
    krugerlId = await anlegen('Bier vom Fass 0,5l')
    burgerId  = await anlegen('Burger')

    // Optionen des Burgers: Gruppe „Extras" mit „ohne Zwiebel"
    const gruppe = await srv.fastify.inject({ method: 'POST', url: '/api/modifikator-gruppen', headers: auth(), payload: { name: 'Extras', typ: 'optional' } })
    expect(gruppe.statusCode).toBe(201)
    gruppeId = gruppe.json().id
    const mod = await srv.fastify.inject({ method: 'POST', url: `/api/modifikator-gruppen/${gruppeId}/modifikatoren`, headers: auth(), payload: { name: 'ohne Zwiebel', aufschlagCent: 0 } })
    expect(mod.statusCode).toBe(201)
    ohneZwiebelId = mod.json().modifikatoren[0].id
    const zuw = await srv.fastify.inject({ method: 'PUT', url: `/api/artikel/${burgerId}/modifikator-gruppen`, headers: auth(), payload: { gruppenIds: [gruppeId] } })
    expect(zuw.statusCode).toBe(200)
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('Modul aus → alle Endpunkte 403, es wird nichts gespeichert', async () => {
    const [p, g, l] = await Promise.all([put(seidlId, ['Seidl']), holeEinen(seidlId), holeListe()])
    expect([p.statusCode, g.statusCode, l.statusCode]).toEqual([403, 403, 403])
    expect((await modulSetzen(true)).statusCode).toBe(200)
    expect((await holeEinen(seidlId)).json().synonyme).toEqual([])
  })

  it('setzt Synonyme bereinigt (Dubletten, Leeres, eigene Bezeichnung) und liest sie zurück', async () => {
    const res = await put(seidlId, ['Seidl', 'seidl', ' Seidel ', 'Bier vom Fass 0,3l'])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ artikelId: seidlId, synonyme: ['Seidl', 'Seidel'], konflikte: [] })
    expect((await holeEinen(seidlId)).json().synonyme).toEqual(['Seidl', 'Seidel'])
  })

  it('PUT ersetzt die bisherige Liste vollständig (auch auf leer)', async () => {
    expect((await put(krugerlId, ['Krügerl', 'Halbe'])).json().synonyme).toEqual(['Krügerl', 'Halbe'])
    expect((await put(krugerlId, ['Halbe'])).json().synonyme).toEqual(['Halbe'])
    expect((await holeListe()).json()).toEqual([
      { artikelId: seidlId,   bezeichnung: 'Bier vom Fass 0,3l', synonyme: ['Seidl', 'Seidel'] },
      { artikelId: krugerlId, bezeichnung: 'Bier vom Fass 0,5l', synonyme: ['Halbe'] },
    ])
    expect((await put(krugerlId, [])).json().synonyme).toEqual([])
    const nachher = (await holeListe()).json() as { artikelId: string }[]
    expect(nachher.map(x => x.artikelId)).toEqual([seidlId]) // Artikel ohne Synonyme fehlt in der Liste
  })

  it('meldet Konflikte mit anderen Artikeln, speichert aber trotzdem', async () => {
    const res = await put(krugerlId, ['Seidl', 'Burger', 'Krügerl'])
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.synonyme).toEqual(['Seidl', 'Burger', 'Krügerl'])
    expect(body.konflikte).toEqual([
      { text: 'Seidl',  artikelId: seidlId,  artikelBezeichnung: 'Bier vom Fass 0,3l', art: 'synonym' },
      { text: 'Burger', artikelId: burgerId, artikelBezeichnung: 'Burger',             art: 'bezeichnung' },
    ])
  })

  it('unbekannter Artikel → 404', async () => {
    expect((await put(UNBEKANNT, ['x'])).statusCode).toBe(404)
    expect((await holeEinen(UNBEKANNT)).statusCode).toBe(404)
  })

  it('Katalog-Lader + Parser: Datenbank → „zwei Seidl und ein Burger ohne Zwiebel und ein Halbe"', async () => {
    await put(krugerlId, ['Krügerl', 'Halbe'])
    const artikel = await ladeSprachArtikel(idb.db, mandantId)
    expect(artikel.map(a => a.bezeichnung)).toEqual(['Bier vom Fass 0,3l', 'Bier vom Fass 0,5l', 'Burger'])
    expect(artikel.find(a => a.id === seidlId)!.synonyme).toEqual(expect.arrayContaining(['Seidl', 'Seidel']))
    expect(artikel.find(a => a.id === burgerId)!.modifikatoren).toEqual([{ id: ohneZwiebelId, gruppeId, name: 'ohne Zwiebel' }])

    const e = parseBestellung(baueKatalog(artikel), 'zwei Seidl und ein Burger ohne Zwiebel und ein Halbe')
    expect(e.vorschlaege.map(v => [v.menge, v.artikel?.id, v.status])).toEqual([
      [2, seidlId,   'sicher'],
      [1, burgerId,  'sicher'],
      [1, krugerlId, 'sicher'],
    ])
    expect(e.vorschlaege[1]!.modifikatoren.map(m => m.id)).toEqual([ohneZwiebelId])
  })

  it('Lader lässt inaktive Artikel aus', async () => {
    const del = await srv.fastify.inject({ method: 'DELETE', url: `/api/artikel/${burgerId}`, headers: auth() })
    expect([200, 204]).toContain(del.statusCode)
    const artikel = await ladeSprachArtikel(idb.db, mandantId)
    expect(artikel.map(a => a.id)).not.toContain(burgerId)
  })
})
