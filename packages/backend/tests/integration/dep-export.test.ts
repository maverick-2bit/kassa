/**
 * Integrationstest: DEP7- und DEP131-Archivexport gegen echtes PostgreSQL.
 *
 * Das DEP ist das gesetzlich vorgeschriebene, vollstaendige Belegarchiv
 * (RKSV, 7 Jahre Aufbewahrung) — anders als der BMD-Export enthaelt es ALLE
 * Belegtypen inkl. Start- und Nullbeleg. Geprueft wird:
 *  - DEP7 ist formal gueltig (validiereDEP7) und enthaelt jeden Beleg als
 *    _R1-AT_-Maschinencode
 *  - DEP131 enthaelt die vollstaendigen Belegfelder inkl. Signaturkette
 *  - lueckenlose Belegnummern, Datumsbereich, Auth.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { validiereDEP7, dep7AusJson, type DEP131Export } from '@kassa/rksv'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@dep-export.at'
const ADMIN_PASSWORT = 'dep-export-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'DEP-Export Test GmbH',
  uid:        'ATU99999903',
  kassenId:   'DEP-001',
  finanzOnline: { teilnehmerId: 'TID-DEP', benutzerkennung: 'BID-DEP', pin: 'PIN-DEP' },
  umgebung: 'test',
  admin: { name: 'DEP Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

function barzahlung(kasseId: string, preisBruttoCent: number) {
  return {
    kasseId,
    positionen: [{ bezeichnung: 'Testartikel', preisBruttoCent, mwstSatz: 'normal', menge: 1 }],
    zahlung: { barCent: preisBruttoCent, karteCent: 0, sonstigeCent: 0 },
  }
}

interface BelegListItem { id: string; belegTyp: string; belegNummer: number }

describe('DEP-Export (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)

    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    if (loginRes.statusCode !== 200) throw new Error(`Login (${loginRes.statusCode}): ${loginRes.body}`)
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Belegmix erzeugen: 2 Barzahlungen, 1 Storno, 1 Nullbeleg (+ Startbeleg aus Setup)
    for (const preis of [1500, 2000]) {
      const r = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung', headers: auth(), payload: barzahlung(kasseId, preis),
      })
      if (r.statusCode !== 201) throw new Error(`Barzahlung (${r.statusCode}): ${r.body}`)
    }
    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    const original = (liste.json() as BelegListItem[]).find(b => b.belegTyp === 'Barzahlungsbeleg')!
    await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(),
      payload: { kasseId, verweisBelegId: original.id, grund: 'DEP-Test' },
    })
    await srv.fastify.inject({
      method: 'POST', url: '/api/belege/nullbeleg', headers: auth(), payload: { kasseId },
    })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert DEP7-Export ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/belege/dep7?kasseId=${kasseId}` })
    expect(res.statusCode).toBe(401)
  })

  it('DEP7 ist formal gueltig und enthaelt das vollstaendige Archiv', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege/dep7?kasseId=${kasseId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')

    // Startbeleg + 2 Barzahlungen + 1 Storno + 1 Nullbeleg = 5
    expect(res.headers['x-anzahl-belege']).toBe('5')

    const dep = dep7AusJson(res.body)
    expect(dep['Belege-Gruppe']).toHaveLength(1) // eine Gruppe (kein Zertifikatswechsel)

    const val = validiereDEP7(dep)
    expect(val.gueltig).toBe(true)
    expect(val.fehler).toEqual([])
    expect(val.anzahlBelege).toBe(5)

    // jeder Beleg ist ein RKSV-JWS (Payload = Code ohne Signatur)
    for (const jws of dep['Belege-Gruppe'][0]!['Belege-kompakt']) {
      const teile = jws.split('.')
      expect(teile).toHaveLength(3)
      expect(Buffer.from(teile[1]!, 'base64url').toString('utf8').startsWith('_R1-AT0_')).toBe(true)
    }
  })

  it('DEP131 enthaelt vollstaendige Belegfelder inkl. lueckenloser Signaturkette', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege/dep131?kasseId=${kasseId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-anzahl-belege']).toBe('5')

    const dep = JSON.parse(res.body) as DEP131Export
    expect(dep.kassenId).toBe('DEP-001')
    expect(dep.Belege).toHaveLength(5)

    // erster Beleg ist der Startbeleg, jeder Beleg traegt Signaturfelder
    expect(dep.Belege[0]!.Belegtyp).toBe('Startbeleg')
    for (const b of dep.Belege) {
      expect(b.Signaturwert).toBeTruthy()
      expect(b.MaschinenlesbareCode.startsWith('_R1-AT0_')).toBe(true)
      expect(typeof b.SigVorbeleg).toBe('string')
    }

    // Belegnummern lueckenlos aufsteigend
    const nummern = dep.Belege.map(b => b.Belegnummer)
    for (let i = 1; i < nummern.length; i++) {
      expect(nummern[i]).toBe(nummern[i - 1]! + 1)
    }
  })

  it('respektiert den Datumsbereich (Vergangenheit -> leeres Archiv)', async () => {
    const res = await srv.fastify.inject({
      method: 'GET',
      url: `/api/belege/dep7?kasseId=${kasseId}&vonDatum=2020-01-01&bisDatum=2020-12-31`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-anzahl-belege']).toBe('0')
  })
})
