/**
 * Integrationstest: ungültige uuid-Pfadparameter (echtes PostgreSQL).
 *
 * Befund 2026-09-24: Diese Routen gaben `request.params as { id: string }` bzw.
 * `request.params.id` ungeprüft an eine uuid-Spalte. Postgres bricht dann mit
 * 22P02 (invalid input syntax for type uuid) ab — PUT/DELETE /api/users/kein-uuid,
 * GET /api/kunden/kein-uuid, GET /api/tisch-tabs/kein-uuid … antworteten mit
 * 500 { fehler: 'Interner Serverfehler' } auf einen reinen Eingabefehler.
 *
 * Jetzt prüft uuidParam() den Parameter vor dem ersten DB-Zugriff:
 *  - ungültige ID → 400 { fehler: 'Ungültige ID' }, wie bei den Routen mit
 *    eigenem IdParam-Schema (artikel.route.ts) — auch mit gültigem Body, mit
 *    dem die Anfrage früher bis in die Abfrage lief
 *  - gültige, aber unbekannte ID geht weiter bis zur Abfrage — kein 400
 *    „Ungültige ID", kein 500; unbekannte/fremde Datensätze bleiben 404
 *    (Mandanten-Isolation, siehe mandant-isolation.test.ts)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'UI-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const EMAIL    = 'admin@ungueltige-id.at'
const PASSWORT = 'ungueltige-id-passwort-1'

const UNGUELTIG = 'kein-uuid'
const UNBEKANNT = '00000000-0000-4000-8000-000000000000'
const ANDERE    = '00000000-0000-4000-8000-000000000001'

// Gültige Bodies: Die Prüfung der ID kommt zuerst — ohne sie liefe die Anfrage
// mit diesen Bodies bis in die Abfrage (und damit in den 500er).
const POSITION = { artikelId: ANDERE, bezeichnung: 'Melange', preisBruttoCent: 390, menge: 1 }
const ZAHLUNG  = { barCent: 390, karteCent: 0, sonstigeCent: 0 }

/** Jede Route mit uuid-Pfadparameter aus den betroffenen Dateien — `:id` wird ersetzt. */
const ROUTEN: ReadonlyArray<readonly ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, object?]> = [
  // tisch-tab.route.ts
  ['GET',    '/api/tisch-tabs/:id'],
  ['PUT',    '/api/tisch-tabs/:id/positionen',             { positionen: [POSITION] }],
  ['POST',   '/api/tisch-tabs/:id/verwerfen',              {}],
  ['POST',   '/api/tisch-tabs/:id/bezahlen',               { zahlung: ZAHLUNG }],
  ['PATCH',  '/api/tisch-tabs/:id/kellner',                { kellner: 'Anna' }],
  ['PATCH',  '/api/tisch-tabs/:id/tisch',                  { tischNummer: '7' }],
  ['POST',   '/api/tisch-tabs/:id/zusammenfuehren',        { quellTabIds: [ANDERE] }],
  ['POST',   '/api/tisch-tabs/:id/verschieben',            { zielTischNummer: '8', positionen: [POSITION] }],
  ['GET',    '/api/tisch-tabs/:id/verlauf'],
  ['POST',   '/api/tisch-tabs/:id/splitten',               { zahlungen: [{ positionen: [POSITION], zahlung: ZAHLUNG }, { positionen: [POSITION], zahlung: ZAHLUNG }] }],
  ['POST',   '/api/tisch-tabs/:id/gang-abrufen'],
  ['POST',   '/api/tisch-tabs/:id/position-nachschicken',  { positionIndex: 0 }],
  // lieferschein.route.ts
  ['GET',    '/api/lieferscheine/:id'],
  ['PATCH',  '/api/lieferscheine/:id',                     { notiz: 'Nachtrag' }],
  ['POST',   '/api/lieferscheine/:id/drucken',             { kasseId: ANDERE }],
  ['POST',   '/api/lieferscheine/:id/email',               { empfaenger: 'kunde@example.at' }],
  ['GET',    '/api/sammelrechnungen/:id'],
  ['POST',   '/api/sammelrechnungen/:id/drucken',          { kasseId: ANDERE }],
  ['POST',   '/api/sammelrechnungen/:id/email',            { empfaenger: 'kunde@example.at' }],
  // gutschein.route.ts
  ['GET',    '/api/gutscheine/:id'],
  ['GET',    '/api/gutscheine/:id/buchungen'],
  ['POST',   '/api/gutscheine/:id/einloesen',              { einloesungCent: 100 }],
  ['POST',   '/api/gutscheine/:id/stornieren'],
  ['POST',   '/api/gutscheine/:id/drucken',                { kasseId: ANDERE }],
  // tischplan.route.ts
  ['PATCH',  '/api/tischplan/bereiche/:id',                { name: 'Terrasse' }],
  ['DELETE', '/api/tischplan/bereiche/:id'],
  ['PATCH',  '/api/tischplan/elemente/:id',                { x: 10 }],
  ['DELETE', '/api/tischplan/elemente/:id'],
  // kunde.route.ts
  ['GET',    '/api/kunden/:id'],
  ['PUT',    '/api/kunden/:id',                            { nachname: 'Muster' }],
  ['GET',    '/api/kunden/:id/belege'],
  ['DELETE', '/api/kunden/:id'],
  // kasse.route.ts
  ['POST',   '/api/kassen/:id/ausser-betrieb',             {}],
  ['GET',    '/api/kassen/:id/status'],
  ['GET',    '/api/kassen/:id/jahresbeleg-status'],
  ['PATCH',  '/api/kassen/:id/bezeichnung',                { bezeichnung: 'Bar' }],
  ['GET',    '/api/kassen/:id/see'],
  ['POST',   '/api/kassen/:id/see/test',                   { seeTyp: 'software' }],
  ['PATCH',  '/api/kassen/:id/see',                        { seeTyp: 'software' }],
  // user.route.ts
  ['PUT',    '/api/users/:id',                             { name: 'Neuer Name' }],
  ['DELETE', '/api/users/:id'],
  // offenerPosten.route.ts
  ['GET',    '/api/offene-posten/:id'],
  ['POST',   '/api/offene-posten/:id/zahlung',             { zahlungCent: 100 }],
  // angebot.route.ts
  ['GET',    '/api/angebote/:id'],
  ['PATCH',  '/api/angebote/:id',                          { notiz: 'Nachtrag' }],
]

describe('Ungültige uuid-Pfadparameter (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  const anfrage = (method: typeof ROUTEN[number][0], pfad: string, id: string, payload?: object) =>
    srv.fastify.inject({ method, url: pfad.replace(':id', id), headers: auth(), ...(payload && { payload }) })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, {
      finanzOnlineClient: mockFoClient(),
      // Mit SMTP gehen die E-Mail-Routen bis zur Abfrage (sonst 409 davor)
      config: { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'belege@test.at' },
    })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Ungültige ID OG', uid: 'ATU99999943', kassenId: 'UI-001',
        finanzOnline: { teilnehmerId: 'TID-UI', benutzerkennung: 'BID-UI', pin: 'PIN-UI' },
        umgebung: 'test',
        admin: { name: 'UI Admin', email: EMAIL, passwort: PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup: ${setup.body}`)
    const login = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, passwort: PASSWORT } })
    if (login.statusCode !== 200) throw new Error(`Login: ${login.body}`)
    token = login.json().token
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it.each(ROUTEN)('%s %s: ungültige ID → 400 „Ungültige ID"', async (method, pfad, payload) => {
    const res = await anfrage(method, pfad, UNGUELTIG, payload)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ fehler: 'Ungültige ID' })
  })

  it.each(ROUTEN)('%s %s: gültige, unbekannte ID erreicht die Abfrage — kein 500', async (method, pfad, payload) => {
    const res = await anfrage(method, pfad, UNBEKANNT, payload)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.body).not.toContain('Ungültige ID')
  })

  it('Anmeldung wird vor der ID geprüft: ohne Token 401', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/kunden/${UNGUELTIG}` })
    expect(res.statusCode).toBe(401)
  })

  it('Gutschein-Code ist kein uuid-Parameter: unbekannter Code → 404', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/gutscheine/code/${UNGUELTIG}`, headers: auth() })
    expect(res.statusCode).toBe(404)
  })
})
