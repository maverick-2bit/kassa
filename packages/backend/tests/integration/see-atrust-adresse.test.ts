/**
 * Integrationstest: Wohin gehen die A-Trust-Zugangsdaten?
 *
 * „Verbindung testen" und „Speichern" schicken Benutzer UND Passwort an die Basis-URL — das gespeicherte Passwort,
 * wenn im Formular keines eingegeben wird. Wer die Einstellungen ändern darf (Admin oder Berechtigung
 * „einstellungen"), brauchte also nur die Adresse auf einen eigenen Server zu stellen, um das Passwort abzugreifen.
 * Jetzt: nur A-Trust-Server als Ziel, und eine geänderte Adresse verlangt das Passwort neu.
 *
 * (In Tests ist zusätzlich der eigene Rechner erlaubt, für die Mock-Server — in Produktion nicht.)
 */

import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { generateSEE, type FinanzOnlineClient, type SEEConfig } from '@kassa/rksv'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL     = 'admin@atrust-adresse.at'
const ADMIN_PASSWORT  = 'atrust-adresse-passwort-123'
const ATRUST_BENUTZER = 'u123456789'
const ATRUST_PASSWORT = 'geheimes-hsm-passwort'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'AA-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

interface Aufruf { url: string; body: string }

/** Kleiner Server, der jede Anfrage mitschreibt; mit `see` antwortet er wie A-Trust (ZDA + Zertifikat). */
async function starteServer(see?: SEEConfig): Promise<{ server: Server; basisUrl: string; aufrufe: Aufruf[] }> {
  const aufrufe: Aufruf[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString('utf8') })
    req.on('end', () => {
      aufrufe.push({ url: req.url ?? '', body })
      res.writeHead(see ? 200 : 404, { 'Content-Type': 'application/json' })
      if (!see) return res.end('{}')
      if (req.url?.endsWith('/ZDA')) return res.end(JSON.stringify({ zdaid: 'AT1' }))
      if (req.url?.endsWith('/Certificate')) {
        return res.end(JSON.stringify({
          Signaturzertifikat: see.zertifikatDER.toString('base64'), ZertifikatsseriennummerHex: '', Zertifizierungsstellen: [],
        }))
      }
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const adresse = server.address()
  return { server, basisUrl: `http://127.0.0.1:${typeof adresse === 'object' && adresse ? adresse.port : 0}`, aufrufe }
}

describe('A-Trust-Basis-URL und Passwort (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let srvProduktion: TestServer
  let token: string
  let kasseId: string
  let echt: Awaited<ReturnType<typeof starteServer>>       // "A-Trust"
  let fremd: Awaited<ReturnType<typeof starteServer>>      // der Server des Angreifers

  const auth = () => ({ authorization: `Bearer ${token}` })
  const see = (methode: 'PATCH' | 'POST', payload: Record<string, unknown>, server = srv) =>
    server.fastify.inject({
      method: methode, url: `/api/kassen/${kasseId}/see${methode === 'POST' ? '/test' : ''}`, headers: auth(), payload,
    })
  const gespeicherteUrl = async () =>
    (await idb.db.select({ url: kassen.atrustBasisUrl }).from(kassen).where(eq(kassen.id, kasseId)))[0]!.url

  beforeAll(async () => {
    const hsm = await generateSEE({ kassenId: 'ATRUST-ADR', uid: 'ATU00000001', firmenname: 'A-Trust Mock' })
    echt  = await starteServer(hsm)
    fremd = await starteServer()

    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    srvProduktion = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient(), config: { NODE_ENV: 'production' } })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'A-Trust Adresse GmbH', uid: 'ATU99999961', kassenId: 'AA-001', umgebung: 'test',
        finanzOnline: { teilnehmerId: 'TID-AA', benutzerkennung: 'BID-AA', pin: 'PIN-AA' },
        admin: { name: 'AA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Ausgangslage: A-Trust ist eingerichtet, das Passwort gespeichert
    const patch = await see('PATCH', {
      seeTyp: 'atrust_hsm', atrustBasisUrl: echt.basisUrl, atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT,
    })
    expect(patch.statusCode).toBe(200)
  })

  afterAll(async () => {
    await srvProduktion?.close()
    await srv?.close()
    await idb?.zerstoeren()
    echt?.server.close()
    fremd?.server.close()
  })

  it.each([
    ['Verbindung testen', 'POST'],
    ['Speichern',         'PATCH'],
  ] as const)('%s: eine geänderte Adresse ohne neues Passwort wird abgelehnt — das gespeicherte geht nirgends hin', async (_name, methode) => {
    const res = await see(methode, { seeTyp: 'atrust_hsm', atrustBasisUrl: fremd.basisUrl })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { fehler: string }).fehler).toMatch(/Passwort erneut eingeben/)

    expect(fremd.aufrufe).toHaveLength(0)                       // beim fremden Server kam nichts an
    expect(await gespeicherteUrl()).toBe(echt.basisUrl)         // und es wurde nichts umgestellt
  })

  it('dieselbe Adresse in anderer Schreibweise (Schrägstrich am Ende) braucht das Passwort nicht neu', async () => {
    const vorher = echt.aufrufe.length
    const res = await see('POST', { seeTyp: 'atrust_hsm', atrustBasisUrl: `${echt.basisUrl}/` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ erfolgreich: true, zdaId: 'AT1' })
    expect(echt.aufrufe.length).toBeGreaterThan(vorher)         // das gespeicherte Passwort ging an die gleiche Adresse
  })

  it('wer die Adresse ändert und das Passwort neu eingibt, kommt durch', async () => {
    const res = await see('POST', {
      seeTyp: 'atrust_hsm', atrustBasisUrl: echt.basisUrl + '/', atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT,
    })
    expect(res.statusCode).toBe(200)
  })

  it.each([
    ['ein fremder Server',                  'https://evil.example/RegistrierkasseMobile/v2'],
    ['A-Trust als Unterdomain eines Fremden','https://hs.a-trust.at.evil.example/RegistrierkasseMobile/v2'],
    ['Zugangsdaten in der Adresse',         'https://hs.a-trust.at@evil.example/RegistrierkasseMobile/v2'],
    ['ohne Verschlüsselung',                'http://hs.a-trust.at/RegistrierkasseMobile/v2'],
  ])('%s wird auch MIT eingegebenem Passwort abgelehnt', async (_name, url) => {
    for (const methode of ['POST', 'PATCH'] as const) {
      const res = await see(methode, {
        seeTyp: 'atrust_hsm', atrustBasisUrl: url, atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT,
      })
      expect(res.statusCode, methode).toBe(400)
      expect((res.json() as { fehler: string }).fehler, methode).toMatch(/A-Trust-Server/)
    }
    expect(await gespeicherteUrl()).toBe(echt.basisUrl)
  })

  it('in Produktion ist auch der eigene Rechner kein Ziel', async () => {
    const res = await see('POST', {
      seeTyp: 'atrust_hsm', atrustBasisUrl: fremd.basisUrl, atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT,
    }, srvProduktion)
    expect(res.statusCode).toBe(400)
    expect((res.json() as { fehler: string }).fehler).toMatch(/A-Trust-Server/)
    expect(fremd.aufrufe).toHaveLength(0)
  })

  it('eine schon gespeicherte, nicht erlaubte Adresse bekommt das Passwort ebenfalls nicht (Altbestand)', async () => {
    await idb.db.update(kassen).set({ atrustBasisUrl: fremd.basisUrl }).where(eq(kassen.id, kasseId))
    try {
      const res = await see('POST', { seeTyp: 'atrust_hsm' }, srvProduktion)   // nichts eingegeben: es zählt der gespeicherte Stand
      expect(res.statusCode).toBe(400)
      expect(fremd.aufrufe).toHaveLength(0)
    } finally {
      await idb.db.update(kassen).set({ atrustBasisUrl: echt.basisUrl }).where(eq(kassen.id, kasseId))
    }
  })
})
