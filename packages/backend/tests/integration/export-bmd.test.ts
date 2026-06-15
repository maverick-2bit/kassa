/**
 * Integrationstest: BMD-Buchhaltungsexport gegen echtes PostgreSQL.
 *
 * Deckt die Lücke, die diesen Endpoint ursprünglich brechen liess:
 *  - der Filter muss die echten belegTyp-Werte 'Barzahlungsbeleg'/'Stornobeleg'
 *    treffen (frueher 'barzahlung'/'storno' -> leeres Ergebnis)
 *  - ein Storno muss im Export NEGATIV erscheinen, sodass Verkauf + Storno
 *    sich zu 0 saldieren (Buchungsjournal muss ausgeglichen sein)
 *  - Datumsbereich, Belegtyp-Ausschluss (Start/Null), MwSt-Aufteilung, Auth.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import type { FinanzOnlineClient } from '@kassa/rksv'

const ADMIN_EMAIL    = 'admin@bmd-export.at'
const ADMIN_PASSWORT = 'bmd-export-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'BMD-Export Test GmbH',
  uid:        'ATU99999902',
  kassenId:   'BMD-001',
  finanzOnline: { teilnehmerId: 'TID-BMD', benutzerkennung: 'BID-BMD', pin: 'PIN-BMD' },
  umgebung: 'test',
  admin: { name: 'BMD Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

/** Eine Barzahlung mit einer Position zum gegebenen Bruttopreis (20 % USt). */
function barzahlung(kasseId: string, preisBruttoCent: number) {
  return {
    kasseId,
    positionen: [{ bezeichnung: 'Testartikel', preisBruttoCent, mwstSatz: 'normal', menge: 1 }],
    zahlung: { barCent: preisBruttoCent, karteCent: 0, sonstigeCent: 0 },
  }
}

/** Zerlegt die CSV-Antwort (BOM + Header + \r\n-Datenzeilen) in Datenzeilen-Felder. */
function parseCsv(body: string): { header: string[]; zeilen: string[][] } {
  const ohneBom = body.replace(/^﻿/, '')
  const lines   = ohneBom.split('\r\n').filter(l => l.length > 0)
  const header  = lines[0]!.split(';')
  const zeilen  = lines.slice(1).map(l => l.split(';'))
  return { header, zeilen }
}

describe('BMD-Export (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const bmd  = (qs = '') =>
    srv.fastify.inject({ method: 'GET', url: `/api/export/bmd?kasseId=${kasseId}${qs}`, headers: auth() })

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
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert den Export ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/export/bmd?kasseId=${kasseId}` })
    expect(res.statusCode).toBe(401)
  })

  it('liefert 404 für eine fremde/unbekannte Kasse', async () => {
    const res = await srv.fastify.inject({
      method: 'GET',
      url: `/api/export/bmd?kasseId=11111111-1111-1111-1111-111111111111`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('exportiert eine Barzahlung mit korrekter MwSt-Aufteilung (20 %)', async () => {
    const post = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(), payload: barzahlung(kasseId, 1200),
    })
    expect(post.statusCode).toBe(201)

    const res = await bmd()
    expect(res.statusCode).toBe(200)
    // Der frühere Bug ('barzahlung' statt 'Barzahlungsbeleg') lieferte hier 0.
    expect(res.headers['x-anzahl-belege']).toBe('1')

    const { zeilen } = parseCsv(res.body)
    expect(zeilen).toHaveLength(1)

    // Spalten: Datum;Nr;Text;Brutto;Steuercode;Netto;MwSt;Konto;Gegenkonto
    const [, , text, brutto, steuercode, netto, mwst, konto, gegenkonto] = zeilen[0]!
    expect(text).toBe('Kassenbon #2')            // #1 = Startbeleg
    expect(brutto).toBe('12,00')
    expect(netto).toBe('10,00')                  // 1200 / 1.2
    expect(mwst).toBe('2,00')
    expect(steuercode).toBe('022')               // 20 %
    expect(konto).toBe('4000')                   // Erlöskonto 20 %
    expect(gegenkonto).toBe('2000')              // Kasse (bar)
  })

  it('exportiert ein Storno NEGATIV, sodass Verkauf + Storno sich zu 0 saldieren', async () => {
    // Original-Barzahlung holen und stornieren
    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    const original = (liste.json() as BelegResponse[]).find(b => b.belegTyp === 'Barzahlungsbeleg')!
    const storno = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(),
      payload: { kasseId, verweisBelegId: original.id, grund: 'BMD-Test' },
    })
    expect(storno.statusCode).toBe(201)

    const res = await bmd()
    expect(res.headers['x-anzahl-belege']).toBe('2')
    const { zeilen } = parseCsv(res.body)
    expect(zeilen).toHaveLength(2)

    const stornoZeile = zeilen.find(z => z[2]!.startsWith('Storno'))!
    expect(stornoZeile).toBeDefined()
    expect(stornoZeile[3]).toBe('-12,00')   // Brutto negativ
    expect(stornoZeile[5]).toBe('-10,00')   // Netto negativ
    expect(stornoZeile[6]).toBe('-2,00')    // MwSt negativ

    // Kernaussage: Summe aller Brutto-Beträge im Export = 0
    const summeBrutto = zeilen.reduce((acc, z) => acc + parseFloat(z[3]!.replace(',', '.')), 0)
    expect(summeBrutto).toBeCloseTo(0, 2)
  })

  it('schliesst Start- und Nullbelege aus dem Buchungsexport aus', async () => {
    const nb = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/nullbeleg', headers: auth(), payload: { kasseId },
    })
    expect(nb.statusCode).toBe(201)

    const res = await bmd()
    // weiterhin nur Barzahlung + Storno — Start-/Nullbeleg tauchen nicht auf
    expect(res.headers['x-anzahl-belege']).toBe('2')
  })

  it('respektiert den Datumsbereich (Vergangenheit -> leer)', async () => {
    const res = await bmd('&vonDatum=2020-01-01&bisDatum=2020-12-31')
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-anzahl-belege']).toBe('0')
    const { zeilen } = parseCsv(res.body)
    expect(zeilen).toHaveLength(0)
  })
})
