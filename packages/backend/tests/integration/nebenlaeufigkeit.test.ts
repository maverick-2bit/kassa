/**
 * Integrationstest: Nebenläufige Signierung gegen echtes PostgreSQL.
 *
 * Beweist, dass das `FOR UPDATE`-Lock in signiereImTx() gleichzeitige
 * Beleg-Requests korrekt serialisiert. Genau diese Bug-Klasse besteht alle
 * sequenziellen Tests und zerstört unter Last in Produktion die Signaturkette.
 *
 * Geprüft wird, was nur echte parallele DB-Transaktionen zeigen können:
 *  - Belegnummern bleiben lückenlos und eindeutig (kein doppelter Umsatzzähler)
 *  - kein verlorener Beleg / kein verlorener Betrag (kein Lost Update)
 *  - die RKSV-Signaturkette ist trotz Nebenläufigkeit kryptographisch konsistent
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { pruefeKette, type FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@nebenlaeufig.at'
const ADMIN_PASSWORT = 'nebenlaeufig-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'NL-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Nebenläufigkeit GmbH',
  uid:        'ATU99999902',
  kassenId:   'NL-001',
  finanzOnline: {
    teilnehmerId:    'TID-NL',
    benutzerkennung: 'BID-NL',
    pin:             'PIN-NL',
  },
  umgebung: 'test',
  admin: {
    name:     'NL Admin',
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

describe('Nebenläufige Signierung (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let startbelegNummer: number

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

    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}`, headers: auth(),
    })
    startbelegNummer = (liste.json() as BelegResponse[])[0]!.belegNummer
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('50 gleichzeitige Barzahlungen erzeugen eine lückenlose, konsistente Kette', async () => {
    const ANZAHL = 50
    // Eindeutige Beträge (1000, 1001, …) — damit ein Lost Update (zwei Belege
    // überschreiben sich) am fehlenden Betrag erkennbar wäre.
    const preise = Array.from({ length: ANZAHL }, (_, i) => 1000 + i)

    // ALLE Requests gleichzeitig abfeuern — echte Transaktions-Konkurrenz auf
    // dem Umsatzzähler-Row-Lock der Kasse.
    const responses = await Promise.all(
      preise.map(preis =>
        srv.fastify.inject({
          method: 'POST', url: '/api/belege/barzahlung',
          headers: auth(), payload: barzahlung(kasseId, preis),
        }),
      ),
    )

    // (1) Jeder Request war erfolgreich
    for (const res of responses) {
      expect(res.statusCode).toBe(201)
    }
    const belege = responses.map(r => r.json() as BelegResponse)

    // (2) Kein verlorener Betrag: die zurückgegebenen Beträge sind exakt die
    //     gesendeten (kein Lost Update überschrieb einen anderen Beleg)
    expect([...belege.map(b => b.gesamtbetragCent)].sort((a, b) => a - b))
      .toEqual([...preise].sort((a, b) => a - b))

    // (3) Belegnummern eindeutig (kein doppelter Umsatzzähler trotz Parallelität)
    const nummern = belege.map(b => b.belegNummer)
    expect(new Set(nummern).size).toBe(ANZAHL)

    // (4) Belegnummern lückenlos im Bereich [start+1 .. start+ANZAHL]
    const sortiert = [...nummern].sort((a, b) => a - b)
    expect(sortiert[0]).toBe(startbelegNummer + 1)
    expect(sortiert[ANZAHL - 1]).toBe(startbelegNummer + ANZAHL)
    for (let i = 1; i < sortiert.length; i++) {
      expect(sortiert[i]).toBe(sortiert[i - 1]! + 1)
    }
  })

  it('Signaturkette über alle Belege bleibt nach Nebenläufigkeit kryptographisch valide', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const belege = (res.json() as BelegResponse[])
      .sort((a, b) => a.belegNummer - b.belegNummer)

    // Startbeleg + 50 Barzahlungen
    expect(belege).toHaveLength(51)

    // Lückenlose Nummern über den gesamten Bestand
    for (let i = 1; i < belege.length; i++) {
      expect(belege[i]!.belegNummer).toBe(belege[i - 1]!.belegNummer + 1)
    }

    // Die Verkettung über die kompletten Beleg-Codes muss in der durch die
    // Belegnummer definierten Reihenfolge geschlossen sein — das beweist, dass
    // das Lock jeden Beleg an den korrekten Vorgänger gekettet hat.
    expect(pruefeKette('NL-001', belege.map(b => ({
      maschinenlesbareCode: b.maschinenlesbareCode,
      sigVorbeleg:          b.sigVorbeleg,
    })))).toBe(true)
  })
})
