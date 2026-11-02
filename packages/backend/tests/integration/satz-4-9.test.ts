/**
 * Integrationstest: Steuersatz 4,9 % (ausgewählte Nahrungsmittel, seit 1.7.2026) gegen echtes PostgreSQL.
 *
 * Rechtsgrundlage: RKSV Anlage 1 Z 4 (BGBl. II Nr. 134/2026): „Betrag-Satz-Besonders (19 %, 4,9 %)". Der QR-Code
 * hat weiterhin fünf Betragsfelder; 4,9 % teilt sich das Feld „Besonders" mit dem 19-%-Satz. Die Kassa führt beide
 * Sätze darüber hinaus GETRENNT — Belegzeilen, Bon, Tagesabschluss (Z-Bon), Umsatzbericht, Buchungsjournal, BMD-Export.
 * Die BMF-Auskunft zur Umsatzsteuer verweist ausdrücklich auf die Tages-/Monatsabschlüsse, nicht auf das RKSV-Protokoll.
 *
 * Der Test geht den ganzen Weg: Artikel mit 4,9 % anlegen → verkaufen (auch gemischt mit 19 %) → Beleg, QR-Code,
 * Selbsttest, Tagesabschluss, Berichte, Exporte → Storno → DEP131.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { verifiziereQrCode, type FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { belege, kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@satz-4-9.at'
const ADMIN_PASSWORT = 'satz-4-9-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'S49-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Satz 4,9 GmbH',
  uid:        'ATU99999912',
  kassenId:   'S49-001',
  finanzOnline: { teilnehmerId: 'TID-S49', benutzerkennung: 'BID-S49', pin: 'PIN-S49' },
  umgebung: 'test',
  admin: { name: 'S49 Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

const heuteWien = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })

/** Die fünf Betragsfelder des QR-Codes: Normal, Ermäßigt-1, Ermäßigt-2, Null, Besonders. */
function codeFelder(code: string): string[] {
  const teile = code.split('_')
  expect(teile).toHaveLength(14)
  return teile.slice(5, 10)
}

function parseCsv(body: string): { header: string[]; zeilen: string[][] } {
  const lines = body.replace(/^﻿/, '').split('\r\n').filter(l => l.length > 0)
  return { header: lines[0]!.split(';'), zeilen: lines.slice(1).map(l => l.split(';')) }
}

describe('Steuersatz 4,9 % (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  const artikelId = { semmel: '', schnitzel: '', sonder: '' }
  let beleg1: BelegResponse     // 3 × Semmel (4,9 %) + Schnitzel (10 %)
  let beleg2: BelegResponse     // Sondersteuersatz (19 %) + Semmel (4,9 %)

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = (url: string, payload: object) => srv.fastify.inject({ method: 'POST', url, headers: auth(), payload })
  const get  = (url: string) => srv.fastify.inject({ method: 'GET', url, headers: auth() })

  async function legeArtikelAn(bezeichnung: string, preisBruttoCent: number, mwstSatz: string): Promise<string> {
    const res = await post('/api/artikel', { bezeichnung, preisBruttoCent, mwstSatz })
    if (res.statusCode !== 201) throw new Error(`Artikel (${res.statusCode}): ${res.body}`)
    return res.json().id as string
  }

  async function verkaufe(positionen: { artikelId: string; menge: number }[], gesamtCent: number): Promise<BelegResponse> {
    const res = await post('/api/belege/barzahlung', {
      kasseId, positionen, zahlung: { barCent: gesamtCent, karteCent: 0, sonstigeCent: 0 },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as BelegResponse
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    artikelId.semmel    = await legeArtikelAn('Semmel',            60, 'ermaessigt3')
    artikelId.schnitzel = await legeArtikelAn('Schnitzel',       1690, 'ermaessigt1')
    artikelId.sonder    = await legeArtikelAn('Sondersatz-Ware',  777, 'besonders')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('der Artikel trägt den Satz 4,9 %; ein unbekannter Satz wird abgelehnt', async () => {
    const res = await get('/api/artikel')
    expect((res.json() as { bezeichnung: string; mwstSatz: string }[]).find(a => a.bezeichnung === 'Semmel')!.mwstSatz).toBe('ermaessigt3')
    const falsch = await post('/api/artikel', { bezeichnung: 'X', preisBruttoCent: 100, mwstSatz: 'ermaessigt4' })
    expect(falsch.statusCode).toBe(400)
  })

  it('Verkauf mit 4,9 % + 10 %: Beleg führt beide getrennt, der QR-Code trägt 4,9 % im Feld „Besonders"', async () => {
    beleg1 = await verkaufe([{ artikelId: artikelId.semmel, menge: 3 }, { artikelId: artikelId.schnitzel, menge: 1 }], 180 + 1690)
    expect(beleg1.betraege).toMatchObject({ ermaessigt3: 180, ermaessigt1: 1690, besonders: 0, normal: 0 })
    expect(beleg1.gesamtbetragCent).toBe(1870)
    expect(codeFelder(beleg1.maschinenlesbareCode)).toEqual(['0,00', '16,90', '0,00', '0,00', '1,80'])
    expect(verifiziereQrCode(beleg1.maschinenlesbareCode, await zertifikat())).toBe(true)
  })

  it('Verkauf mit 19 % und 4,9 %: ein Feld mit der Summe im Code, zwei getrennte Spalten in der Datenbank', async () => {
    beleg2 = await verkaufe([{ artikelId: artikelId.sonder, menge: 1 }, { artikelId: artikelId.semmel, menge: 1 }], 777 + 60)
    expect(beleg2.betraege).toMatchObject({ besonders: 777, ermaessigt3: 60 })
    expect(codeFelder(beleg2.maschinenlesbareCode)[4]).toBe('8,37')

    const [row] = await idb.db.select().from(belege).where(eq(belege.id, beleg2.id))
    expect(row).toMatchObject({ betragBesondersCent: 777, betragErmaessigt3Cent: 60 })
  })

  async function zertifikat(): Promise<Buffer> {
    const [k] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    return Buffer.from(k!.seeZertifikatDer, 'base64')
  }

  it('Signatur-Selbsttest: alle Belege gültig, auch die mit 4,9 %', async () => {
    const e = (await get(`/api/rksv/signatur-selbsttest?kasseId=${kasseId}`)).json()
    expect(e).toMatchObject({ geprueft: 3, gueltig: 3, ungueltig: 0, derAltformat: 0, zeitAltformat: 0, ketteOk: true })
  })

  it('Tagesabschluss (Z-Bon): 4,9 % und 19 % getrennt, jeweils mit eigener Netto/USt-Rechnung', async () => {
    const ta = (await get(`/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${heuteWien()}`)).json()
    expect(ta.nettoUmsatzCent).toBe(1870 + 837)
    const nach = Object.fromEntries((ta.mwst as { satzKey: string }[]).map(m => [m.satzKey, m]))
    expect(nach['ermaessigt3']).toMatchObject({ label: '4,9 % (Ermäßigt 3)', bruttoCent: 240, nettoCent: 229, ustCent: 11 })
    expect(nach['besonders']).toMatchObject({ bruttoCent: 777, nettoCent: 653, ustCent: 124 })
    expect(nach['ermaessigt1']).toMatchObject({ bruttoCent: 1690 })
  })

  it('Umsatzbericht: 4,9 % erscheint als eigene Steuerzeile', async () => {
    const heute = heuteWien()
    const b = (await get(`/api/berichte/umsatz?kasseIds=${kasseId}&von=${heute}&bis=${heute}`)).json()
    const z = (b.gesamt.mwst as { satzKey: string; bruttoCent: number; nettoCent: number; ustCent: number }[]).find(m => m.satzKey === 'ermaessigt3')
    expect(z).toMatchObject({ bruttoCent: 240, nettoCent: 229, ustCent: 11 })
    expect(b.gesamt.umsatzCent).toBe(2707)
  })

  it('Buchungsjournal (DATEV/BMD-kompatibel): neue Spalten HINTEN, bestehende unverändert', async () => {
    const heute = heuteWien()
    const res = await get(`/api/berichte/buchungsjournal?kasseIds=${kasseId}&von=${heute}&bis=${heute}`)
    expect(res.statusCode).toBe(200)
    const { header, zeilen } = parseCsv(res.body)
    expect(header.slice(0, 15)).toEqual([
      'Datum', 'Belegnummer', 'Belegtyp', 'KassenID', 'Brutto', 'USt20%_Basis', 'USt20%', 'USt10%_Basis', 'USt10%',
      'USt13%_Basis', 'USt13%', 'Steuerfrei', 'Bar', 'Karte', 'Sonstige',
    ])
    expect(header.slice(15)).toEqual(['USt4,9%_Basis', 'USt4,9%', 'USt19%_Basis', 'USt19%'])
    const z1 = zeilen.find(z => z[1] === String(beleg1.belegNummer))!
    expect(z1.slice(15)).toEqual(['1,80', '0,08', '0,00', '0,00'])       // 180 ct, USt 180 − 180/1,049 = 8,4 → 0,08
    const z2 = zeilen.find(z => z[1] === String(beleg2.belegNummer))!
    expect(z2.slice(15)).toEqual(['0,60', '0,03', '7,77', '1,24'])       // 4,9 % und 19 % getrennt
  })

  it('BMD-Export: eigene Zeile, eigenes Erlöskonto und eigener Steuercode für 4,9 %', async () => {
    const res = await get(`/api/export/bmd?kasseId=${kasseId}`)
    expect(res.statusCode).toBe(200)
    const { zeilen } = parseCsv(res.body)
    // Belegdatum;Belegnummer;Buchungstext;Brutto;Steuercode;Netto;MwSt;Konto;Gegenkonto
    const zeile = (nr: number, code: string) => zeilen.find(z => z[1] === String(nr) && z[4] === code)
    expect(zeile(beleg1.belegNummer, '049')).toMatchObject({ 3: '1,80', 5: '1,72', 6: '0,08', 7: '4049' })
    expect(zeile(beleg2.belegNummer, '049')).toMatchObject({ 3: '0,60', 7: '4049' })
    expect(zeile(beleg2.belegNummer, '019')).toMatchObject({ 3: '7,77', 5: '6,53', 6: '1,24', 7: '4019' })
    // Beleg 1 hat KEINE 19-%-Zeile, Beleg 2 keine 10-%-Zeile
    expect(zeile(beleg1.belegNummer, '019')).toBeUndefined()
    expect(zeile(beleg2.belegNummer, '011')).toBeUndefined()
  })

  it('Stornobeleg: 4,9 % negiert, Code mit negativer Summe, Berichte saldieren sich', async () => {
    const storno = await post('/api/belege/storno', { kasseId, verweisBelegId: beleg2.id, grund: 'Test 4,9 %' })
    expect(storno.statusCode, storno.body).toBe(201)
    const s = storno.json() as BelegResponse
    expect(s.betraege).toMatchObject({ besonders: -777, ermaessigt3: -60 })
    expect(codeFelder(s.maschinenlesbareCode)[4]).toBe('-8,37')

    const ta = (await get(`/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${heuteWien()}`)).json()
    const nach = Object.fromEntries((ta.mwst as { satzKey: string }[]).map(m => [m.satzKey, m]))
    expect(nach['ermaessigt3']).toMatchObject({ bruttoCent: 180 })          // 240 − 60
    expect(nach['besonders']).toBeUndefined()                                // 777 − 777 → keine Zeile
    expect(ta.nettoUmsatzCent).toBe(1870)

    const e = (await get(`/api/rksv/signatur-selbsttest?kasseId=${kasseId}`)).json()
    expect(e).toMatchObject({ geprueft: 4, gueltig: 4, ungueltig: 0, ketteOk: true })
  })

  it('DEP131 (§ 131 BAO) führt 4,9 % und 19 % getrennt, DEP7 trägt nur den Code', async () => {
    const dep = JSON.parse((await get(`/api/belege/dep131?kasseId=${kasseId}`)).body) as { Belege: { Belegnummer: number; Betraege: Record<string, number> }[] }
    const b1 = dep.Belege.find(b => b.Belegnummer === beleg1.belegNummer)!
    expect(b1.Betraege).toMatchObject({ Ermaessigt3Cent: 180, BesondersCent: 0, Ermaessigt1Cent: 1690 })
    const b2 = dep.Belege.find(b => b.Belegnummer === beleg2.belegNummer)!
    expect(b2.Betraege).toMatchObject({ Ermaessigt3Cent: 60, BesondersCent: 777 })

    const dep7 = (await get(`/api/belege/dep7?kasseId=${kasseId}`)).json() as { 'Belege-Gruppe': { 'Belege-kompakt': string[] }[] }
    const kompakt = dep7['Belege-Gruppe'].flatMap(g => g['Belege-kompakt'])
    const payload2 = Buffer.from(kompakt[beleg2.belegNummer - 1]!.split('.')[1]!, 'base64url').toString('utf8')
    expect(payload2.split('_')[9]).toBe('8,37')                              // die Summe, wie im QR-Code
  })

  it('der Beleg-Abruf liefert den Satz auch im Antwortfeld betraege.ermaessigt3', async () => {
    const liste = (await get(`/api/belege?kasseId=${kasseId}&limit=50`)).json() as BelegResponse[]
    expect(liste.find(b => b.id === beleg1.id)!.betraege.ermaessigt3).toBe(180)
  })
})
