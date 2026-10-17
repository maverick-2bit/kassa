/**
 * Integrationstest: Mandanten-Übergabe über die Kassa-Oberfläche (Routen) —
 * Export als verschlüsselte Datei, Import als zusätzlicher Mandant, Schutz vor
 * manipulierten Dateien.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import postgres from 'postgres'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { exportiereMandant } from '../../src/services/mandant-transfer.service.js'
import { verschluesselePaket } from '../../src/crypto/uebergabe-datei.js'
import { TEST_MASTER } from '../helpers/testServer.js'
import { mandanten, kategorien } from '../../src/db/schema.js'

const PW = 'transfer-passwort-123'
const UEBERGABE_PW = 'uebergabe-passwort-lang'

const fo = () => ({
  kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
  startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'FO-PW' }),
  kasseAusserBetriebNehmen: vi.fn(),
}) as unknown as FinanzOnlineClient

const setup = (firma: string, uid: string, kassenId: string, email: string) => ({
  firmenname: firma, uid, kassenId, umgebung: 'test', admin: { name: 'Admin', email, passwort: PW },
})

describe('Mandanten-Übergabe über die Oberfläche (Integration)', () => {
  let quelle: IntegrationsDb, ziel: IntegrationsDb
  let quellSrv: TestServer, zielSrv: TestServer
  let quellToken = '', zielToken = ''
  let paket: Buffer

  const login = async (srv: TestServer, email: string) =>
    (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, passwort: PW } })).json()

  beforeAll(async () => {
    quelle = await erstelleIntegrationsDb()
    ziel   = await erstelleIntegrationsDb()
    quellSrv = await buildTestServer(quelle.db, { finanzOnlineClient: fo(), config: { DATABASE_URL: quelle.url } })
    zielSrv  = await buildTestServer(ziel.db,   { finanzOnlineClient: fo(), config: { DATABASE_URL: ziel.url } })
    for (const [srv, p] of [
      [quellSrv, setup('Laptop-Test GmbH', 'ATU11111111', 'LAPTOP-1', 'laptop@route.at')],
      [zielSrv,  setup('PC-Bestand GmbH',  'ATU22222222', 'PC-1',     'pc@route.at')],
    ] as const) {
      const r = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: p })
      if (r.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${r.body}`)
    }
    quellToken = (await login(quellSrv, 'laptop@route.at')).token
    zielToken  = (await login(zielSrv, 'pc@route.at')).token
  })

  afterAll(async () => {
    await quellSrv?.close(); await zielSrv?.close()
    await quelle?.zerstoeren(); await ziel?.zerstoeren()
  })

  const auth = (t: string) => ({ authorization: `Bearer ${t}` })

  it('Export braucht ein Passwort und einen Admin', async () => {
    const kurz = await quellSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/export', headers: auth(quellToken), payload: { passwort: 'kurz' } })
    expect(kurz.statusCode).toBe(400)
    const kassier = await quellSrv.fastify.inject({
      method: 'POST', url: '/api/mandant-uebergabe/export',
      headers: quellSrv.authHeader({ rolle: 'kassier' }), payload: { passwort: UEBERGABE_PW },
    })
    expect(kassier.statusCode).toBe(403)
  })

  it('Export → Import: Mandant steht neben dem vorhandenen, Login funktioniert', async () => {
    const ex = await quellSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/export', headers: auth(quellToken), payload: { passwort: UEBERGABE_PW } })
    expect(ex.statusCode).toBe(200)
    expect(ex.headers['content-disposition']).toMatch(/kassa-mandant-laptop-test-gmbh-\d{4}-\d{2}-\d{2}\.kuep/)
    paket = ex.rawPayload
    expect(paket.subarray(0, 5).toString()).toBe('KUEP2')

    const falsch = await zielSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/import', headers: auth(zielToken), payload: { passwort: 'falsches-passwort', datei: paket.toString('base64') } })
    expect(falsch.statusCode).toBe(400)
    expect(falsch.json().fehler).toMatch(/Falsches Passwort/)

    const im = await zielSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/import', headers: auth(zielToken), payload: { passwort: UEBERGABE_PW, datei: paket.toString('base64') } })
    expect(im.statusCode, im.body).toBe(201)
    expect(im.json().name).toBe('Laptop-Test GmbH')

    expect((await ziel.db.select().from(mandanten)).length).toBe(2)
    expect((await login(zielSrv, 'laptop@route.at')).token).toBeTruthy()
    expect((await login(zielSrv, 'pc@route.at')).token).toBeTruthy()
  })

  it('derselbe Mandant lässt sich nicht noch einmal einspielen', async () => {
    const im = await zielSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/import', headers: auth(zielToken), payload: { passwort: UEBERGABE_PW, datei: paket.toString('base64') } })
    expect(im.statusCode).toBe(400)
    expect(im.json().fehler).toMatch(/existiert in dieser Kassa bereits/)
  })

  it('manipulierte Datei mit Daten eines anderen Mandanten wird abgelehnt', async () => {
    const zielMandant = (await ziel.db.select().from(mandanten)).find(m => m.firmenname === 'PC-Bestand GmbH')!
    const sql = postgres(quelle.url, { max: 1, onnotice: () => {}, fetch_types: false })
    const [quellMandant] = await quelle.db.select().from(mandanten)
    const daten = JSON.parse(JSON.stringify(await exportiereMandant(sql, quellMandant!.id, TEST_MASTER)))
    await sql.end()
    // neuer Mandant, aber eine Zeile schleust Daten in den vorhandenen Mandanten des Ziels
    daten.mandantId = '99999999-9999-4999-8999-999999999999'
    daten.tabellen['mandanten'][0].id = daten.mandantId
    for (const [t, zeilen] of Object.entries<any[]>(daten.tabellen)) {
      if (t !== 'mandanten') for (const z of zeilen) if ('mandant_id' in z) z.mandant_id = daten.mandantId
    }
    daten.tabellen['kategorien'] = [{ id: '88888888-8888-4888-8888-888888888888', mandant_id: zielMandant.id, name: 'Eingeschleust' }]
    const boese = verschluesselePaket(Buffer.from(JSON.stringify(daten)), UEBERGABE_PW)

    const im = await zielSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/import', headers: auth(zielToken), payload: { passwort: UEBERGABE_PW, datei: boese.toString('base64') } })
    expect(im.statusCode).toBe(400)
    expect(im.json().fehler).toMatch(/anderen Mandanten/)
    expect((await ziel.db.select().from(kategorien)).some(k => k.name === 'Eingeschleust')).toBe(false)
  })

  it('Export sperrt die Quelle für Belege (Standard), Ziel startet aktiv, Sperre ist aufhebbar', async () => {
    const kasseId = (await login(quellSrv, 'laptop@route.at')).kassen[0].id
    const barzahlung = { kasseId, positionen: [{ bezeichnung: 'Test', preisBruttoCent: 500, mwstSatz: 'normal', menge: 1 }], zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 } }
    const bar = () => quellSrv.fastify.inject({ method: 'POST', url: '/api/belege/barzahlung', headers: auth(quellToken), payload: barzahlung })

    // der Export im vorigen Test hat gesperrt (Standard)
    expect((await quellSrv.fastify.inject({ method: 'GET', url: '/api/mandant-uebergabe/status', headers: auth(quellToken) })).json().gesperrt).toBe(true)
    const gesperrt = await bar()
    expect(gesperrt.statusCode).toBe(409)
    expect(gesperrt.json().fehler).toMatch(/auf eine andere Kassa übertragen/)

    // am Ziel ist der übertragene Mandant aktiv und kann belegen
    const zielLogin = await login(zielSrv, 'laptop@route.at')
    const amZiel = await zielSrv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(zielLogin.token),
      payload: { ...barzahlung, kasseId: zielLogin.kassen[0].id },
    })
    expect(amZiel.statusCode, amZiel.body).toBe(201)

    // Sperre aufheben → Quelle belegt wieder
    const auf = await quellSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/sperre-aufheben', headers: auth(quellToken) })
    expect(auf.json().gesperrt).toBe(false)
    expect((await bar()).statusCode).toBe(201)

    // Export mit sperren:false lässt die Quelle offen
    const ohne = await quellSrv.fastify.inject({ method: 'POST', url: '/api/mandant-uebergabe/export', headers: auth(quellToken), payload: { passwort: UEBERGABE_PW, sperren: false } })
    expect(ohne.statusCode).toBe(200)
    expect((await bar()).statusCode).toBe(201)
  })
})
