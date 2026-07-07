/**
 * Integrationstest: A-Trust a.sign RK HSM als Signaturerstellungseinheit.
 *
 * Ein lokaler Mock implementiert die echte A-Trust-REST-API (/Certificate,
 * /ZDA, /Sign/JWS) mit einem echten ECDSA-Schlüssel — damit ist die komplette
 * Strecke kryptographisch prüfbar:
 *  - PATCH /kassen/:id/see übernimmt Zertifikat + ZDA von A-Trust
 *  - Belege tragen den ZDA-Prefix (_R1-AT1_) und verifizieren gegen das
 *    A-Trust-Zertifikat (JWS-Signing-Input)
 *  - Verkettung läuft über den SEE-Wechsel hinweg weiter
 *  - Ist die Einheit nicht erreichbar, greift automatisch der SEE-Ausfallmodus
 */

import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  generateSEE,
  jwsSigningInput,
  signiereRoh,
  verifiziereQrCode,
  istAusfallBeleg,
  pruefeKette,
  type FinanzOnlineClient,
  type SEEConfig,
} from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@seeatrust.at'
const ADMIN_PASSWORT = 'seeatrust-passwort-123'
const ATRUST_BENUTZER = 'u123456789'
const ATRUST_PASSWORT = 'test-passwort'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SEEA-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'SEE A-Trust Test GmbH',
  uid:        'ATU99999909',
  kassenId:   'SEEA-001',
  finanzOnline: { teilnehmerId: 'TID-SEEA', benutzerkennung: 'BID-SEEA', pin: 'PIN-SEEA' },
  umgebung: 'test',
  admin: { name: 'SEEA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

/** Lokaler A-Trust-Mock: echte API-Formen, echter ECDSA-Schlüssel. */
async function starteATrustMock(hsmSee: SEEConfig): Promise<{ server: Server; basisUrl: string }> {
  const server = createServer((req, res) => {
    const antworte = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && req.url?.endsWith('/ZDA')) {
      return antworte(200, { zdaid: 'AT1' })
    }
    if (req.method === 'GET' && req.url?.endsWith('/Certificate')) {
      return antworte(200, {
        Signaturzertifikat:          hsmSee.zertifikatDER.toString('base64'),
        ZertifikatsseriennummerHex:  '',
        Zertifizierungsstellen:      [],
      })
    }
    if (req.method === 'POST' && req.url?.endsWith('/Sign/JWS')) {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
      req.on('end', () => {
        const body = JSON.parse(raw) as { password?: string; jws_payload?: string }
        if (body.password !== ATRUST_PASSWORT) return antworte(401, { fehler: 'Falsches Passwort' })
        if (!body.jws_payload)                 return antworte(400, { fehler: 'jws_payload fehlt' })
        const sig = signiereRoh(jwsSigningInput(body.jws_payload), hsmSee)
        antworte(200, { result: sig.toString('base64url') })
      })
      return
    }
    antworte(404, { fehler: 'Unbekannter Pfad' })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const adresse = server.address()
  const port    = typeof adresse === 'object' && adresse ? adresse.port : 0
  return { server, basisUrl: `http://127.0.0.1:${port}` }
}

describe('SEE A-Trust HSM (Integration, echtes PostgreSQL + API-Mock)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let hsmSee: SEEConfig
  let mock: { server: Server; basisUrl: string }

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    hsmSee = await generateSEE({ kassenId: 'ATRUST-HSM', uid: 'ATU00000001', firmenname: 'A-Trust Mock' })
    mock   = await starteATrustMock(hsmSee)

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
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
    mock?.server.close()
  })

  it('Verbindung testen liefert ZDA + Zertifikat, ohne zu speichern', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${kasseId}/see/test`, headers: auth(),
      payload: { seeTyp: 'atrust_hsm', atrustBasisUrl: mock.basisUrl, atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ erfolgreich: true, zdaId: 'AT1' })

    // nicht gespeichert
    const konfig = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/see`, headers: auth() })
    expect(konfig.json().seeTyp).toBe('software')
  })

  it('PATCH übernimmt A-Trust-Zertifikat + ZDA', async () => {
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/see`, headers: auth(),
      payload: { seeTyp: 'atrust_hsm', atrustBasisUrl: mock.basisUrl, atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().erfolgreich).toBe(true)

    const konfig = (await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/see`, headers: auth() })).json()
    expect(konfig.seeTyp).toBe('atrust_hsm')
    expect(konfig.seeZdaId).toBe('AT1')
    expect(konfig.atrustPasswortGesetzt).toBe(true)
  })

  it('Belege tragen den A-Trust-ZDA-Prefix und verifizieren gegen das A-Trust-Zertifikat', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'HSM-Test', preisBruttoCent: 990, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 990, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(201)
    const beleg = res.json() as BelegResponse
    expect(beleg.maschinenlesbareCode.startsWith('_R1-AT1_')).toBe(true)
    expect(verifiziereQrCode(beleg.maschinenlesbareCode, hsmSee.zertifikatDER)).toBe(true)
  })

  it('Verkettung bleibt über den SEE-Wechsel hinweg geschlossen', async () => {
    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    const belege = (liste.json() as BelegResponse[]).sort((a, b) => a.belegNummer - b.belegNummer)
    expect(belege.length).toBeGreaterThanOrEqual(2) // Startbeleg (AT0) + HSM-Beleg (AT1)
    expect(pruefeKette('SEEA-001', belege.map(b => ({
      maschinenlesbareCode: b.maschinenlesbareCode,
      sigVorbeleg:          b.sigVorbeleg,
    })))).toBe(true)
  })

  it('nicht erreichbare Einheit → automatischer SEE-Ausfallmodus (Marker-Beleg)', async () => {
    // Kasse auf eine tote Adresse zeigen lassen (Timeout kurz)
    await idb.db.update(kassen)
      .set({ atrustBasisUrl: 'http://127.0.0.1:1' })
      .where(eq(kassen.id, kasseId))

    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Offline-Test', preisBruttoCent: 500, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(201)
    const beleg = res.json() as BelegResponse
    expect(istAusfallBeleg(beleg.signaturwert)).toBe(true)

    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    expect(kasse!.seeAusgefallenSeit).not.toBeNull()

    // Mock wieder erreichbar machen für nachfolgende Sauberkeit
    await idb.db.update(kassen)
      .set({ atrustBasisUrl: mock.basisUrl })
      .where(eq(kassen.id, kasseId))
  }, 15_000)
})
