/**
 * Integrationstest: Tisch bezahlen (POST /api/tisch-tabs/:id/bezahlen) gegen
 * echtes PostgreSQL — Geld und RKSV.
 *
 * Bezahlen erzeugt EINEN signierten Beleg und schließt den Tab. Beides gehört
 * zusammen, und ein Tab wird genau einmal bezahlt:
 *  - doppelt abgeschickt (Doppelklick, Netz-Wiederholung): ein Beleg, die
 *    zweite Anfrage bekommt 409
 *  - Bezahlen und „Rechnung teilen" gleichzeitig: nur einer bucht
 *  - scheitert nach dem Beleg noch etwas (Tab schließen), rollt der Beleg mit
 *    zurück — Belegnummer, Umsatzzähler und Signaturkette bleiben stehen, die
 *    Wiederholung bucht genau einmal
 *  - Rabatt-Freigabe und Trinkgeld verhalten sich wie bisher; eine durch falsche
 *    Freigabe-PINs ausgelöste Sperre steht im Audit-Log, obwohl die Zahlung
 *    zurückgerollt wird
 *
 * Ergebnisse werden als EIN Objekt verglichen (HTTP-Status, neue Belege,
 * Tab-Status) — ein Fehlschlag zeigt so alle Symptome auf einmal.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { and, eq, sql } from 'drizzle-orm'
import type { BelegResponse } from '@kassa/shared'
import { pruefeKette, type FinanzOnlineClient } from '@kassa/rksv'
import { auditLogs, kassen, tabEreignisse, tischTabs, users } from '../../src/db/schema.js'
import { pinBremse } from '../../src/services/pin-bremse.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@bezahlen.at'
const ADMIN_PASSWORT = 'bezahlen-passwort-123'
const ADMIN_NAME     = 'BZ Admin'
const KASSEN_ID      = 'BZ-001'
const CHEF_PIN       = '1379'
const FALSCH         = '1111'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BZ-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Bezahlen GmbH',
  uid:        'ATU99999909',
  kassenId:   KASSEN_ID,
  finanzOnline: { teilnehmerId: 'TID-BZ', benutzerkennung: 'BID-BZ', pin: 'PIN-BZ' },
  umgebung: 'test',
  admin: { name: ADMIN_NAME, email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface TabPos { artikelId: string; bezeichnung: string; preisBruttoCent: number; menge: number }
interface TabResponse { id: string; status: string; positionen: TabPos[] }
interface Zahlung { barCent: number; karteCent: number; sonstigeCent: number }

const bar   = (cent: number): Zahlung => ({ barCent: cent, karteCent: 0, sonstigeCent: 0 })
const karte = (cent: number): Zahlung => ({ barCent: 0, karteCent: cent, sonstigeCent: 0 })

describe('Tisch bezahlen — genau einmal, alles oder nichts (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let bierId = ''       //  500 Cent
  let schnitzelId = ''  // 1490 Cent
  let steakId = ''      // 8000 Cent

  const auth = () => ({ authorization: `Bearer ${token}` })

  const pos = (artikelId: string, bezeichnung: string, preisBruttoCent: number, menge: number): TabPos =>
    ({ artikelId, bezeichnung, preisBruttoCent, menge })

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

  // async: inject() schickt erst beim then() los — so läuft jede Anfrage sofort
  const bezahle = async (tabId: string, body: Record<string, unknown>) =>
    srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/bezahlen`, headers: auth(), payload: body,
    })

  const splitte = async (tabId: string, zahlungen: Array<{ positionen: TabPos[]; zahlung: Zahlung }>) =>
    srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/splitten`, headers: auth(), payload: { zahlungen },
    })

  type Antwort = Awaited<ReturnType<typeof bezahle>>

  async function setzeSchwellen(input: { prozent?: number; cent?: number }) {
    const res = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/freigaben', headers: auth(),
      payload: { rabattFreigabeAbProzent: input.prozent ?? 0, rabattFreigabeAbCent: input.cent ?? 0 },
    })
    expect(res.statusCode).toBe(200)
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

  /** Beleg, den der Tab als „seinen" führt (die Antwort des Tabs enthält ihn nicht) */
  async function belegIdAmTab(tabId: string): Promise<string | null> {
    const [t] = await idb.db.select({ belegId: tischTabs.belegId }).from(tischTabs).where(eq(tischTabs.id, tabId))
    return t?.belegId ?? null
  }

  async function ereignisse(tabId: string, typ: string): Promise<number> {
    const rows = await idb.db.select({ id: tabEreignisse.id }).from(tabEreignisse)
      .where(and(eq(tabEreignisse.tabId, tabId), eq(tabEreignisse.typ, typ)))
    return rows.length
  }

  async function auditEintraege(aktion: string) {
    return idb.db.select().from(auditLogs).where(eq(auditLogs.aktion, aktion)).orderBy(auditLogs.createdAt)
  }

  /** RKSV-Stand der Kasse: darf sich durch eine abgewiesene Zahlung nicht bewegen */
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

  /**
   * Deterministisches Rennen: Der Test hält die Kassen-Zeile gesperrt — wie eine
   * gerade laufende Signierung — und schickt die Anfragen in dieser Reihenfolge
   * los, jede erst, wenn die vorige in der DB auf eine Sperre wartet. Erst sein
   * COMMIT lässt alle weiterlaufen. Ohne Tab-Sperre haben bis dahin alle den Tab
   * schon als „offen" gelesen.
   */
  async function rennen(...anfragen: Array<() => Promise<Antwort>>): Promise<Antwort[]> {
    const laufend: Promise<Antwort>[] = []
    await idb.db.transaction(async (sperre) => {
      await sperre.select({ id: kassen.id }).from(kassen).where(eq(kassen.id, kasseId)).for('update')
      for (const anfrage of anfragen) {
        laufend.push(anfrage())
        await warteAufSperrWartende(laufend.length)
      }
    })
    return Promise.all(laufend)
  }

  /** Zustand nach einem Bezahl-Versuch — als ein Objekt, damit ein Fehlschlag alles zeigt */
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

    // Der Admin gibt Rabatte frei (Chef-PIN) — und fragt sie auch an (Topf „benutzer")
    await idb.db.update(users).set({ pinHash: bcrypt.hashSync(CHEF_PIN, 10) }).where(eq(users.email, ADMIN_EMAIL))

    bierId      = await neuerArtikel('Bier', 500)
    schnitzelId = await neuerArtikel('Schnitzel', 1490)
    steakId     = await neuerArtikel('Steak', 8000)
  })

  afterAll(async () => {
    pinBremse.jetzt = Date.now
    pinBremse.zuruecksetzen()
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Genau einmal ──────────────────────────────────────────────────────────────

  it('Doppelt abgeschicktes Bezahlen (gleichzeitig) bucht nur einmal', async () => {
    const tabId = await oeffneTab('Bezahlen 1', [pos(bierId, 'Bier', 500, 2)])
    const vorher = (await alleBelege()).length

    const [a, b] = await rennen(
      () => bezahle(tabId, { zahlung: bar(1000) }),
      () => bezahle(tabId, { zahlung: bar(1000) }),
    )
    expect({
      status:            [a!.statusCode, b!.statusCode].sort(),
      neueBelege:        (await alleBelege()).length - vorher,
      tabStatus:         (await holeTab(tabId)).status,
      bezahltEreignisse: await ereignisse(tabId, 'bezahlt'),
    }, `${a!.body} | ${b!.body}`).toEqual({ status: [200, 409], neueBelege: 1, tabStatus: 'bezahlt', bezahltEreignisse: 1 })

    // Der Tab führt den Beleg der erfolgreichen Anfrage — nicht überschrieben
    const gewinner = [a!, b!].find(r => r.statusCode === 200)!
    expect(await belegIdAmTab(tabId)).toBe(gewinner.json().belegId)
  })

  it('Bezahlen, während „Rechnung teilen" schon läuft: nur der Split bucht', async () => {
    const tabId = await oeffneTab('Bezahlen 2', [pos(bierId, 'Bier', 500, 2)])
    const vorher = (await alleBelege()).length

    const [split, zahlung] = await rennen(
      () => splitte(tabId, [
        { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: bar(500) },
        { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: karte(500) },
      ]),
      () => bezahle(tabId, { zahlung: bar(1000) }),
    )
    expect({
      split:      split!.statusCode,
      bezahlen:   zahlung!.statusCode,
      neueBelege: (await alleBelege()).length - vorher,
      tabStatus:  (await holeTab(tabId)).status,
      belegIdAmTab: await belegIdAmTab(tabId),
    }, `${split!.body} | ${zahlung!.body}`).toEqual({
      split: 200, bezahlen: 409, neueBelege: 2, tabStatus: 'bezahlt', belegIdAmTab: null,
    })
  })

  it('„Rechnung teilen", während Bezahlen schon läuft: nur das Bezahlen bucht', async () => {
    const tabId = await oeffneTab('Bezahlen 3', [pos(bierId, 'Bier', 500, 2)])
    const vorher = (await alleBelege()).length

    const [zahlung, split] = await rennen(
      () => bezahle(tabId, { zahlung: bar(1000) }),
      () => splitte(tabId, [
        { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: bar(500) },
        { positionen: [pos(bierId, 'Bier', 500, 1)], zahlung: karte(500) },
      ]),
    )
    expect({
      bezahlen:   zahlung!.statusCode,
      split:      split!.statusCode,
      neueBelege: (await alleBelege()).length - vorher,
      tabStatus:  (await holeTab(tabId)).status,
    }, `${zahlung!.body} | ${split!.body}`).toEqual({ bezahlen: 200, split: 409, neueBelege: 1, tabStatus: 'bezahlt' })
    expect(await belegIdAmTab(tabId)).toBe(zahlung!.json().belegId)
  })

  // ── Alles oder nichts ─────────────────────────────────────────────────────────

  it('Scheitert nach dem Beleg das Schließen des Tabs, rollt der Beleg mit zurück — die Wiederholung bucht genau einmal', async () => {
    const tabId = await oeffneTab('Bezahlen 4', [pos(schnitzelId, 'Schnitzel', 1490, 1)])
    const vorher = (await alleBelege()).length
    const kasseVorher = await kassenStand()

    // Fehler-Injektion NACH dem signierten Beleg: das UPDATE, das den Tab schließt, scheitert
    await idb.db.execute(sql.raw(`
      CREATE FUNCTION test_tab_schliessen_fehler() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'bezahlt' THEN RAISE EXCEPTION 'Testfehler: Tab schliessen abgelehnt'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`))
    await idb.db.execute(sql.raw(
      'CREATE TRIGGER test_tab_schliessen_fehler BEFORE UPDATE ON tisch_tabs FOR EACH ROW EXECUTE FUNCTION test_tab_schliessen_fehler()'))
    try {
      const res = await bezahle(tabId, { zahlung: bar(1490) })
      expect(await zustand(res, tabId, vorher), res.body)
        .toEqual({ status: 500, neueBelege: 0, tabStatus: 'offen' })
      expect(await kassenStand()).toEqual(kasseVorher)
    } finally {
      await idb.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_tab_schliessen_fehler ON tisch_tabs'))
      await idb.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_tab_schliessen_fehler()'))
    }

    // Fehler behoben → dieselbe Zahlung geht durch, genau ein Beleg
    const nochmal = await bezahle(tabId, { zahlung: bar(1490) })
    expect(await zustand(nochmal, tabId, vorher), nochmal.body)
      .toEqual({ status: 200, neueBelege: 1, tabStatus: 'bezahlt' })
    expect(await ereignisse(tabId, 'bezahlt')).toBe(1)
  })

  // ── Rabatt, Freigabe, Trinkgeld wie bisher ────────────────────────────────────

  it('Trinkgeld und Positionsrabatt unter der Schwelle kommen unverändert auf den Beleg', async () => {
    await setzeSchwellen({ prozent: 20 })
    try {
      const tabId = await oeffneTab('Bezahlen 5', [pos(bierId, 'Bier', 500, 2)])
      const vorher = (await alleBelege()).length

      // 2 × 450 statt 500 = 10 % Nachlass (unter 20 %: kein PIN), 2 € Trinkgeld auf die Karte
      const res = await bezahle(tabId, {
        zahlung:         karte(900),
        positionRabatte: [{ positionIndex: 0, einzelpreisBreuttoCent: 450 }],
        trinkgeldCent:   200,
      })
      expect(await zustand(res, tabId, vorher), res.body)
        .toEqual({ status: 200, neueBelege: 1, tabStatus: 'bezahlt' })

      const beleg = await holeBeleg(res.json().belegId)
      expect(beleg.gesamtbetragCent).toBe(1100)
      expect(beleg.summeKarteCent).toBe(1100)
      expect(beleg.positionen).toEqual([
        expect.objectContaining({ bezeichnung: 'Bier', menge: 2, einzelpreisBreutto: 450 }),
        expect.objectContaining({ bezeichnung: 'Trinkgeld', menge: 1, einzelpreisBreutto: 200, mwstSatz: 'null' }),
      ])
    } finally {
      await setzeSchwellen({})
    }
  })

  it('8 falsche Freigabe-PINs beim Bezahlen sperren — die Sperre steht im Audit-Log, gebucht wird nichts', async () => {
    await setzeSchwellen({ prozent: 20 })
    pinBremse.zuruecksetzen()
    try {
      const tabId = await oeffneTab('Bezahlen 6', [pos(steakId, 'Steak', 8000, 1)])
      const vorher = (await alleBelege()).length
      const kasseVorher = await kassenStand()
      const sperrenVorher = (await auditEintraege('pin.gesperrt')).length

      // Steak 80 € → 40 € = 50 % Nachlass, Schwelle 20 % → Freigabe nötig
      const mitPin = (freigabePin: string) => bezahle(tabId, {
        zahlung:         bar(4000),
        positionRabatte: [{ positionIndex: 0, einzelpreisBreuttoCent: 4000 }],
        freigabePin,
      })

      const codes: number[] = []
      for (let i = 0; i < 8; i++) codes.push((await mitPin(FALSCH)).statusCode)
      expect(codes).toEqual([...Array(7).fill(403), 429])
      // Während der Sperre wird gar nicht geprüft — auch die richtige PIN nicht
      expect((await mitPin(CHEF_PIN)).statusCode).toBe(429)

      // Die Sperre ist protokolliert, obwohl die Zahlung zurückgerollt wurde
      const sperren = await auditEintraege('pin.gesperrt')
      expect(sperren).toHaveLength(sperrenVorher + 1)
      expect(sperren.at(-1)!.details).toMatchObject({
        quelle: 'freigabe', bereich: 'benutzer', kasseId, fehlversuche: 8,
      })
      expect({
        neueBelege: (await alleBelege()).length - vorher,
        tabStatus:  (await holeTab(tabId)).status,
        kasse:      await kassenStand(),
      }).toEqual({ neueBelege: 0, tabStatus: 'offen', kasse: kasseVorher })

      // Nach Ablauf der Sperre gibt die Chefin frei: genau ein Beleg, Freigabe protokolliert
      pinBremse.jetzt = () => Date.now() + 30_000
      const frei = await mitPin(CHEF_PIN)
      expect(await zustand(frei, tabId, vorher), frei.body)
        .toEqual({ status: 200, neueBelege: 1, tabStatus: 'bezahlt' })
      expect((await auditEintraege('rabatt.freigegeben')).at(-1)!.details)
        .toMatchObject({ nachlassCent: 4000, freigeberName: ADMIN_NAME })
    } finally {
      pinBremse.jetzt = Date.now
      pinBremse.zuruecksetzen()
      await setzeSchwellen({})
    }
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
