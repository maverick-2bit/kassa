/**
 * Integrationstest: Berichte (Umsatz / Artikel / Kassen-Vergleich) gegen echtes
 * PostgreSQL.
 *
 * Prüft die SQL-Aggregation über echte Belege: Umsatz-Summen + MwSt + Zahlart
 * inkl. Storno-Verrechnung, Artikel-Top-Liste, Multi-Kassen-Vergleich,
 * sowie Validierung (von>bis, unbekannte Kasse).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
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

  // -------------------------------------------------------------------------
  // Uhrzeit-Filter + Zielrechnungen (v0.7.138)
  // -------------------------------------------------------------------------

  it('Uhrzeit-Filter grenzt auf ein Tagesfenster ein', async () => {
    const heute = heuteWien()

    // Volles Fenster enthält alle Belege des Tages
    const ganz = await srv.fastify.inject({
      method: 'GET', headers: auth(),
      url: `/api/berichte/umsatz?kasseIds=${kasseId}&von=${heute}&bis=${heute}&zeitVon=00:00&zeitBis=23:59`,
    })
    expect(ganz.statusCode).toBe(200)
    expect(ganz.json().gesamt.anzahlBelege).toBeGreaterThan(0)

    // Fenster in der Vergangenheit (die Testbelege entstanden gerade eben)
    const leer = await srv.fastify.inject({
      method: 'GET', headers: auth(),
      url: `/api/berichte/umsatz?kasseIds=${kasseId}&von=${heute}&bis=${heute}&zeitVon=00:00&zeitBis=00:01`,
    })
    expect(leer.statusCode).toBe(200)
    expect(leer.json().gesamt.anzahlBelege).toBe(0)
    expect(leer.json().gesamt.umsatzCent).toBe(0)
  })

  it('Uhrzeit-Filter über Mitternacht (22:00–02:00) ist erlaubt', async () => {
    const heute = heuteWien()
    const res = await srv.fastify.inject({
      method: 'GET', headers: auth(),
      url: `/api/berichte/umsatz?kasseIds=${kasseId}&von=${heute}&bis=${heute}&zeitVon=22:00&zeitBis=02:00`,
    })
    expect(res.statusCode).toBe(200)   // kein 400 — Nachtfenster wird akzeptiert
  })

  it('Uhrzeit-Filter über Mitternacht hebt den Datumsfilter NICHT auf', async () => {
    // Regression: das OR des Nachtfensters muss geklammert sein. Ungeklammert
    // wird aus „(Mandant AND Kasse AND Datum) AND (a OR b)" ein
    // „(Mandant AND Kasse AND Datum) OR a OR b" — dann tauchen Belege fremder
    // Tage (und fremder Mandanten) im Bericht auf.
    const gestern = new Date(Date.now() - 86_400_000)
      .toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })

    // Zwei Nachtfenster, die praktisch den ganzen Tag abdecken. Ihre „toten
    // Minuten" (23:58–23:59 bzw. 12:00–12:01) überschneiden sich nicht, damit
    // der Test unabhängig von der Uhrzeit des Testlaufs greift.
    for (const [zeitVon, zeitBis] of [['23:59', '23:58'], ['12:01', '12:00']]) {
      const res = await srv.fastify.inject({
        method: 'GET', headers: auth(),
        url: `/api/berichte/umsatz?kasseIds=${kasseId}&von=${gestern}&bis=${gestern}&zeitVon=${zeitVon}&zeitBis=${zeitBis}`,
      })
      expect(res.statusCode).toBe(200)
      // Gestern wurde nichts gebucht — die heutigen Belege dürfen nicht durchschlagen
      expect(res.json().gesamt.anzahlBelege).toBe(0)
      expect(res.json().gesamt.umsatzCent).toBe(0)
      expect(res.json().zeilen).toEqual([])
    }
  })

  it('Zielrechnungen werden getrennt ausgewiesen (nicht über Sonstig-Zahlung)', async () => {
    const heute = heuteWien()

    // Basis: bisher keine Zielrechnung
    const vorher = (await umsatz(heute, heute)).json()
    expect(vorher.gesamt.anzahlZielrechnungen).toBe(0)
    expect(vorher.gesamt.zielCent).toBe(0)

    // Kunde + Verkauf auf offenen Posten (Zielrechnung)
    const kunde = (await srv.fastify.inject({
      method: 'POST', url: '/api/kunden', headers: auth(),
      payload: { firma: 'Ziel-Kunde GmbH', kreditAktiv: true },
    })).json()

    const beleg = (await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Auf Rechnung', preisBruttoCent: 5000, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 0, karteCent: 0, sonstigeCent: 5000 },
      },
    })).json()

    const op = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten', headers: auth(),
      payload: { kundeId: kunde.id, belegId: beleg.id, betragCent: 5000 },
    })
    expect(op.statusCode).toBe(201)

    const nachher = (await umsatz(heute, heute)).json()
    expect(nachher.gesamt.anzahlZielrechnungen).toBe(1)
    expect(nachher.gesamt.zielCent).toBe(5000)
    // Zielumsatz ist Teilmenge des Gesamtumsatzes, nicht zusätzlich
    expect(nachher.gesamt.umsatzCent).toBe(vorher.gesamt.umsatzCent + 5000)
    // Auch je Periodenzeile sichtbar
    expect(nachher.zeilen.some((z: { zielCent: number }) => z.zielCent === 5000)).toBe(true)

    // Filter „nur Zielrechnungen" liefert genau diesen einen Beleg
    const nurZiel = await srv.fastify.inject({
      method: 'GET', headers: auth(),
      url: `/api/berichte/umsatz?kasseIds=${kasseId}&von=${heute}&bis=${heute}&nurZielrechnungen=true`,
    })
    expect(nurZiel.json().gesamt.anzahlBelege).toBe(1)
    expect(nurZiel.json().gesamt.umsatzCent).toBe(5000)
  })

  it('Buchungsjournal-CSV liefert je Beleg eine Zeile mit Wiener Datum', async () => {
    // Bisher ungetestet, geht aber an den Steuerberater (DATEV/BMD). Seit
    // v0.7.142 formatiert ein wiederverwendeter Intl-Formatter das Datum
    // statt toLocaleDateString je Zeile — Ausgabe muss identisch bleiben.
    const heute = heuteWien()
    const res = await srv.fastify.inject({
      method: 'GET', headers: auth(),
      url: `/api/berichte/buchungsjournal?kasseIds=${kasseId}&von=${heute}&bis=${heute}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')

    const zeilen = res.body.replace(/^﻿/, '').split('\r\n')
    expect(zeilen[0]).toBe(
      'Datum;Belegnummer;Belegtyp;KassenID;Brutto;USt20%_Basis;USt20%;USt10%_Basis;USt10%;' +
      'USt13%_Basis;USt13%;Steuerfrei;Bar;Karte;Sonstige',
    )
    // Kopf + je Beleg/Storno eine Zeile
    expect(zeilen.length - 1).toBe(Number(res.headers['x-anzahl-belege']))
    expect(zeilen.length).toBeGreaterThan(1)

    const erwartetesDatum = new Date().toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })
    for (const zeile of zeilen.slice(1)) {
      expect(zeile.split(';')[0]).toBe(erwartetesDatum)
    }

    // Beträge im deutschen Format mit zwei Nachkommastellen
    const ersteZeile = zeilen[1]!.split(';')
    expect(ersteZeile[4]).toMatch(/^-?\d+,\d{2}$/)
  })

  // -------------------------------------------------------------------------
  // Tagesgrenzen des Datumsfilters (v0.7.141)
  // -------------------------------------------------------------------------

  it('Datumsfilter trifft die Wiener Tagesgrenzen exakt — auch am Zeitumstellungstag', async () => {
    // Der Filter vergleicht seit v0.7.141 die Spalte direkt gegen berechnete
    // Zeitpunkte (>= Tagesbeginn, < Folgetagsbeginn), statt sie mit
    // „AT TIME ZONE ...::date" umzurechnen — nur so kann Postgres den Index
    // nutzen. Diese Umstellung darf die Grenzen keinen Deut verschieben:
    // 00:00:00 gehört noch zum Tag, der Folgetag um 00:00:00 nicht mehr.
    // Als Datum bewusst der 30.03.2025 — an dem Tag springt Wien um 02:00 auf
    // Sommerzeit, der Tag hat also nur 23 Stunden.
    const beleg = (await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: barzahlung('Randfall', 100, 'normal', 'bar'),
    })).json() as BelegResponse

    const setzeBelegDatum = (wienerZeitpunkt: string) => idb.db.execute(sql`
      UPDATE belege
         SET beleg_datum = ${wienerZeitpunkt}::timestamp AT TIME ZONE 'Europe/Vienna'
       WHERE id = ${beleg.id}::uuid`)

    const belegeAm = async (tag: string) =>
      (await umsatz(tag, tag)).json().gesamt.anzahlBelege as number

    // Erste Sekunde des Tages zählt noch zum 30.03.
    await setzeBelegDatum('2025-03-30 00:00:00')
    expect(await belegeAm('2025-03-30')).toBe(1)
    expect(await belegeAm('2025-03-29')).toBe(0)

    // Letzte Sekunde ebenso — und schlägt nicht in den Folgetag durch.
    await setzeBelegDatum('2025-03-30 23:59:59')
    expect(await belegeAm('2025-03-30')).toBe(1)
    expect(await belegeAm('2025-03-31')).toBe(0)

    // Mitternacht des Folgetags gehört bereits zum 31.03.
    await setzeBelegDatum('2025-03-31 00:00:00')
    expect(await belegeAm('2025-03-30')).toBe(0)
    expect(await belegeAm('2025-03-31')).toBe(1)

    // Mehrtägiger Zeitraum schließt beide Randtage ein.
    expect((await umsatz('2025-03-29', '2025-03-31')).json().gesamt.anzahlBelege).toBe(1)
  })
})
