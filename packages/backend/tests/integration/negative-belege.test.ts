/**
 * Integrationstest: negative Positionen (Pfand-Rückgabe „Becher retour", „Retourglas") und
 * Belege mit Gesamtsumme UNTER 0 (Retoure) — durch den ganzen Weg gegen echtes PostgreSQL:
 * Beleg-Anlage, RKSV-Signatur/Kette, Umsatzzähler, Belegliste/-ansicht, Tagesabschluss, DEP7/DEP131.
 *
 * Entscheidung (siehe Bericht): Eine Retoure ist ein normaler Barzahlungsbeleg mit negativen
 * Beträgen — wie ein Storno: der RKSV-Umsatzzähler sinkt, Bar/Karte-Anteile sind ≤ 0.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { pruefeKette, validiereDEP7, dep7AusJson, type DEP131Export, type FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const mockFoClient = (): FinanzOnlineClient => ({
  kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
  startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'NEG-PW' }),
  kasseAusserBetriebNehmen: vi.fn(),
} as unknown as FinanzOnlineClient)

describe('Negative Positionen und Belege unter 0 (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = ''
  let colaId = '', becherId = '', glasId = ''
  const auth = () => ({ authorization: `Bearer ${token}` })

  const barzahlung = (positionen: object[], zahlung: { barCent: number; karteCent?: number; sonstigeCent?: number }, extra: object = {}) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: { kasseId, positionen, zahlung: { karteCent: 0, sonstigeCent: 0, ...zahlung }, ...extra },
    })
  const umsatzzaehler = async () => (await idb.db.select({ z: kassen.umsatzzaehlerCent }).from(kassen).where(eq(kassen.id, kasseId)))[0]!.z

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const s = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Negativ GmbH', uid: 'ATU99999955', kassenId: 'NEG-001',
        finanzOnline: { teilnehmerId: 'TID-NEG', benutzerkennung: 'BID-NEG', pin: 'PIN-NEG' }, umgebung: 'test',
        admin: { name: 'Neg Admin', email: 'admin@negativ.at', passwort: 'negativ-passwort-123' },
      },
    })
    if (s.statusCode !== 201) throw new Error(`Setup (${s.statusCode}): ${s.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'admin@negativ.at', passwort: 'negativ-passwort-123' },
    })).json()
    token = login.token; kasseId = login.kassen[0].id

    const artikel = async (bezeichnung: string, preisBruttoCent: number, mwstSatz: string) => {
      const r = await srv.fastify.inject({ method: 'POST', url: '/api/artikel', headers: auth(), payload: { bezeichnung, preisBruttoCent, mwstSatz } })
      expect(r.statusCode, r.body).toBe(201)
      return r.json().id as string
    }
    colaId   = await artikel('Cola', 350, 'normal')
    becherId = await artikel('Becher retour', -200, 'null')
    glasId   = await artikel('Retourglas', -50, 'ermaessigt1')
  })
  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('Artikel mit negativem Preis lässt sich anlegen und ändern', async () => {
    const r = await srv.fastify.inject({ method: 'PUT', url: `/api/artikel/${becherId}`, headers: auth(), payload: { preisBruttoCent: -250 } })
    expect(r.statusCode).toBe(200)
    expect(r.json().preisBruttoCent).toBe(-250)
    await srv.fastify.inject({ method: 'PUT', url: `/api/artikel/${becherId}`, headers: auth(), payload: { preisBruttoCent: -200 } })
  })

  it('gemischter Bon: Verkauf + Pfand-Rückgabe, MwSt-Aufteilung je Satz (0 %, 10 %, 20 %)', async () => {
    const vorher = await umsatzzaehler()
    // 2 Cola (700, 20 %) + 2 Becher retour (-400, 0 %) + 1 Retourglas (-50, 10 %) = 250
    const res = await barzahlung(
      [{ artikelId: colaId, menge: 2 }, { artikelId: becherId, menge: 2 }, { artikelId: glasId, menge: 1 }],
      { barCent: 250 },
    )
    expect(res.statusCode, res.body).toBe(201)
    const b = res.json() as BelegResponse
    expect(b.gesamtbetragCent).toBe(250)
    expect(b.betraege).toMatchObject({ normal: 700, ermaessigt1: -50, null: -400 })
    expect(await umsatzzaehler()).toBe(vorher + 250n)
  })

  it('reiner Retoure-Bon (Gesamt < 0): bar zurück, signiert, Umsatzzähler sinkt', async () => {
    const vorher = await umsatzzaehler()
    const res = await barzahlung([{ artikelId: becherId, menge: 3 }], { barCent: -600 })
    expect(res.statusCode, res.body).toBe(201)
    const b = res.json() as BelegResponse
    expect(b.gesamtbetragCent).toBe(-600)
    expect(b.betraege.null).toBe(-600)
    expect(b.signaturwert).toBeTruthy()
    expect(b.maschinenlesbareCode).toContain('-6,00')
    expect(await umsatzzaehler()).toBe(vorher - 600n)

    // Belegliste liefert ihn mit negativen Zahlungsanteilen
    const liste = (await srv.fastify.inject({ method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth() })).json() as BelegResponse[]
    const gelesen = liste.find(x => x.id === b.id)!
    expect(gelesen.gesamtbetragCent).toBe(-600)
    expect(gelesen.positionen[0]).toMatchObject({ bezeichnung: 'Becher retour', einzelpreisBreutto: -200, menge: 3 })
  })

  it('Preis-Override der Kasse (einzelpreisBreuttoCent) darf negativ sein — so sendet die Kasse Artikelpositionen', async () => {
    const res = await barzahlung([{ artikelId: becherId, menge: 1, einzelpreisBreuttoCent: -200 }], { barCent: -200 })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().gesamtbetragCent).toBe(-200)
  })

  it('Rückzahlung auf Karte (Gesamt < 0) ist möglich; Vorzeichen der Anteile wird geprüft', async () => {
    const karte = await barzahlung([{ artikelId: glasId, menge: 2 }], { barCent: 0, karteCent: -100 })
    expect(karte.statusCode, karte.body).toBe(201)
    // positive Zahlung zu negativem Bon → abgelehnt, nichts gebucht
    const falsch = await barzahlung([{ artikelId: becherId, menge: 1 }], { barCent: 200 })
    expect(falsch.statusCode).toBe(400)
    // Summe stimmt nicht
    expect((await barzahlung([{ artikelId: becherId, menge: 1 }], { barCent: -100 })).statusCode).toBe(400)
    // gemischte Vorzeichen bei positivem Bon ebenso
    expect((await barzahlung([{ artikelId: colaId, menge: 1 }], { barCent: 450, karteCent: -100 })).statusCode).toBe(400)
  })

  it('Rabatt: nie auf Pfand-Rückgabe — Prozent nur auf Sätze mit positiver Summe, bei Summe ≤ 0 keiner', async () => {
    // 2 Cola (700) + 1 Becher retour (-200): 10 % auf die 20-%-Summe = 70 → 700 - 70 - 200 = 430
    const mix = await barzahlung(
      [{ artikelId: colaId, menge: 2 }, { artikelId: becherId, menge: 1 }], { barCent: 430 },
      { rabatt: { typ: 'prozent', prozent: 10 } },
    )
    expect(mix.statusCode, mix.body).toBe(201)
    expect(mix.json().gesamtbetragCent).toBe(430)
    // reine Retoure + Rabatt: es gibt keinen Rabatt, Betrag bleibt -200
    const retoure = await barzahlung([{ artikelId: becherId, menge: 1 }], { barCent: -200 }, { rabatt: { typ: 'prozent', prozent: 50 } })
    expect(retoure.statusCode, retoure.body).toBe(201)
    expect(retoure.json().gesamtbetragCent).toBe(-200)
    // fixer Rabatt wird auf die Belegsumme gedeckelt (700 → 0 statt negativ durch den Rabatt)
    const fix = await barzahlung([{ artikelId: colaId, menge: 2 }], { barCent: 0 }, { rabatt: { typ: 'betrag', betragCent: 5000 } })
    expect(fix.statusCode, fix.body).toBe(201)
    expect(fix.json().gesamtbetragCent).toBe(0)
  })

  it('Stornobeleg einer Retoure wird wieder positiv und verlängert die Kette', async () => {
    const retoure = (await barzahlung([{ artikelId: becherId, menge: 2 }], { barCent: -400 })).json() as BelegResponse
    const vorher = await umsatzzaehler()
    const st = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(), payload: { kasseId, verweisBelegId: retoure.id, grund: 'Test' },
    })
    expect(st.statusCode, st.body).toBe(201)
    expect(st.json().gesamtbetragCent).toBe(400)
    expect(await umsatzzaehler()).toBe(vorher + 400n)
  })

  it('Tagesabschluss summiert negative Belege mit (Bar-Summe sinkt)', async () => {
    const heute = new Date().toISOString().slice(0, 10)
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${heute}`, headers: auth() })
    expect(res.statusCode, res.body).toBe(200)
    const ta = res.json()
    const liste = (await srv.fastify.inject({ method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth() })).json() as BelegResponse[]
    const erwartet = liste.filter(b => b.belegTyp === 'Barzahlungsbeleg' || b.belegTyp === 'Stornobeleg').reduce((s, b) => s + b.gesamtbetragCent, 0)
    expect(ta.nettoUmsatzCent).toBe(erwartet)
    expect(ta.barCent + ta.karteCent + ta.sonstigCent).toBe(erwartet)
  })

  it('Signaturkette, DEP7 und DEP131 bleiben mit negativen Belegen gültig', async () => {
    const liste = (await srv.fastify.inject({ method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth() })).json() as BelegResponse[]
    const belege = liste.sort((a, b) => a.belegNummer - b.belegNummer)
    for (let i = 1; i < belege.length; i++) expect(belege[i]!.belegNummer).toBe(belege[i - 1]!.belegNummer + 1)
    expect(pruefeKette('NEG-001', belege.map(b => ({ maschinenlesbareCode: b.maschinenlesbareCode, sigVorbeleg: b.sigVorbeleg })))).toBe(true)

    const dep7 = await srv.fastify.inject({ method: 'GET', url: `/api/belege/dep7?kasseId=${kasseId}`, headers: auth() })
    expect(dep7.statusCode).toBe(200)
    const val = validiereDEP7(dep7AusJson(dep7.body))
    expect(val.gueltig).toBe(true)
    expect(val.anzahlBelege).toBe(belege.length)

    const dep131 = JSON.parse((await srv.fastify.inject({ method: 'GET', url: `/api/belege/dep131?kasseId=${kasseId}`, headers: auth() })).body) as DEP131Export
    expect(dep131.Belege).toHaveLength(belege.length)
    expect(dep131.Belege.some(b => b.MaschinenlesbareCode.includes('-6,00'))).toBe(true)
  })
})
