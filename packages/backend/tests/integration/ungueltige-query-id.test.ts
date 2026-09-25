/**
 * Integrationstest: ungültige uuid-Query-Parameter (echtes PostgreSQL).
 *
 * Befund 2026-09-25: Diese Routen gaben einen uuid-Query-Parameter ungeprüft
 * (`request.query as Record<string, string>`) an eine uuid-Spalte. Postgres bricht
 * dann mit 22P02 (invalid input syntax for type uuid) ab — GET /api/tisch-tabs?kasseId=kein-uuid,
 * GET /api/gutscheine?kundeId=kein-uuid … antworteten mit 500 { fehler: 'Interner Serverfehler' }
 * auf einen reinen Eingabefehler. Ebenso ein mehrfach übergebener Parameter
 * (?kundeId=…&kundeId=… kommt als Array an) und die öffentliche Speisekarte
 * GET /api/gast/karte?kasseId=… mit verstümmeltem Tisch-QR.
 *
 * Jetzt prüft uuidQuery() den Wert vor der Abfrage:
 *  - ungültig → 400 { fehler: 'Ungültige ID' }, wie bei den uuid-Pfadparametern
 *    (ungueltige-id.test.ts)
 *  - fehlt oder leer → wie bisher: Listenfilter entfällt, Pflicht-kasseId → 400 'kasseId fehlt'
 *  - gültig → der Filter wirkt wie bisher; unbekannte ID → leere Liste bzw. 404
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'UQ-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const EMAIL    = 'admin@ungueltige-query-id.at'
const PASSWORT = 'ungueltige-query-id-passwort-1'

const UNGUELTIG = 'kein-uuid'
const UNBEKANNT = '00000000-0000-4000-8000-000000000000'

/** Listen-Filter mit uuid-Query-Parameter — [Pfad, Parameter]. */
const FILTER = [
  ['/api/tisch-tabs',       'kasseId'],
  ['/api/gutscheine',       'kundeId'],
  ['/api/lieferscheine',    'kundeId'],
  ['/api/lieferscheine',    'angebotId'],
  ['/api/sammelrechnungen', 'kundeId'],
  ['/api/offene-posten',    'kundeId'],
] as const

/** Dazu die öffentliche Speisekarte (Gast-App, kasseId aus dem Tisch-QR). */
const PARAMETER = [...FILTER, ['/api/gast/karte', 'kasseId']] as const

describe('Ungültige uuid-Query-Parameter (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  /** Je Filter („Pfad?Parameter"): ein gültiger Wert und die ID, die er finden muss */
  const treffer = new Map<string, { wert: string; id: string }>()

  const auth = () => ({ authorization: `Bearer ${token}` })
  const get  = (url: string) => srv.fastify.inject({ method: 'GET', url, headers: auth() })
  const ids  = (res: { json(): unknown }) => (res.json() as Array<{ id: string }>).map(e => e.id)

  async function neu(url: string, payload: object): Promise<string> {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json().id
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Ungültige Query-ID OG', uid: 'ATU99999944', kassenId: 'UQ-001',
        finanzOnline: { teilnehmerId: 'TID-UQ', benutzerkennung: 'BID-UQ', pin: 'PIN-UQ' },
        umgebung: 'test',
        admin: { name: 'UQ Admin', email: EMAIL, passwort: PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup: ${setup.body}`)
    const login = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, passwort: PASSWORT } })
    if (login.statusCode !== 200) throw new Error(`Login: ${login.body}`)
    token = login.json().token
    const kasseId: string = login.json().kassen[0].id

    // Je Filter ein Datensatz, den der gültige Wert findet
    const kundeId   = await neu('/api/kunden', { nachname: 'Query', ort: 'Wien' })
    const angebotId = await neu('/api/angebote', {
      kasseId, kundeId,
      positionen: [{ bezeichnung: 'Kaffeemaschine', menge: 1, einzelpreisBreutto: 49900, mwstSatz: 'normal' }],
    })
    const lieferscheinId = await neu('/api/lieferscheine', { angebotId })
    treffer.set('/api/tisch-tabs?kasseId',       { wert: kasseId,   id: await neu('/api/tisch-tabs', { kasseId, tischNummer: '7', kellner: 'Anna' }) })
    treffer.set('/api/gutscheine?kundeId',       { wert: kundeId,   id: await neu('/api/gutscheine', { betragCent: 1000, kundeId }) })
    treffer.set('/api/lieferscheine?kundeId',    { wert: kundeId,   id: lieferscheinId })
    treffer.set('/api/lieferscheine?angebotId',  { wert: angebotId, id: lieferscheinId })
    treffer.set('/api/sammelrechnungen?kundeId', { wert: kundeId,   id: await neu('/api/sammelrechnungen', { lieferscheinIds: [lieferscheinId] }) })
    treffer.set('/api/offene-posten?kundeId',    { wert: kundeId,   id: await neu('/api/offene-posten', { kundeId, betragCent: 500 }) })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it.each(PARAMETER)('%s?%s=kein-uuid → 400 „Ungültige ID"', async (pfad, parameter) => {
    const res = await get(`${pfad}?${parameter}=${UNGUELTIG}`)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ fehler: 'Ungültige ID' })
  })

  it.each(PARAMETER)('%s?%s mehrfach übergeben → 400 „Ungültige ID"', async (pfad, parameter) => {
    const res = await get(`${pfad}?${parameter}=${UNBEKANNT}&${parameter}=${UNBEKANNT}`)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ fehler: 'Ungültige ID' })
  })

  it.each(FILTER)('%s?%s filtert wie bisher: gültige ID → Treffer, unbekannte → leere Liste', async (pfad, parameter) => {
    const { wert, id } = treffer.get(`${pfad}?${parameter}`)!

    const mit = await get(`${pfad}?${parameter}=${wert}`)
    expect(mit.statusCode).toBe(200)
    expect(ids(mit)).toContain(id)

    const unbekannt = await get(`${pfad}?${parameter}=${UNBEKANNT}`)
    expect(unbekannt.statusCode).toBe(200)
    expect(unbekannt.json()).toEqual([])
  })

  it.each(FILTER.filter(([, parameter]) => parameter !== 'kasseId'))(
    '%s?%s= (leer) → ohne Filter, wie bisher',
    async (pfad, parameter) => {
      const res = await get(`${pfad}?${parameter}=`)
      expect(res.statusCode).toBe(200)
      expect(ids(res)).toContain(treffer.get(`${pfad}?${parameter}`)!.id)
    },
  )

  it.each(['/api/tisch-tabs', '/api/gast/karte'])('%s: Pflicht-kasseId fehlt oder leer → 400 „kasseId fehlt"', async (pfad) => {
    for (const url of [pfad, `${pfad}?kasseId=`]) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(400)
      expect(res.json(), url).toEqual({ fehler: 'kasseId fehlt' })
    }
  })

  it('Speisekarte: gültige, unbekannte kasseId erreicht die Abfrage → 404', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${UNBEKANNT}` })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ fehler: 'Kasse nicht gefunden' })
  })

  it('Anmeldung wird vor dem Query-Parameter geprüft: ohne Token 401', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/gutscheine?kundeId=${UNGUELTIG}` })
    expect(res.statusCode).toBe(401)
  })
})
