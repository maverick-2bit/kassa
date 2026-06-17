/**
 * Integrationstest: Berichte (Umsatz / Artikel / Kassen-Vergleich) gegen echtes
 * PostgreSQL.
 *
 * Prüft die SQL-Aggregation über echte Belege: Umsatz-Summen + MwSt + Zahlart
 * inkl. Storno-Verrechnung, Artikel-Top-Liste, Multi-Kassen-Vergleich,
 * sowie Validierung (von>bis, unbekannte Kasse).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { BerichtResponse, ArtikelBerichtResponse, KassenVergleichResponse, BelegResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@bericht.at'
const ADMIN_PASSWORT = 'bericht-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Bericht GmbH',
  uid:        'ATU99999913',
  kassenId:   'BR-001',
  finanzOnline: { teilnehmerId: 'TID-BR', benutzerkennung: 'BID-BR', pin: 'PIN-BR' },
  umgebung: 'test',
  admin: { name: 'BR Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

const heuteWien = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })

describe('Berichte (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  function barzahlung(bezeichnung: string, preisBruttoCent: number, mwstSatz: string, zahlart: 'bar' | 'karte') {
    return {
      kasseId,
      positionen: [{ bezeichnung, preisBruttoCent, mwstSatz, menge: 1 }],
      zahlung: {
        barCent:   zahlart === 'bar'   ? preisBruttoCent : 0,
        karteCent: zahlart === 'karte' ? preisBruttoCent : 0,
        sonstigeCent: 0,
      },
    }
  }

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

    // Kaffee 1200 (20%) bar | Tee 800 (10%) karte | Storno des Kaffee-Belegs
    const k = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(), payload: barzahlung('Kaffee', 1200, 'normal', 'bar'),
    })
    if (k.statusCode !== 201) throw new Error(`Kaffee (${k.statusCode}): ${k.body}`)
    const kaffeeBeleg = k.json() as BelegResponse

    const t = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(), payload: barzahlung('Tee', 800, 'ermaessigt1', 'karte'),
    })
    if (t.statusCode !== 201) throw new Error(`Tee (${t.statusCode}): ${t.body}`)

    const s = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(),
      payload: { kasseId, verweisBelegId: kaffeeBeleg.id, grund: 'Bericht-Test' },
    })
    if (s.statusCode !== 201) throw new Error(`Storno (${s.statusCode}): ${s.body}`)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  const umsatz = (von: string, bis: string, kasse = kasseId) =>
    srv.fastify.inject({ method: 'GET', url: `/api/berichte/umsatz?kasseIds=${kasse}&von=${von}&bis=${bis}`, headers: auth() })

  it('verweigert Berichte ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/berichte/umsatz?von=${heuteWien()}&bis=${heuteWien()}` })
    expect(res.statusCode).toBe(401)
  })

  it('Umsatzbericht aggregiert Belege/Stornos, Zahlarten und MwSt (mit Storno-Verrechnung)', async () => {
    const res = await umsatz(heuteWien(), heuteWien())
    expect(res.statusCode).toBe(200)
    const b = res.json() as BerichtResponse
    expect(b.gesamt.anzahlBelege).toBe(2)
    expect(b.gesamt.anzahlStornos).toBe(1)
    // Umsatz: 1200(bar) + 800(karte) - 1200(storno bar) = 800
    expect(b.gesamt.umsatzCent).toBe(800)
    expect(b.gesamt.barCent).toBe(0)     // 1200 - 1200
    expect(b.gesamt.karteCent).toBe(800)

    // 20%-Bucket auf 0 genettet -> fehlt; 10%-Bucket 800 vorhanden
    expect(b.gesamt.mwst.find(m => m.satzKey === 'normal')).toBeUndefined()
    const erm1 = b.gesamt.mwst.find(m => m.satzKey === 'ermaessigt1')
    expect(erm1?.bruttoCent).toBe(800)
    expect(erm1?.nettoCent).toBe(Math.round(800 / 1.1))
  })

  it('Artikelbericht listet verkaufte Artikel mit Umsatz', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/berichte/artikel?kasseIds=${kasseId}&von=${heuteWien()}&bis=${heuteWien()}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const b = res.json() as ArtikelBerichtResponse
    const tee = b.zeilen.find(z => z.bezeichnung === 'Tee')
    expect(tee).toBeDefined()
    expect(tee!.umsatzCent).toBe(800)
  })

  it('Kassen-Vergleich liefert eine Zeile je Kasse mit korrektem Umsatz', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/berichte/kassen-vergleich?von=${heuteWien()}&bis=${heuteWien()}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const b = res.json() as KassenVergleichResponse
    const zeile = b.zeilen.find(z => z.kasseId === kasseId)
    expect(zeile).toBeDefined()
    expect(zeile!.anzahlBelege).toBe(2)
    expect(zeile!.anzahlStornos).toBe(1)
    expect(zeile!.umsatzCent).toBe(800)
  })

  it('weist von > bis ab (400)', async () => {
    const res = await umsatz('2026-12-31', '2026-01-01')
    expect(res.statusCode).toBe(400)
  })

  it('weist eine unbekannte Kasse ab (404)', async () => {
    const res = await umsatz(heuteWien(), heuteWien(), '11111111-1111-1111-1111-111111111111')
    expect(res.statusCode).toBe(404)
  })
})
