/**
 * Integrationstest: Rechnung teilen (POST /api/tisch-tabs/:id/splitten) gegen
 * echtes PostgreSQL — Geld und RKSV.
 *
 * Der Split erzeugt je Zahler einen eigenen signierten Beleg. Er muss ALLES
 * ODER NICHTS buchen:
 *  - Teilbelege rechnen mit dem Preis der Tab-Position (inkl. Options-Aufpreis,
 *    Preis zum Bestellzeitpunkt) — genau wie „Bezahlen"
 *  - scheitert ein Zahler (falsche Summe, deaktivierter Artikel, Kasse außer
 *    Betrieb oder ein unerwarteter Fehler beim n-ten Teilbeleg), entsteht KEIN
 *    Beleg: der Tab bleibt offen, Belegnummer und Umsatzzähler bleiben stehen —
 *    ein erneuter Versuch bucht nichts doppelt
 *  - ein doppelt abgeschickter Split bucht nur einmal
 *  - die Aufteilung deckt den Tab exakt ab (nichts vergessen, nichts dazu)
 *
 * Fehlerfälle vergleichen den Zustand als EIN Objekt (HTTP-Status, neue Belege,
 * Tab-Status) — ein Fehlschlag zeigt so alle Symptome auf einmal.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { BelegResponse } from '@kassa/shared'
import { pruefeKette, type FinanzOnlineClient } from '@kassa/rksv'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@split.at'
const ADMIN_PASSWORT = 'split-passwort-123'
const KASSEN_ID      = 'SP-001'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SP-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Split GmbH',
  uid:        'ATU99999908',
  kassenId:   KASSEN_ID,
  finanzOnline: { teilnehmerId: 'TID-SP', benutzerkennung: 'BID-SP', pin: 'PIN-SP' },
  umgebung: 'test',
  admin: { name: 'SP Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface ModAuswahl {
  modifikatorId: string
  gruppeId:      string
  gruppeName:    string
  name:          string
  aufschlagCent: number
}
interface TabPos {
  artikelId:       string
  bezeichnung:     string
  preisBruttoCent: number
  menge:           number
  modifikatoren?:  ModAuswahl[]
}
interface TabResponse { id: string; status: string; positionen: TabPos[]; summeGesamtCent: number }
interface Zahlung { barCent: number; karteCent: number; sonstigeCent: number }

const bar   = (cent: number): Zahlung => ({ barCent: cent, karteCent: 0, sonstigeCent: 0 })
const karte = (cent: number): Zahlung => ({ barCent: 0, karteCent: cent, sonstigeCent: 0 })

describe('Rechnung teilen — alles oder nichts (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let bierId = ''       //  500 Cent
  let schnitzelId = ''  // 1490 Cent
  let burgerId = ''     //  990 Cent, Option „Pommes" +150
  let pommes: ModAuswahl

  const auth = () => ({ authorization: `Bearer ${token}` })

  const pos = (artikelId: string, bezeichnung: string, preisBruttoCent: number, menge: number, extra: Partial<TabPos> = {}): TabPos =>
    ({ artikelId, bezeichnung, preisBruttoCent, menge, ...extra })

  async function neuerArtikel(bezeichnung: string, preisBruttoCent: number): Promise<string> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung, preisBruttoCent, mwstSatz: 'normal' },
    })
    if (r.statusCode !== 201) throw new Error(`Artikel ${bezeichnung} (${r.statusCode}): ${r.body}`)
    return r.json().id
  }

  async function oeffneTab(tisch: string, positionen: TabPos[]): Promise<string> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/tisch-tabs', headers: auth(),
      payload: { kasseId, tischNummer: tisch, kellner: 'Anna' },
    })
    if (r.statusCode !== 201) throw new Error(`Tab öffnen (${r.statusCode}): ${r.body}`)
    const tabId = r.json().id as string
    const upd = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
      payload: { positionen },
    })
    if (upd.statusCode !== 200) throw new Error(`Positionen (${upd.statusCode}): ${upd.body}`)
    return tabId
  }

  function splitte(tabId: string, zahlungen: Array<{ positionen: TabPos[]; zahlung: Zahlung }>) {
    return srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/splitten`, headers: auth(),
      payload: { zahlungen },
    })
  }

  async function alleBelege(): Promise<BelegResponse[]> {
    const r = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    if (r.statusCode !== 200) throw new Error(`Belege (${r.statusCode}): ${r.body}`)
    return r.json() as BelegResponse[]
  }

  async function holeBeleg(id: string): Promise<BelegResponse> {
    const beleg = (await alleBelege()).find(b => b.id === id)
    if (!beleg) throw new Error(`Beleg ${id} nicht gefunden`)
    return beleg
  }

  async function holeTab(tabId: string): Promise<TabResponse> {
    const r = await srv.fastify.inject({ method: 'GET', url: `/api/tisch-tabs/${tabId}`, headers: auth() })
    if (r.statusCode !== 200) throw new Error(`Tab (${r.statusCode}): ${r.body}`)
    return r.json() as TabResponse
  }

  /** RKSV-Stand der Kasse: darf sich durch einen abgewiesenen Split nicht bewegen */
  async function kassenStand() {
    const [k] = await idb.db
      .select({
        letzteBelegNummer: kassen.letzteBelegNummer,
        umsatzzaehlerCent: kassen.umsatzzaehlerCent,
        letzterBelegCode:  kassen.letzterBelegCode,
      })
      .from(kassen)
      .where(eq(kassen.id, kasseId))
    return k
  }

  /** Wartet, bis n Verbindungen der Test-DB auf eine Sperre warten (Rennen herstellen). */
  async function warteAufSperrWartende(n: number): Promise<void> {
    const bis = Date.now() + 10_000
    while (Date.now() < bis) {
      const rows = await idb.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`)
      if ((rows[0]?.n ?? 0) >= n) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`Nach 10 s warten keine ${n} Anfragen auf eine Sperre`)
  }

  /** Zustand nach einem Split-Versuch — als ein Objekt, damit ein Fehlschlag alles zeigt */
  async function zustand(res: { statusCode: number }, tabId: string, belegeVorher: number) {
    return {
      status:     res.statusCode,
      neueBelege: (await alleBelege()).length - belegeVorher,
      tabStatus:  (await holeTab(tabId)).status,
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

    bierId      = await neuerArtikel('Bier', 500)
    schnitzelId = await neuerArtikel('Schnitzel', 1490)
    burgerId    = await neuerArtikel('Burger', 990)

    const g = await srv.fastify.inject({
      method: 'POST', url: '/api/modifikator-gruppen', headers: auth(),
      payload: { name: 'Beilage', typ: 'optional', reihenfolge: 0 },
    })
    if (g.statusCode !== 201) throw new Error(`Gruppe (${g.statusCode}): ${g.body}`)
    const o = await srv.fastify.inject({
      method: 'POST', url: `/api/modifikator-gruppen/${g.json().id}/modifikatoren`, headers: auth(),
      payload: { name: 'Pommes', aufschlagCent: 150 },
    })
    if (o.statusCode !== 201) throw new Error(`Option (${o.statusCode}): ${o.body}`)
    pommes = {
      modifikatorId: o.json().id, gruppeId: g.json().id, gruppeName: 'Beilage',
      name: 'Pommes', aufschlagCent: 150,
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Preise: Teilbelege rechnen wie „Bezahlen" mit dem Preis der Tab-Position ──

  it('Options-Aufpreis: Teilbeleg rechnet mit dem Tab-Preis inkl. Aufpreis', async () => {
    const burgerMitPommes = pos(burgerId, 'Burger', 1140, 1, { modifikatoren: [pommes] }) // 990 + 150
    const tabId = await oeffneTab('Split 1', [pos(bierId, 'Bier', 500, 2), burgerMitPommes])
    const vorher = (await alleBelege()).length

    const res = await splitte(tabId, [
      { positionen: [pos(bierId, 'Bier', 500, 1)],                  zahlung: bar(500) },
      { positionen: [pos(bierId, 'Bier', 500, 1), burgerMitPommes], zahlung: karte(1640) },
    ])
    expect(await zustand(res, tabId, vorher), res.body)
      .toEqual({ status: 200, neueBelege: 2, tabStatus: 'bezahlt' })

    const { belegIds } = res.json() as { belegIds: string[] }
    const zahler2 = await holeBeleg(belegIds[1]!)
    expect(zahler2.gesamtbetragCent).toBe(1640)
    expect(zahler2.summeKarteCent).toBe(1640)
    expect(zahler2.positionen).toContainEqual(expect.objectContaining({
      bezeichnung: 'Burger (Pommes)', menge: 1, einzelpreisBreutto: 1140,
    }))
  })

  it('Preisänderung nach dem Bestellen: Teilbelege nehmen den Preis zum Bestellzeitpunkt', async () => {
    const kaffeeId = await neuerArtikel('Kaffee', 300)
    const tabId = await oeffneTab('Split 2', [pos(kaffeeId, 'Kaffee', 300, 2)])
    const erhoeht = await srv.fastify.inject({
      method: 'PUT', url: `/api/artikel/${kaffeeId}`, headers: auth(), payload: { preisBruttoCent: 350 },
    })
    expect(erhoeht.statusCode).toBe(200)
    const vorher = (await alleBelege()).length

    const res = await splitte(tabId, [
      { positionen: [pos(kaffeeId, 'Kaffee', 300, 1)], zahlung: bar(300) },
      { positionen: [pos(kaffeeId, 'Kaffee', 300, 1)], zahlung: karte(300) },
    ])
    expect(await zustand(res, tabId, vorher), res.body)
      .toEqual({ status: 200, neueBelege: 2, tabStatus: 'bezahlt' })
    const { belegIds } = res.json() as { belegIds: string[] }
    for (const id of belegIds) expect((await holeBeleg(id)).gesamtbetragCent).toBe(300)
  })

  // ── Scheitern: kein halb bezahlter Tab ────────────────────────────────────────

  it('Zahler 2 mit falscher Summe: KEIN Teilbeleg, Tab bleibt offen, Wiederholung bucht genau einmal', async () => {
    const tabId = await oeffneTab('Split 3', [pos(bierId, 'Bier', 500, 2), pos(schnitzelId, 'Schnitzel', 1490, 1)])
    const vorher = (await alleBelege()).length
    const kasseVorher = await kassenStand()

    const falsch = await splitte(tabId, [
      { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: bar(500) },
      // 1990 fällig, 1890 kassiert
      { positionen: [pos(bierId, 'Bier', 500, 1), pos(schnitzelId, 'Schnitzel', 1490, 1)], zahlung: karte(1890) },
    ])
    expect(await zustand(falsch, tabId, vorher), falsch.body)
      .toEqual({ status: 400, neueBelege: 0, tabStatus: 'offen' })
    expect(await kassenStand()).toEqual(kasseVorher)

    const nochmal = await splitte(tabId, [
      { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: bar(500) },
      { positionen: [pos(bierId, 'Bier', 500, 1), pos(schnitzelId, 'Schnitzel', 1490, 1)], zahlung: karte(1990) },
    ])
    expect(await zustand(nochmal, tabId, vorher), nochmal.body)
      .toEqual({ status: 200, neueBelege: 2, tabStatus: 'bezahlt' })
  })

  it('Artikel inzwischen deaktiviert: KEIN Teilbeleg für die übrigen Zahler', async () => {
    const weinId = await neuerArtikel('Wein', 450)
    const tabId = await oeffneTab('Split 4', [pos(bierId, 'Bier', 500, 1), pos(weinId, 'Wein', 450, 1)])
    const deaktiviert = await srv.fastify.inject({ method: 'DELETE', url: `/api/artikel/${weinId}`, headers: auth() })
    expect(deaktiviert.statusCode).toBeLessThan(300)
    const vorher = (await alleBelege()).length

    const res = await splitte(tabId, [
      { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: bar(500) },
      { positionen: [pos(weinId, 'Wein', 450, 1)],  zahlung: karte(450) },
    ])
    expect(await zustand(res, tabId, vorher), res.body)
      .toEqual({ status: 409, neueBelege: 0, tabStatus: 'offen' })
    expect((res.json() as { fehler: string }).fehler).toMatch(/Wein/)
  })

  it('Kasse außer Betrieb: Split wird vor dem ersten Beleg abgewiesen', async () => {
    const tabId = await oeffneTab('Split 5', [pos(bierId, 'Bier', 500, 2)])
    const vorher = (await alleBelege()).length
    await idb.db.update(kassen).set({ status: 'ausser_betrieb' }).where(eq(kassen.id, kasseId))
    try {
      const res = await splitte(tabId, [
        { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: bar(500) },
        { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: karte(500) },
      ])
      expect(await zustand(res, tabId, vorher), res.body)
        .toEqual({ status: 409, neueBelege: 0, tabStatus: 'offen' })
    } finally {
      await idb.db.update(kassen).set({ status: 'aktiv' }).where(eq(kassen.id, kasseId))
    }
  })

  it('Unerwarteter Fehler beim 2. Teilbeleg rollt auch den 1. zurück (Zähler + Kette unverändert)', async () => {
    const spezialId = await neuerArtikel('Spezial', 4242)
    const tabId = await oeffneTab('Split 6', [pos(bierId, 'Bier', 500, 1), pos(spezialId, 'Spezial', 4242, 1)])
    const vorher = (await alleBelege()).length
    const kasseVorher = await kassenStand()
    const zahlungen = [
      { positionen: [pos(bierId, 'Bier', 500, 1)],          zahlung: bar(500) },
      { positionen: [pos(spezialId, 'Spezial', 4242, 1)],   zahlung: karte(4242) },
    ]

    // Fehler-Injektion: jeder Beleg-INSERT mit 42,42 € Kartenzahlung scheitert —
    // simuliert einen DB-Fehler MITTEN im Split, nachdem Zahler 1 schon signiert ist.
    await idb.db.execute(sql.raw(`
      CREATE FUNCTION test_beleg_fehler() RETURNS trigger AS $$
      BEGIN
        IF NEW.summe_karte_cent = 4242 THEN RAISE EXCEPTION 'Testfehler: Beleg-INSERT abgelehnt'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`))
    await idb.db.execute(sql.raw(
      'CREATE TRIGGER test_beleg_fehler BEFORE INSERT ON belege FOR EACH ROW EXECUTE FUNCTION test_beleg_fehler()'))
    try {
      const res = await splitte(tabId, zahlungen)
      expect(await zustand(res, tabId, vorher), res.body)
        .toEqual({ status: 500, neueBelege: 0, tabStatus: 'offen' })
      expect(await kassenStand()).toEqual(kasseVorher)
    } finally {
      await idb.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_beleg_fehler ON belege'))
      await idb.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_beleg_fehler()'))
    }

    // Fehler behoben → derselbe Split geht durch, genau zwei Teilbelege
    const nochmal = await splitte(tabId, zahlungen)
    expect(await zustand(nochmal, tabId, vorher), nochmal.body)
      .toEqual({ status: 200, neueBelege: 2, tabStatus: 'bezahlt' })
  })

  it('Doppelt abgeschickter Split (gleichzeitig) bucht nur einmal', async () => {
    const tabId = await oeffneTab('Split 7', [pos(bierId, 'Bier', 500, 2)])
    const vorher = (await alleBelege()).length
    const zahlungen = [
      { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: bar(500) },
      { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: karte(500) },
    ]

    // Deterministisches Rennen: der Test hält die Kassen-Zeile gesperrt, bis BEIDE
    // Anfragen in der DB auf eine Sperre warten — erst das COMMIT lässt sie los.
    // Ohne Sperre im Split hätten dann beide den Tab schon als „offen" gelesen.
    type Antwort = Awaited<ReturnType<typeof splitte>>
    let laufend!: Promise<[Antwort, Antwort]>
    await idb.db.transaction(async (sperre) => {
      await sperre.select({ id: kassen.id }).from(kassen).where(eq(kassen.id, kasseId)).for('update')
      laufend = Promise.all([splitte(tabId, zahlungen), splitte(tabId, zahlungen)])
      await warteAufSperrWartende(2)
    })
    const [a, b] = await laufend
    expect({
      status:     [a.statusCode, b.statusCode].sort(),
      neueBelege: (await alleBelege()).length - vorher,
      tabStatus:  (await holeTab(tabId)).status,
    }, `${a.body} | ${b.body}`).toEqual({ status: [200, 409], neueBelege: 2, tabStatus: 'bezahlt' })
  })

  // ── Aufteilung muss den Tab exakt abdecken ────────────────────────────────────

  it('Unvollständige Aufteilung (ein Bier fehlt) wird abgewiesen — kein Beleg', async () => {
    const tabId = await oeffneTab('Split 8', [pos(bierId, 'Bier', 500, 2), pos(schnitzelId, 'Schnitzel', 1490, 1)])
    const vorher = (await alleBelege()).length

    const res = await splitte(tabId, [
      { positionen: [pos(bierId, 'Bier', 500, 1)],             zahlung: bar(500) },
      { positionen: [pos(schnitzelId, 'Schnitzel', 1490, 1)],  zahlung: karte(1490) },
    ])
    expect(await zustand(res, tabId, vorher), res.body)
      .toEqual({ status: 400, neueBelege: 0, tabStatus: 'offen' })
  })

  it('Mehr aufgeteilt als am Tisch bestellt wird abgewiesen — kein Beleg', async () => {
    const tabId = await oeffneTab('Split 9', [pos(bierId, 'Bier', 500, 1), pos(schnitzelId, 'Schnitzel', 1490, 1)])
    const vorher = (await alleBelege()).length

    const res = await splitte(tabId, [
      { positionen: [pos(bierId, 'Bier', 500, 2)],             zahlung: bar(1000) },
      { positionen: [pos(schnitzelId, 'Schnitzel', 1490, 1)],  zahlung: karte(1490) },
    ])
    expect(await zustand(res, tabId, vorher), res.body)
      .toEqual({ status: 400, neueBelege: 0, tabStatus: 'offen' })
  })

  it('Position mit fremdem Preis (nicht am Tisch) wird abgewiesen — kein Beleg', async () => {
    const tabId = await oeffneTab('Split 10', [pos(bierId, 'Bier', 500, 2)])
    const vorher = (await alleBelege()).length

    const res = await splitte(tabId, [
      { positionen: [pos(bierId, 'Bier', 1, 1)],   zahlung: bar(1) },
      { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: karte(500) },
    ])
    expect(await zustand(res, tabId, vorher), res.body)
      .toEqual({ status: 400, neueBelege: 0, tabStatus: 'offen' })
  })

  // ── RKSV: abgewiesene Versuche hinterlassen keine Spuren in der Kette ─────────

  it('Belegnummern lückenlos, Signaturkette gültig, Kassenstand = letzter Beleg', async () => {
    const belege = (await alleBelege()).sort((a, b) => a.belegNummer - b.belegNummer)
    for (let i = 1; i < belege.length; i++) {
      expect(belege[i]!.belegNummer).toBe(belege[i - 1]!.belegNummer + 1)
    }
    expect(pruefeKette(KASSEN_ID, belege.map(b => ({
      maschinenlesbareCode: b.maschinenlesbareCode,
      sigVorbeleg:          b.sigVorbeleg,
    })))).toBe(true)
    const stand = await kassenStand()
    expect(stand?.letzteBelegNummer).toBe(belege.at(-1)!.belegNummer)
    expect(stand?.letzterBelegCode).toBe(belege.at(-1)!.maschinenlesbareCode)
  })
})
