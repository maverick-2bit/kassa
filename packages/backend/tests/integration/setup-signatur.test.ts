/**
 * Integrationstest: Einrichtung mit Signaturwahl — die Kasse wird KOMPLETT auf die gewählte Variante gestellt.
 *
 *   - Signaturkarte (Stick): Karte + PIN werden VOR der FinanzOnline-Meldung geprüft (falsche PIN → keine Meldung,
 *     nichts angelegt); der Startbeleg ist schon mit der Karte signiert (_R1-AT1_), FinanzOnline bekommt
 *     SIGNATURKARTE/AT1 mit dem Kartenzertifikat
 *   - weitere Kasse ohne Angabe übernimmt die Variante (dieselbe Karte, Startbeleg mit der Karte)
 *   - A-Trust online (Mock): Startbeleg von A-Trust signiert, HSM_DIENSTLEISTER
 */

import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import {
  SimulierteSignaturkarte,
  generateSEE,
  jwsSigningInput,
  signiereRoh,
  verifiziereQrCode,
  type FinanzOnlineClient,
  type SEEConfig,
} from '@kassa/rksv'
import { belege, kassen, mandanten } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@setup-signatur.at'
const ADMIN_PASSWORT = 'setup-signatur-passwort-1'
const FON = { teilnehmerId: 'TID-SS', benutzerkennung: 'BID-SS', pin: 'FONPIN-SS' }

describe('Einrichtung mit Signaturwahl (Integration, echtes PostgreSQL + Kartensimulator + A-Trust-Mock)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let karte: SimulierteSignaturkarte
  let hsmSee: SEEConfig
  let mock: { server: Server; basisUrl: string }
  let token: string
  const kasseInBetriebNehmen = vi.fn().mockResolvedValue({ erfolgreich: true })
  const foClient = {
    kasseInBetriebNehmen,
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SS-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(),
    seeAusfallMelden:              vi.fn().mockResolvedValue({ erfolgreich: true }),
    seeWiederinbetriebnahmeMelden: vi.fn().mockResolvedValue({ erfolgreich: true }),
  } as unknown as FinanzOnlineClient

  const setup = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    srv.fastify.inject({ method: 'POST', url: '/api/setup', headers, payload })
  const grund = {
    firmenname: 'Setup Signatur GmbH', uid: 'ATU99999913', kassenId: 'SS-001', umgebung: 'test', finanzOnline: FON,
    admin: { name: 'SS Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  }

  async function starteAtrustMock(): Promise<{ server: Server; basisUrl: string }> {
    const server = createServer((req, res) => {
      const antworte = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.method === 'GET' && req.url?.endsWith('/ZDA')) return antworte(200, { zdaid: 'AT1' })
      if (req.method === 'GET' && req.url?.endsWith('/Certificate')) {
        return antworte(200, { Signaturzertifikat: hsmSee.zertifikatDER.toString('base64'), ZertifikatsseriennummerHex: '' })
      }
      if (req.method === 'POST' && req.url?.endsWith('/Sign/JWS')) {
        let roh = ''
        req.on('data', (c: Buffer) => { roh += c.toString('utf8') })
        req.on('end', () => {
          const body = JSON.parse(roh) as { jws_payload: string }
          antworte(200, { result: signiereRoh(jwsSigningInput(body.jws_payload), hsmSee).toString('base64url') })
        })
        return
      }
      antworte(404, {})
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const a = server.address() as { port: number }
    return { server, basisUrl: `http://127.0.0.1:${a.port}` }
  }

  beforeAll(async () => {
    karte  = await SimulierteSignaturkarte.erzeuge({ pin: '123456' })
    hsmSee = await generateSEE({ kassenId: 'ATRUST-HSM', uid: 'ATU00000001', firmenname: 'A-Trust Mock' })
    mock   = await starteAtrustMock()
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: foClient, kartenTransport: karte })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
    mock?.server.close()
  })

  it('„Karte prüfen" vor der Einrichtung: erkennt die Karte ohne PIN', async () => {
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/setup/signaturkarte', payload: { uid: grund.uid } })
    expect(res.json()).toMatchObject({ erfolgreich: true, karte: 'A-Trust ACOS-ID 4.1' })
    expect(karte.pinPruefungen).toBe(0)
  })

  it('Stick mit falscher PIN: Abbruch VOR der FinanzOnline-Meldung, nichts angelegt, genau ein Fehlversuch', async () => {
    const res = await setup({ ...grund, signatur: { art: 'atrust_chip', kartePin: '654321' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toMatch(/PIN ist falsch.*noch 2 Versuche/)
    expect(kasseInBetriebNehmen).not.toHaveBeenCalled()
    expect(karte.pinPruefungen).toBe(1)
    expect(await idb.db.select().from(mandanten)).toHaveLength(0)
  })

  it('Stick mit richtiger PIN: Kasse komplett auf die Karte, Startbeleg mit der Karte, FinanzOnline SIGNATURKARTE/AT1', async () => {
    const res = await setup({ ...grund, signatur: { art: 'atrust_chip', kartePin: '123456' } })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { kasseId: string; startbelegMaschinenlesbareCode: string }
    expect(body.startbelegMaschinenlesbareCode).toMatch(/^_R1-AT1_SS-001_/)
    expect(verifiziereQrCode(body.startbelegMaschinenlesbareCode, karte.zertifikatDer)).toBe(true)

    const [k] = await idb.db.select().from(kassen).where(eq(kassen.id, body.kasseId))
    expect(k).toMatchObject({ seeTyp: 'atrust_chip', seeZdaId: 'AT1', kartePinGesperrt: false, bei_fo_registriert: true })
    expect(k!.seeZertifikatDer).toBe(karte.zertifikatDer.toString('base64'))
    expect(k!.kartePinEnc).not.toBeNull()

    expect(kasseInBetriebNehmen).toHaveBeenCalledTimes(1)
    const meldung = kasseInBetriebNehmen.mock.calls[0]![0] as { artSe: string; vdaId: string; zertifikatDER: Buffer }
    expect(meldung).toMatchObject({ artSe: 'SIGNATURKARTE', vdaId: 'AT1' })
    expect(meldung.zertifikatDER.equals(karte.zertifikatDer)).toBe(true)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json() as { token: string; kassen: { id: string }[] }
    token = login.token

    // Verkauf: ebenfalls mit der Karte
    const verkauf = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: { authorization: `Bearer ${token}` },
      payload: {
        kasseId: body.kasseId,
        positionen: [{ bezeichnung: 'Probe', preisBruttoCent: 400, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 400, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(verkauf.statusCode).toBe(201)
    expect(verifiziereQrCode((verkauf.json() as { maschinenlesbareCode: string }).maschinenlesbareCode, karte.zertifikatDer)).toBe(true)
  })

  it('weitere Kasse ohne Angabe übernimmt den Stick: dieselbe Karte, Startbeleg mit der Karte', async () => {
    const vorher = karte.signaturen
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: { authorization: `Bearer ${token}` },
      payload: { kassenId: 'SS-002', umgebung: 'test' },
    })
    expect(res.statusCode).toBe(201)
    const kasseId = (res.json() as { kasseId: string }).kasseId
    const [k] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    expect(k).toMatchObject({ seeTyp: 'atrust_chip', seeZdaId: 'AT1' })
    const [start] = await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId)).orderBy(asc(belege.belegNummer)).limit(1)
    expect(start!.maschinenlesbareCode).toMatch(/^_R1-AT1_SS-002_/)
    expect(verifiziereQrCode(start!.maschinenlesbareCode, karte.zertifikatDer)).toBe(true)
    expect(karte.signaturen).toBeGreaterThan(vorher)
  })

  it('A-Trust online (weiterer Mandant): Startbeleg von A-Trust signiert, FinanzOnline HSM_DIENSTLEISTER', async () => {
    kasseInBetriebNehmen.mockClear()
    const res = await setup({
      ...grund, uid: 'ATU99999914', kassenId: 'SS-ONLINE', admin: { name: 'Online', email: 'online@setup-signatur.at', passwort: ADMIN_PASSWORT },
      signatur: { art: 'atrust_hsm', atrustBasisUrl: mock.basisUrl, atrustBenutzer: 'u1', atrustPasswort: 'geheim' },
    }, { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { kasseId: string; startbelegMaschinenlesbareCode: string }
    expect(body.startbelegMaschinenlesbareCode).toMatch(/^_R1-AT1_SS-ONLINE_/)
    expect(verifiziereQrCode(body.startbelegMaschinenlesbareCode, hsmSee.zertifikatDER)).toBe(true)
    const [k] = await idb.db.select().from(kassen).where(eq(kassen.id, body.kasseId))
    expect(k).toMatchObject({ seeTyp: 'atrust_hsm', seeZdaId: 'AT1', atrustBenutzer: 'u1' })
    expect(kasseInBetriebNehmen.mock.calls[0]![0]).toMatchObject({ artSe: 'HSM_DIENSTLEISTER', vdaId: 'AT1' })
  })

  it('A-Trust online mit fremder Adresse: abgewiesen, bevor Zugangsdaten irgendwohin gehen', async () => {
    const res = await setup({
      ...grund, uid: 'ATU99999915', kassenId: 'SS-X', admin: { name: 'X', email: 'x@setup-signatur.at', passwort: ADMIN_PASSWORT },
      signatur: { art: 'atrust_hsm', atrustBasisUrl: 'https://boese.example/RegistrierkasseMobile/v2', atrustBenutzer: 'u1', atrustPasswort: 'geheim' },
    }, { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toMatch(/A-Trust-Server/)
  })
})
