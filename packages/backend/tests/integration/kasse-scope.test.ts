/**
 * Integrationstest: kasseId aus dem Request gegen den Mandanten prüfen.
 *
 * Einige JWT-Routen übernahmen die kasseId aus Body/Query ungeprüft. Einen
 * zusammengesetzten FK (kasse_id, mandant_id) gibt es nicht — eine FREMDE,
 * existierende Kasse wurde gespeichert (Tischplan-Bereich/-Element, druck_log-
 * Eintrag im Drucker-Log der fremden Kasse), eine UNBEKANNTE endete als
 * FK-Verletzung → 500, bei den Druck-Routen erst NACHDEM schon gedruckt war.
 *
 * Erwartet: fremde und unbekannte kasseId → 404 'Kasse nicht gefunden', keine
 * neue Zeile, kein Druckauftrag. Die eigene Kasse funktioniert weiter.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import {
  artikel, drucker, druckLog, kassen, tischplanBereiche, tischplanElemente,
} from '../../src/db/schema.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SCOPE-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: number) {
  return {
    firmenname: `Kassen-Scope ${nr} GmbH`,
    uid:        `ATU9999992${nr}`,
    kassenId:   `SCOPE-00${nr}`,
    finanzOnline: {
      teilnehmerId:    `TID-SCOPE-${nr}`,
      benutzerkennung: `BID-SCOPE-${nr}`,
      pin:             `PIN-SCOPE-${nr}`,
    },
    umgebung: 'test',
    admin: {
      name:     `Admin ${nr}`,
      email:    `admin${nr}@kassen-scope.at`,
      passwort: 'kassen-scope-passwort-123',
    },
  }
}

/** Gültige UUID, zu der es keine Kasse gibt (→ vor dem Fix FK-Verletzung = 500) */
const UNBEKANNTE_KASSE = '00000000-0000-4000-8000-00000000abcd'

describe('kasseId gegen den Mandanten prüfen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA: string
  let mandantA: string, mandantB: string
  let kasseA: string, kasseB: string
  /** Zweite Kasse von Mandant A — für „Bereich gehört zu einer anderen eigenen Kasse" */
  let kasseA2: string
  let bereichA: string
  /** Bibliotheks-Drucker von A → Fake-Drucker */
  let druckerA: string
  let fakeDrucker: net.Server
  let verbindungen = 0

  let inventurId: string
  let lieferscheinId: string
  let sammelrechnungId: string

  const authA = () => ({ authorization: `Bearer ${tokenA}` })

  const anzahlZeilen = async (
    tabelle: typeof tischplanBereiche | typeof tischplanElemente | typeof druckLog,
  ): Promise<number> => (await idb.db.select({ id: tabelle.id }).from(tabelle)).length

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    for (const nr of [1, 2] as const) {
      const setupRes = await srv.fastify.inject({
        method: 'POST', url: '/api/setup', payload: setupInput(nr),
      })
      if (setupRes.statusCode !== 201) {
        throw new Error(`Setup ${nr} fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)
      }
      const loginRes = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@kassen-scope.at`, passwort: 'kassen-scope-passwort-123' },
      })
      if (loginRes.statusCode !== 200) {
        throw new Error(`Login ${nr} fehlgeschlagen (${loginRes.statusCode}): ${loginRes.body}`)
      }
      const login = loginRes.json()
      if (nr === 1) { tokenA = login.token; mandantA = login.mandant.id; kasseA = login.kassen[0].id }
      else          { mandantB = login.mandant.id; kasseB = login.kassen[0].id }
    }

    // Zweite Kasse von A — nur als Ziel für kasseId, signiert wird darauf nie
    const [zweite] = await idb.db.insert(kassen).values({
      mandantId:        mandantA,
      kassenId:         'SCOPE-001-B',
      seeZertifikatDer: 'test',
      seePrivateKeyEnc: 'test',
      seeZertifikatSn:  'test',
      seeGueltigBis:    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    }).returning()
    kasseA2 = zweite!.id

    const [bereich] = await idb.db.insert(tischplanBereiche)
      .values({ mandantId: mandantA, kasseId: kasseA, name: 'Gastraum' }).returning()
    bereichA = bereich!.id

    // Fake-Bondrucker: zählt jede TCP-Verbindung = jeden Druckversuch
    fakeDrucker = net.createServer((sock) => {
      verbindungen++
      sock.on('data', () => {})
    })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    const port = (fakeDrucker.address() as net.AddressInfo).port
    const [d] = await idb.db.insert(drucker).values({
      mandantId: mandantA, name: 'Büro-Bon', ip: '127.0.0.1', port,
    }).returning()
    druckerA = d!.id

    // Inventur braucht einen lagergeführten Artikel
    await idb.db.insert(artikel).values({
      mandantId: mandantA, bezeichnung: 'Bier vom Fass', preisBruttoCent: 450,
      mwstSatz: 'normal', lagerstandAktiv: true, lagerstandMenge: 40,
    })
    const inv = await srv.fastify.inject({
      method: 'POST', url: '/api/inventuren', headers: authA(), payload: {},
    })
    expect(inv.statusCode).toBe(201)
    inventurId = inv.json().id

    // Belegzweig: Angebot → zwei Lieferscheine, einer davon in eine Sammelrechnung
    const angebot = await srv.fastify.inject({
      method: 'POST', url: '/api/angebote', headers: authA(),
      payload: {
        kasseId: kasseA,
        positionen: [{ bezeichnung: 'Kaffeemaschine', menge: 1, einzelpreisBreutto: 49900, mwstSatz: 'normal' }],
      },
    })
    expect(angebot.statusCode).toBe(201)
    const neuerLieferschein = async (): Promise<string> => {
      const ls = await srv.fastify.inject({
        method: 'POST', url: '/api/lieferscheine', headers: authA(),
        payload: { angebotId: angebot.json().id },
      })
      expect(ls.statusCode).toBe(201)
      return ls.json().id
    }
    lieferscheinId = await neuerLieferschein()
    const sr = await srv.fastify.inject({
      method: 'POST', url: '/api/sammelrechnungen', headers: authA(),
      payload: { lieferscheinIds: [await neuerLieferschein()] },
    })
    expect(sr.statusCode).toBe(201)
    sammelrechnungId = sr.json().id
  })

  afterAll(async () => {
    if (fakeDrucker) await new Promise<void>((res) => fakeDrucker.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Voraussetzung: zwei Mandanten mit je eigener Kasse', () => {
    expect(kasseA).toBeTruthy()
    expect(kasseB).toBeTruthy()
    expect(kasseA).not.toBe(kasseB)
    expect(mandantA).not.toBe(mandantB)
  })

  // -------------------------------------------------------------------------
  // Tischplan
  // -------------------------------------------------------------------------

  describe('Tischplan-Bereich anlegen (POST /api/tischplan/bereiche)', () => {
    it.each([
      ['fremde',    () => kasseB],
      ['unbekannte', () => UNBEKANNTE_KASSE],
    ])('%s Kasse → 404, keine neue Zeile', async (_art, kasse) => {
      const vorher = await anzahlZeilen(tischplanBereiche)

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/tischplan/bereiche', headers: authA(),
        payload: { kasseId: kasse(), name: 'Fremdbereich' },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ fehler: 'Kasse nicht gefunden' })
      expect(await anzahlZeilen(tischplanBereiche)).toBe(vorher)
    })

    it('eigene Kasse → 201', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/tischplan/bereiche', headers: authA(),
        payload: { kasseId: kasseA, name: 'Terrasse' },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ kasseId: kasseA, name: 'Terrasse', elemente: [] })
      const [zeile] = await idb.db.select().from(tischplanBereiche)
        .where(eq(tischplanBereiche.id, res.json().id))
      expect(zeile).toMatchObject({ mandantId: mandantA, kasseId: kasseA })
    })
  })

  describe('Tischplan-Element anlegen (POST /api/tischplan/elemente)', () => {
    const element = (kasseId: string, bezeichnung: string) =>
      ({ kasseId, bereichId: bereichA, bezeichnung })

    it.each([
      ['fremde',    () => kasseB],
      ['unbekannte', () => UNBEKANNTE_KASSE],
    ])('%s Kasse → 404, keine neue Zeile', async (_art, kasse) => {
      const vorher = await anzahlZeilen(tischplanElemente)

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/tischplan/elemente', headers: authA(),
        payload: element(kasse(), 'X1'),
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ fehler: 'Kasse nicht gefunden' })
      expect(await anzahlZeilen(tischplanElemente)).toBe(vorher)
    })

    it('eigene Kasse, aber der Bereich gehört zu einer anderen → 404, keine neue Zeile', async () => {
      const vorher = await anzahlZeilen(tischplanElemente)

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/tischplan/elemente', headers: authA(),
        payload: element(kasseA2, 'X2'),
      })

      // Das Element wäre in keinem Tischplan aufgetaucht: listeBereiche liest
      // Bereiche und Elemente über dieselbe kasseId.
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ fehler: 'Bereich nicht gefunden' })
      expect(await anzahlZeilen(tischplanElemente)).toBe(vorher)
    })

    it('eigene Kasse → 201, Tisch erscheint im Tischplan der Kasse', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/tischplan/elemente', headers: authA(),
        payload: element(kasseA, 'T1'),
      })
      expect(res.statusCode).toBe(201)

      const plan = await srv.fastify.inject({
        method: 'GET', url: `/api/tischplan/bereiche?kasseId=${kasseA}`, headers: authA(),
      })
      expect(plan.statusCode).toBe(200)
      const gastraum = (plan.json() as Array<{ id: string; elemente: Array<{ bezeichnung: string }> }>)
        .find(b => b.id === bereichA)
      expect(gastraum?.elemente.map(e => e.bezeichnung)).toEqual(['T1'])
    })
  })

  it('GET /api/tischplan/bereiche mit kasseId ohne UUID-Format → 400 statt 500', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/tischplan/bereiche?kasseId=kein-uuid', headers: authA(),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ fehler: 'kasseId fehlt oder ist ungültig' })

    const ohne = await srv.fastify.inject({
      method: 'GET', url: '/api/tischplan/bereiche', headers: authA(),
    })
    expect(ohne.statusCode).toBe(400)
  })

  // -------------------------------------------------------------------------
  // Dokument-Ausgabe auf einen gewählten Bibliotheks-Drucker
  // -------------------------------------------------------------------------

  // Mit druckerId prüfte resolveZielDrucker die Kasse nicht — die Route
  // protokollierte danach unter body.kasseId im druck_log.
  const druckRouten = [
    { name: 'Inventur',       typ: 'inventur',     url: () => `/api/inventuren/${inventurId}/drucken`,             extra: {} },
    { name: 'Wareneingang',   typ: 'wareneingang', url: () => '/api/lagerstand/wareneingang-ausgabe',              extra: { positionen: [{ bezeichnung: 'Bier vom Fass', menge: 24 }] } },
    { name: 'Lieferschein',   typ: 'lieferschein', url: () => `/api/lieferscheine/${lieferscheinId}/drucken`,     extra: {} },
    { name: 'Sammelrechnung', typ: 'rechnung',     url: () => `/api/sammelrechnungen/${sammelrechnungId}/drucken`, extra: {} },
  ] as const

  describe.each(druckRouten)('$name drucken auf Bibliotheks-Drucker', ({ typ, url, extra }) => {
    it.each([
      ['fremde',    () => kasseB],
      ['unbekannte', () => UNBEKANNTE_KASSE],
    ])('%s Kasse → 404, kein Druck, kein druck_log-Eintrag', async (_art, kasse) => {
      const logVorher        = await anzahlZeilen(druckLog)
      const verbindungVorher = verbindungen

      const res = await srv.fastify.inject({
        method: 'POST', url: url(), headers: authA(),
        payload: { kasseId: kasse(), druckerId: druckerA, ...extra },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ fehler: 'Kasse nicht gefunden' })
      expect(verbindungen).toBe(verbindungVorher)
      expect(await anzahlZeilen(druckLog)).toBe(logVorher)
    })

    it('eigene Kasse → 200, druck_log-Eintrag unter der eigenen Kasse', async () => {
      const verbindungVorher = verbindungen

      const res = await srv.fastify.inject({
        method: 'POST', url: url(), headers: authA(),
        payload: { kasseId: kasseA, druckerId: druckerA, ...extra },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ erfolgreich: true })
      expect(verbindungen).toBe(verbindungVorher + 1)
      const eintraege = await idb.db.select().from(druckLog)
        .where(and(eq(druckLog.druckerTyp, typ), eq(druckLog.erfolg, true)))
      expect(eintraege).toHaveLength(1)
      expect(eintraege[0]).toMatchObject({ mandantId: mandantA, kasseId: kasseA })
    })
  })

  it('Drucker-Log der Kasse zeigt nur Einträge des eigenen Mandanten', async () => {
    // Altbestand aus der Zeit vor der Prüfung: Mandant B hat unter Kasse A protokolliert
    await idb.db.insert(druckLog).values({
      mandantId: mandantB, kasseId: kasseA,
      druckerIp: '10.99.99.99', druckerTyp: 'inventur', erfolg: true,
    })

    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseA}/drucker/log`, headers: authA(),
    })

    expect(res.statusCode).toBe(200)
    const ips = (res.json() as Array<{ druckerIp: string }>).map(e => e.druckerIp)
    expect(ips).not.toContain('10.99.99.99')
    expect(ips).toContain('127.0.0.1')   // die eigenen Ausgaben von oben
  })
})
