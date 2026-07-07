/**
 * Integrationstest: kompletter Beleg-Fluss gegen echtes PostgreSQL.
 *
 * Setup → Login → Barzahlungen → Storno → DEP-Belegliste.
 * Prüft das, was Mocks nicht beweisen können:
 *  - lückenlose Belegnummern über echte DB-Transaktionen
 *  - kryptographisch konsistente RKSV-Signaturkette (pruefeKette)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { pruefeKette, type FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@integrationstest.at'
const ADMIN_PASSWORT = 'integrationstest-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Integrationstest GmbH',
  uid:        'ATU99999901',
  kassenId:   'ITEST-001',
  finanzOnline: {
    teilnehmerId:    'TID-ITEST',
    benutzerkennung: 'BID-ITEST',
    pin:             'PIN-ITEST',
  },
  umgebung: 'test',
  admin: {
    name:     'Integration Admin',
    email:    ADMIN_EMAIL,
    passwort: ADMIN_PASSWORT,
  },
}

function barzahlung(kasseId: string, preisBruttoCent: number) {
  return {
    kasseId,
    positionen: [{
      bezeichnung:     'Testartikel',
      preisBruttoCent,
      mwstSatz:        'normal',
      menge:           1,
    }],
    zahlung: { barCent: preisBruttoCent, karteCent: 0, sonstigeCent: 0 },
  }
}

describe('Beleg-Fluss (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup', payload: setupInput,
    })
    if (setupRes.statusCode !== 201) {
      throw new Error(`Setup fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)
    }

    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    if (loginRes.statusCode !== 200) {
      throw new Error(`Login fehlgeschlagen (${loginRes.statusCode}): ${loginRes.body}`)
    }
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Setup hat genau eine Kasse mit Startbeleg angelegt', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const belege = res.json() as BelegResponse[]
    expect(belege).toHaveLength(1)
    expect(belege[0]!.belegTyp).toBe('Startbeleg')
    expect(belege[0]!.signaturwert).toBeTruthy()
  })

  it('Barzahlungen erhalten lückenlose, aufsteigende Belegnummern', async () => {
    const nummern: number[] = []
    for (const preis of [990, 1250, 750]) {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung',
        headers: auth(), payload: barzahlung(kasseId, preis),
      })
      expect(res.statusCode).toBe(201)
      const beleg = res.json() as BelegResponse
      expect(beleg.gesamtbetragCent).toBe(preis)
      nummern.push(beleg.belegNummer)
    }
    // lückenlos: jede Nummer genau +1 zur vorherigen
    expect(nummern[1]).toBe(nummern[0]! + 1)
    expect(nummern[2]).toBe(nummern[1]! + 1)
  })

  it('Storno verweist auf den Originalbeleg und setzt die Kette fort', async () => {
    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}`, headers: auth(),
    })
    const belege = liste.json() as BelegResponse[]
    const original = belege.find(b => b.belegTyp === 'Barzahlungsbeleg')
    expect(original).toBeDefined()

    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno',
      headers: auth(),
      payload: { kasseId, verweisBelegId: original!.id, grund: 'Integrationstest' },
    })
    expect(res.statusCode).toBe(201)
    const storno = res.json() as BelegResponse
    expect(storno.verweisBelegId).toBe(original!.id)
    expect(storno.gesamtbetragCent).toBe(-original!.gesamtbetragCent)
  })

  it('RKSV-Signaturkette ist über alle Belege kryptographisch konsistent', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const belege = (res.json() as BelegResponse[])
      .sort((a, b) => a.belegNummer - b.belegNummer)

    // Startbeleg + 3 Barzahlungen + 1 Storno
    expect(belege).toHaveLength(5)

    // Belegnummern lückenlos ab Startbeleg
    for (let i = 1; i < belege.length; i++) {
      expect(belege[i]!.belegNummer).toBe(belege[i - 1]!.belegNummer + 1)
    }

    // Echte Verkettung über die kompletten Beleg-Codes (Detailspezifikation)
    const kette = belege.map(b => ({
      maschinenlesbareCode: b.maschinenlesbareCode,
      sigVorbeleg:          b.sigVorbeleg,
    }))
    expect(pruefeKette('ITEST-001', kette)).toBe(true)
  })

  it('Nullbeleg lässt sich erstellen und verlängert die Kette', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/nullbeleg',
      headers: auth(), payload: { kasseId },
    })
    expect(res.statusCode).toBe(201)
    const nullbeleg = res.json() as BelegResponse
    expect(nullbeleg.gesamtbetragCent).toBe(0)

    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    const belege = (liste.json() as BelegResponse[])
      .sort((a, b) => a.belegNummer - b.belegNummer)
    expect(pruefeKette('ITEST-001', belege.map(b => ({
      maschinenlesbareCode: b.maschinenlesbareCode,
      sigVorbeleg:          b.sigVorbeleg,
    })))).toBe(true)
  })
})
