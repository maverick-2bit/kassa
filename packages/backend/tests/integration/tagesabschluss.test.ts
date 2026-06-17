/**
 * Integrationstest: Tagesabschluss / Z-Bon gegen echtes PostgreSQL.
 *
 * Bisher GAR NICHT getestet — fiskalisch zentral. Prüft, dass die Tages-
 * aggregation korrekt rechnet: Anzahl Belege, Summen pro MwSt-Satz (brutto/
 * netto/USt), Aufteilung nach Zahlart, und korrekte Storno-Verrechnung.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { BelegResponse, Tagesabschluss } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@tagesabschluss.at'
const ADMIN_PASSWORT = 'tagesabschluss-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Tagesabschluss GmbH',
  uid:        'ATU99999906',
  kassenId:   'TA-001',
  finanzOnline: { teilnehmerId: 'TID-TA', benutzerkennung: 'BID-TA', pin: 'PIN-TA' },
  umgebung: 'test',
  admin: { name: 'TA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

/** Heutiges Datum in Wiener Ortszeit als YYYY-MM-DD (entspricht der Aggregationsgrenze). */
const heuteWien = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })

function barzahlung(
  kasseId: string,
  preisBruttoCent: number,
  mwstSatz: string,
  zahlart: 'bar' | 'karte',
) {
  return {
    kasseId,
    positionen: [{ bezeichnung: 'Artikel', preisBruttoCent, mwstSatz, menge: 1 }],
    zahlung: {
      barCent:      zahlart === 'bar'   ? preisBruttoCent : 0,
      karteCent:    zahlart === 'karte' ? preisBruttoCent : 0,
      sonstigeCent: 0,
    },
  }
}

describe('Tagesabschluss / Z-Bon (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const ta = (datum: string) =>
    srv.fastify.inject({ method: 'GET', url: `/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${datum}`, headers: auth() })

  beforeAll(async () => {
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

    // A: 1200 @ 20% bar | B: 550 @ 10% karte | dann A stornieren
    const a = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: barzahlung(kasseId, 1200, 'normal', 'bar'),
    })
    if (a.statusCode !== 201) throw new Error(`Barzahlung A (${a.statusCode}): ${a.body}`)
    const belegA = a.json() as BelegResponse

    const b = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: barzahlung(kasseId, 550, 'ermaessigt1', 'karte'),
    })
    if (b.statusCode !== 201) throw new Error(`Barzahlung B (${b.statusCode}): ${b.body}`)

    const storno = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(),
      payload: { kasseId, verweisBelegId: belegA.id, grund: 'TA-Test' },
    })
    if (storno.statusCode !== 201) throw new Error(`Storno (${storno.statusCode}): ${storno.body}`)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert den Tagesabschluss ohne Token (401)', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${heuteWien()}`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('zählt Barzahlungs- und Stornobelege des Tages korrekt', async () => {
    const res = await ta(heuteWien())
    expect(res.statusCode).toBe(200)
    const body = res.json() as Tagesabschluss
    expect(body.anzahlBarzahlungsbelege).toBe(2)
    expect(body.anzahlStornobelege).toBe(1)
  })

  it('verrechnet Storno korrekt in MwSt-Summen und Zahlarten', async () => {
    const body = (await ta(heuteWien())).json() as Tagesabschluss

    // 20%-Bucket (1200) wird durch Storno auf 0 genettet -> taucht NICHT auf
    const normal = body.mwst.find((m) => m.satzKey === 'normal')
    expect(normal).toBeUndefined()

    // 10%-Bucket: 550 brutto -> netto 500, USt 50
    const erm1 = body.mwst.find((m) => m.satzKey === 'ermaessigt1')
    expect(erm1).toBeDefined()
    expect(erm1!.bruttoCent).toBe(550)
    expect(erm1!.nettoCent).toBe(500)   // round(550 / 1.1)
    expect(erm1!.ustCent).toBe(50)

    // Zahlarten: A bar (1200) + Storno (-1200) = 0 bar; B karte = 550
    expect(body.barCent).toBe(0)
    expect(body.karteCent).toBe(550)
    expect(body.sonstigCent).toBe(0)

    // Gesamtumsatz = Summe der Buckets = 0 (normal) + 550 (erm1)
    expect(body.nettoUmsatzCent).toBe(550)
  })

  it('liefert für einen Tag ohne Belege einen leeren Abschluss', async () => {
    const body = (await ta('2020-01-01')).json() as Tagesabschluss
    expect(body.anzahlBarzahlungsbelege).toBe(0)
    expect(body.anzahlStornobelege).toBe(0)
    expect(body.nettoUmsatzCent).toBe(0)
    expect(body.mwst).toEqual([])
  })

  it('liefert 404 für eine fremde Kasse', async () => {
    const res = await srv.fastify.inject({
      method: 'GET',
      url: `/api/belege/tagesabschluss?kasseId=11111111-1111-1111-1111-111111111111&datum=${heuteWien()}`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(404)
  })
})
