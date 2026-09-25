/**
 * Integrationstest: Änderungen an einem Tisch, der gerade bezahlt wird — gegen
 * echtes PostgreSQL.
 *
 * Bezahlen und „Rechnung teilen" sperren den Tab bis zum COMMIT (FOR UPDATE).
 * Positionen ändern, Verwerfen, Kellner/Tisch ändern, Gang abrufen und
 * Nachschicken lasen den Tab ohne Sperre, prüften „offen" und schrieben per
 * UPDATE … WHERE id = … — das wartete auf die Sperre und überschrieb danach den
 * schon bezahlten Tab (READ COMMITTED prüft nach dem Warten nur die id neu).
 * Folgen: Positionen auf einem bezahlten Tisch (nie kassiert), ein bezahlter Tab
 * „verworfen", Lager zurückgebucht und ein Korrekturbon an die Küche, obwohl ein
 * gültiger Beleg existiert.
 *
 * Erwartet: Wer nach dem Bezahlen an die Reihe kommt, bekommt 409 — der Tab
 * bleibt, wie er bezahlt wurde, und es läuft nichts nach (Lager, Verlauf, Audit,
 * Bon). Zwei Änderungen am offenen Tisch laufen nacheinander, die zweite gegen
 * den Stand der ersten (sonst: Storno ohne Freigabe, verlorene Nachbestellung).
 *
 * Rennen deterministisch wie in tisch-tab-bezahlen.test.ts: Der Test hält eine
 * Zeile gesperrt (die Kasse = eine gerade laufende Signierung) und schickt die
 * Anfragen nacheinander los, jede erst, wenn die vorige in der DB auf eine
 * Sperre wartet. Erst sein COMMIT lässt alle weiterlaufen.
 *
 * Ergebnisse werden als EIN Objekt verglichen — ein Fehlschlag zeigt alle
 * Symptome auf einmal.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import bcrypt from 'bcryptjs'
import { and, eq, sql } from 'drizzle-orm'
import type { BelegResponse, TabPosition } from '@kassa/shared'
import { pruefeKette, type FinanzOnlineClient } from '@kassa/rksv'
import { artikel, auditLogs, belege, bonierdrucker, kassen, tabEreignisse, tischTabs, users } from '../../src/db/schema.js'
import { pinBremse } from '../../src/services/pin-bremse.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@tab-sperre.at'
const ADMIN_PASSWORT = 'tab-sperre-passwort-123'
const KASSEN_ID      = 'SP-001'
const CHEF_PIN       = '1379'
const FALSCH         = '1111'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SP-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

interface Art { id: string; name: string; preis: number }
interface Zahlung { barCent: number; karteCent: number; sonstigeCent: number }

const bar   = (cent: number): Zahlung => ({ barCent: cent, karteCent: 0, sonstigeCent: 0 })
const karte = (cent: number): Zahlung => ({ barCent: 0, karteCent: cent, sonstigeCent: 0 })

const pos = (a: Art, menge: number, extra: Partial<TabPosition> = {}): TabPosition =>
  ({ artikelId: a.id, bezeichnung: a.name, preisBruttoCent: a.preis, menge, ...extra })

describe('Tisch-Änderungen gegen gleichzeitiges Bezahlen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let fakeDrucker: net.Server
  /** Jede TCP-Verbindung zum Bonierdrucker = ein Bon (Korrektur, Gang, Nachschicken) */
  let drucke = 0
  const SCHNITZEL: Art = { id: '', name: 'Schnitzel', preis: 1450 }
  const BIER:      Art = { id: '', name: 'Bier',      preis:  500 }
  const STEAK:     Art = { id: '', name: 'Steak',     preis: 8000 }

  const auth = () => ({ authorization: `Bearer ${token}` })

  // async: inject() schickt erst beim then() los — so läuft jede Anfrage sofort
  const anfrage = async (method: 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers: auth(), ...(payload !== undefined ? { payload: payload as object } : {}) })
  type Antwort = Awaited<ReturnType<typeof anfrage>>

  const bezahle = (tabId: string, cent: number) =>
    anfrage('POST', `/api/tisch-tabs/${tabId}/bezahlen`, { zahlung: bar(cent) })
  const splitte = (tabId: string, zahlungen: Array<{ positionen: TabPosition[]; zahlung: Zahlung }>) =>
    anfrage('POST', `/api/tisch-tabs/${tabId}/splitten`, { zahlungen })
  const setzePositionen = (tabId: string, positionen: TabPosition[], freigabePin?: string) =>
    anfrage('PUT', `/api/tisch-tabs/${tabId}/positionen`, { positionen, ...(freigabePin ? { freigabePin } : {}) })
  const verwerfe = (tabId: string, freigabePin?: string) =>
    anfrage('POST', `/api/tisch-tabs/${tabId}/verwerfen`, freigabePin ? { freigabePin } : {})
  const benenneUm = (tabId: string, kellner: string) =>
    anfrage('PATCH', `/api/tisch-tabs/${tabId}/kellner`, { kellner })
  const bucheUm = (tabId: string, tischNummer: string) =>
    anfrage('PATCH', `/api/tisch-tabs/${tabId}/tisch`, { tischNummer })
  const rufeGangAb = (tabId: string) =>
    anfrage('POST', `/api/tisch-tabs/${tabId}/gang-abrufen`)
  const schickeNach = (tabId: string, positionIndex: number) =>
    anfrage('POST', `/api/tisch-tabs/${tabId}/position-nachschicken`, { positionIndex })

  async function oeffneTab(tisch: string, positionen: TabPosition[]): Promise<string> {
    const r = await anfrage('POST', '/api/tisch-tabs', { kasseId, tischNummer: tisch, kellner: 'Anna' })
    if (r.statusCode !== 201) throw new Error(`Tab öffnen (${r.statusCode}): ${r.body}`)
    const tabId = r.json().id as string
    const upd = await setzePositionen(tabId, positionen)
    if (upd.statusCode !== 200) throw new Error(`Positionen (${upd.statusCode}): ${upd.body}`)
    return tabId
  }

  async function setzeStornoSchwelle(cent: number) {
    const res = await anfrage('PATCH', '/api/mandanten/freigaben', { stornoFreigabeAbCent: cent })
    expect(res.statusCode).toBe(200)
  }

  async function auditEintraege(aktion: string) {
    return idb.db.select().from(auditLogs).where(eq(auditLogs.aktion, aktion)).orderBy(auditLogs.createdAt)
  }

  /** Alles, was eine Tab-Änderung anfassen kann — vorher/nachher als EIN Objekt */
  async function stand(tabId: string) {
    const [tab] = await idb.db.select().from(tischTabs).where(eq(tischTabs.id, tabId))
    const lager = await idb.db.select({ name: artikel.bezeichnung, menge: artikel.lagerstandMenge }).from(artikel)
    const verlauf = await idb.db.select({ typ: tabEreignisse.typ }).from(tabEreignisse)
      .where(eq(tabEreignisse.tabId, tabId))
    const stornoAudit = await idb.db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.aktion, 'tab.position_storno'), sql`${auditLogs.details}->>'tabId' = ${tabId}`))
    const [b] = await idb.db.select({ n: sql<number>`count(*)::int` }).from(belege)
    return {
      status:      tab!.status,
      kellner:     tab!.kellner,
      tisch:       tab!.tischNummer,
      positionen:  tab!.positionen as TabPosition[],
      lager:       Object.fromEntries(lager.map(l => [l.name, l.menge])),
      verlauf:     verlauf.map(e => e.typ).sort(),
      stornoAudit: stornoAudit.length,
      belege:      b!.n,
      drucke,
    }
  }
  type Stand = Awaited<ReturnType<typeof stand>>

  /** Stand nach kurzer Ruhe — ein verspäteter Bon oder Lagerabzug käme sonst nicht mehr vor */
  async function standNachRuhe(tabId: string): Promise<Stand> {
    await new Promise(r => setTimeout(r, 150))
    return stand(tabId)
  }

  /** Was das Bezahlen am Stand ändert — und sonst nichts */
  const bezahlt = (s: Stand, belegeNeu = 1, ereignis = 'bezahlt'): Stand =>
    ({ ...s, status: 'bezahlt', belege: s.belege + belegeNeu, verlauf: [...s.verlauf, ereignis].sort() })

  async function belegIdAmTab(tabId: string): Promise<string | null> {
    const [t] = await idb.db.select({ belegId: tischTabs.belegId }).from(tischTabs).where(eq(tischTabs.id, tabId))
    return t?.belegId ?? null
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

  type Tx = Parameters<Parameters<IntegrationsDb['db']['transaction']>[0]>[0]

  /** Die Kasse gesperrt halten — wie eine gerade laufende Signierung */
  const kassenSperre = (tx: Tx) =>
    tx.select({ id: kassen.id }).from(kassen).where(eq(kassen.id, kasseId)).for('update')

  /**
   * Deterministisches Rennen: Der Test hält die Sperre und schickt die Anfragen
   * in dieser Reihenfolge los — jede erst, wenn die vorige in der DB auf eine
   * Sperre wartet. Erst sein COMMIT lässt alle weiterlaufen.
   */
  async function rennen(sperre: (tx: Tx) => Promise<unknown>, ...anfragen: Array<() => Promise<Antwort>>): Promise<Antwort[]> {
    const laufend: Promise<Antwort>[] = []
    await idb.db.transaction(async (tx) => {
      await sperre(tx)
      for (const a of anfragen) {
        laufend.push(a())
        await warteAufSperrWartende(laufend.length)
      }
    })
    return Promise.all(laufend)
  }

  /**
   * Hält jedes UPDATE auf tisch_tabs an, solange der Test die Zeile in
   * test_bremse gesperrt hat — die erste Änderung steckt dann mitten im
   * Schreiben fest, und die zweite kommt dazu.
   */
  async function mitBremse<T>(fn: (sperre: (tx: Tx) => Promise<unknown>) => Promise<T>): Promise<T> {
    await idb.db.execute(sql.raw('CREATE TABLE test_bremse (id int PRIMARY KEY)'))
    await idb.db.execute(sql.raw('INSERT INTO test_bremse VALUES (1)'))
    await idb.db.execute(sql.raw(`
      CREATE FUNCTION test_bremse_fn() RETURNS trigger AS $$
      BEGIN
        PERFORM 1 FROM test_bremse WHERE id = 1 FOR SHARE;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`))
    await idb.db.execute(sql.raw(
      'CREATE TRIGGER test_bremse_trg BEFORE UPDATE ON tisch_tabs FOR EACH ROW EXECUTE FUNCTION test_bremse_fn()'))
    try {
      return await fn((tx) => tx.execute(sql.raw('SELECT 1 FROM test_bremse WHERE id = 1 FOR UPDATE')))
    } finally {
      await idb.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_bremse_trg ON tisch_tabs'))
      await idb.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_bremse_fn()'))
      await idb.db.execute(sql.raw('DROP TABLE IF EXISTS test_bremse'))
    }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Tab-Sperre GmbH',
        uid:        'ATU99999909',
        kassenId:   KASSEN_ID,
        finanzOnline: { teilnehmerId: 'TID-SP', benutzerkennung: 'BID-SP', pin: 'PIN-SP' },
        umgebung: 'test',
        admin: { name: 'SP Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id
    const mandantId = login.mandant.id as string

    // Die Chefin gibt Stornos frei (Chef-PIN)
    await idb.db.update(users).set({ pinHash: bcrypt.hashSync(CHEF_PIN, 10) }).where(eq(users.email, ADMIN_EMAIL))

    // Fake-Bonierdrucker: zählt jeden Bon, der ankommt
    fakeDrucker = net.createServer((sock) => {
      drucke++
      sock.on('data', () => {})
      sock.on('error', () => {})
    })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    const port = (fakeDrucker.address() as net.AddressInfo).port
    const [d] = await idb.db.insert(bonierdrucker).values({
      mandantId, name: 'Küche (Fake)', ip: '127.0.0.1', port,
    }).returning()

    for (const a of [SCHNITZEL, BIER, STEAK]) {
      const [row] = await idb.db.insert(artikel).values({
        mandantId,
        bezeichnung:     a.name,
        preisBruttoCent: a.preis,
        mwstSatz:        'normal',
        bonierdruckerId: d!.id,
        lagerstandAktiv: true,
        lagerstandMenge: 100,
      }).returning()
      a.id = row!.id
    }
  })

  afterAll(async () => {
    pinBremse.jetzt = Date.now
    pinBremse.zuruecksetzen()
    await new Promise<void>((res) => fakeDrucker?.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Bezahlen läuft, dann kommt die Änderung ───────────────────────────────────

  it('Positionen ergänzen → 409: keine unbezahlte Position auf dem bezahlten Tisch, Lager unverändert', async () => {
    const tabId  = await oeffneTab('Sperre 1', [pos(SCHNITZEL, 2)])
    const vorher = await stand(tabId)

    const [zahlung, aenderung] = await rennen(kassenSperre,
      () => bezahle(tabId, 2 * SCHNITZEL.preis),
      () => setzePositionen(tabId, [pos(SCHNITZEL, 2), pos(BIER, 1)]),
    )
    expect({ bezahlen: zahlung!.statusCode, aenderung: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${zahlung!.body} | ${aenderung!.body}`)
      .toEqual({ bezahlen: 200, aenderung: 409, ...bezahlt(vorher) })
  })

  it('Positionen reduzieren (Storno) → 409: kein Korrekturbon an die Küche, kein Storno, Lager nicht zurückgebucht', async () => {
    const tabId  = await oeffneTab('Sperre 2', [pos(SCHNITZEL, 3)])
    const vorher = await stand(tabId)

    const [zahlung, aenderung] = await rennen(kassenSperre,
      () => bezahle(tabId, 3 * SCHNITZEL.preis),
      () => setzePositionen(tabId, [pos(SCHNITZEL, 1)]),
    )
    expect({ bezahlen: zahlung!.statusCode, aenderung: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${zahlung!.body} | ${aenderung!.body}`)
      .toEqual({ bezahlen: 200, aenderung: 409, ...bezahlt(vorher) })
  })

  it('Verwerfen → 409: Tab bleibt bezahlt mit seinem Beleg, kein Korrekturbon, Lager nicht zurückgebucht', async () => {
    const tabId  = await oeffneTab('Sperre 3', [pos(SCHNITZEL, 2)])
    const vorher = await stand(tabId)

    const [zahlung, aenderung] = await rennen(kassenSperre,
      () => bezahle(tabId, 2 * SCHNITZEL.preis),
      () => verwerfe(tabId),
    )
    expect({ bezahlen: zahlung!.statusCode, verwerfen: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${zahlung!.body} | ${aenderung!.body}`)
      .toEqual({ bezahlen: 200, verwerfen: 409, ...bezahlt(vorher) })
    expect(await belegIdAmTab(tabId)).toBe(zahlung!.json().belegId)
  })

  it('Kellner umbenennen → 409: der bezahlte Tab behält seinen Kellner', async () => {
    const tabId  = await oeffneTab('Sperre 4', [pos(BIER, 2)])
    const vorher = await stand(tabId)

    const [zahlung, aenderung] = await rennen(kassenSperre,
      () => bezahle(tabId, 2 * BIER.preis),
      () => benenneUm(tabId, 'Berta'),
    )
    expect({ bezahlen: zahlung!.statusCode, aenderung: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${zahlung!.body} | ${aenderung!.body}`)
      .toEqual({ bezahlen: 200, aenderung: 409, ...bezahlt(vorher) })
  })

  it('Tisch umbuchen → 409: der bezahlte Tab behält seine Tischnummer', async () => {
    const tabId  = await oeffneTab('Sperre 5', [pos(BIER, 2)])
    const vorher = await stand(tabId)

    const [zahlung, aenderung] = await rennen(kassenSperre,
      () => bezahle(tabId, 2 * BIER.preis),
      () => bucheUm(tabId, 'Sperre 5b'),
    )
    expect({ bezahlen: zahlung!.statusCode, aenderung: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${zahlung!.body} | ${aenderung!.body}`)
      .toEqual({ bezahlen: 200, aenderung: 409, ...bezahlt(vorher) })
  })

  it('Gang abrufen → 409: kein Gang-Bon, Positionen unverändert', async () => {
    const tabId  = await oeffneTab('Sperre 6', [pos(SCHNITZEL, 1, { gang: 1 }), pos(STEAK, 1, { gang: 2 })])
    const vorher = await stand(tabId)

    const [zahlung, aenderung] = await rennen(kassenSperre,
      () => bezahle(tabId, SCHNITZEL.preis + STEAK.preis),
      () => rufeGangAb(tabId),
    )
    expect({ bezahlen: zahlung!.statusCode, aenderung: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${zahlung!.body} | ${aenderung!.body}`)
      .toEqual({ bezahlen: 200, aenderung: 409, ...bezahlt(vorher) })
  })

  it('Position nachschicken → 409: kein Bon für einen geschlossenen Tisch', async () => {
    const tabId  = await oeffneTab('Sperre 7', [pos(SCHNITZEL, 1)])
    const vorher = await stand(tabId)

    const [zahlung, aenderung] = await rennen(kassenSperre,
      () => bezahle(tabId, SCHNITZEL.preis),
      () => schickeNach(tabId, 0),
    )
    expect({ bezahlen: zahlung!.statusCode, aenderung: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${zahlung!.body} | ${aenderung!.body}`)
      .toEqual({ bezahlen: 200, aenderung: 409, ...bezahlt(vorher) })

    // Auch ohne Rennen: ein bezahlter Tisch schickt nichts mehr an die Küche
    const spaeter = await schickeNach(tabId, 0)
    expect({ status: spaeter.statusCode, drucke }).toEqual({ status: 409, drucke: vorher.drucke })
  })

  it('„Rechnung teilen" läuft, dann Verwerfen → 409: beide Teilbelege gelten, Tab bleibt bezahlt', async () => {
    const tabId  = await oeffneTab('Sperre 8', [pos(BIER, 2)])
    const vorher = await stand(tabId)

    const [split, aenderung] = await rennen(kassenSperre,
      () => splitte(tabId, [
        { positionen: [pos(BIER, 1)], zahlung: bar(BIER.preis) },
        { positionen: [pos(BIER, 1)], zahlung: karte(BIER.preis) },
      ]),
      () => verwerfe(tabId),
    )
    expect({ split: split!.statusCode, verwerfen: aenderung!.statusCode, ...(await standNachRuhe(tabId)) },
      `${split!.body} | ${aenderung!.body}`)
      .toEqual({ split: 200, verwerfen: 409, ...bezahlt(vorher, 2, 'gesplittet') })
  })

  // ── Zwei Änderungen am offenen Tisch ──────────────────────────────────────────

  it('Zwei Positions-Änderungen gleichzeitig: die zweite rechnet gegen die erste — kein Storno an der Freigabe vorbei', async () => {
    await setzeStornoSchwelle(1000)
    try {
      const tabId  = await oeffneTab('Sperre 9', [pos(BIER, 1)])
      const vorher = await stand(tabId)

      const [kellnerApp, kasse] = await mitBremse(bremse => rennen(bremse,
        // Die Kellner-App bestellt ein Steak nach …
        () => setzePositionen(tabId, [pos(BIER, 1), pos(STEAK, 1)]),
        // … die Kasse kennt den Tisch noch ohne Steak und ergänzt ein Bier.
        () => setzePositionen(tabId, [pos(BIER, 2)]),
      ))
      // Gegen den gespeicherten Stand entfernt die Kasse das Steak (80 €, Schwelle
      // 10 €) — das braucht die Freigabe. Ohne Sperre rechnete sie gegen den alten
      // Stand: Steak still weg, kein Storno, kein PIN, Lager nicht zurückgebucht.
      expect({
        kellnerApp: kellnerApp!.statusCode,
        kasse:      kasse!.statusCode,
        code:       kasse!.json().code,
        ...(await standNachRuhe(tabId)),
      }, `${kellnerApp!.body} | ${kasse!.body}`).toEqual({
        kellnerApp: 200,
        kasse:      403,
        code:       'freigabe_erforderlich',
        ...vorher,
        positionen: [pos(BIER, 1), pos(STEAK, 1)],
        lager:      { ...vorher.lager, Steak: vorher.lager.Steak! - 1 },
        verlauf:    [...vorher.verlauf, 'positionen_aktualisiert'].sort(),
      })
    } finally {
      await setzeStornoSchwelle(0)
    }
  })

  it('Gang abrufen, während nachbestellt wird: die Nachbestellung bleibt am Tisch', async () => {
    const tabId  = await oeffneTab('Sperre 10', [pos(SCHNITZEL, 1, { gang: 1 })])
    const vorher = await stand(tabId)

    let gang!: Promise<Antwort>
    let nachbestellung!: Antwort
    await idb.db.transaction(async (tx) => {
      // Bonieren liest die Drucker-Sichtbarkeit der Kasse. Solange der Test die
      // Tabelle sperrt, steckt „Gang abrufen" beim Bonieren fest …
      await tx.execute(sql.raw('LOCK TABLE kasse_bonierdrucker_sichtbarkeit IN ACCESS EXCLUSIVE MODE'))
      gang = rufeGangAb(tabId)
      await warteAufSperrWartende(1)
      // … und die Kellner-App bestellt ein Bier dazu.
      nachbestellung = await setzePositionen(tabId, [pos(SCHNITZEL, 1, { gang: 1 }), pos(BIER, 1)])
    })
    const abruf   = await gang
    const nachher = await standNachRuhe(tabId)

    // Ohne Sperre schrieb „Gang abrufen" danach seine alte Positionsliste zurück:
    // das Bier war weg (nie kassiert), das Lager trotzdem abgezogen. (Den
    // Gang-Status setzt die Nachbestellung mit ihrer eigenen, älteren Liste
    // zurück — PUT ersetzt die ganze Liste; nicht Gegenstand dieses Tests.)
    expect({
      abruf:          abruf.statusCode,
      nachbestellung: nachbestellung.statusCode,
      bierAmTisch:    nachher.positionen.filter(p => p.artikelId === BIER.id).map(p => p.menge),
      lagerBier:      nachher.lager.Bier,
      gangBons:       nachher.drucke - vorher.drucke,
    }, `${abruf.body} | ${nachbestellung.body}`).toEqual({
      abruf:          200,
      nachbestellung: 200,
      bierAmTisch:    [1],
      lagerBier:      vorher.lager.Bier! - 1,
      gangBons:       1,
    })
  })

  it('Gang abrufen scheitert beim Bonieren (Artikel deaktiviert) → der Gang bleibt offen und lässt sich später abrufen', async () => {
    const tabId = await oeffneTab('Sperre 11', [pos(SCHNITZEL, 1, { gang: 1 })])

    await idb.db.update(artikel).set({ aktiv: false }).where(eq(artikel.id, SCHNITZEL.id))
    try {
      const res = await rufeGangAb(tabId)
      expect({ status: res.statusCode, gesendetAm: (await stand(tabId)).positionen[0]!.gesendetAm ?? null }, res.body)
        .toEqual({ status: 404, gesendetAm: null })
    } finally {
      await idb.db.update(artikel).set({ aktiv: true }).where(eq(artikel.id, SCHNITZEL.id))
    }

    const nochmal = await rufeGangAb(tabId)
    expect(nochmal.statusCode, nochmal.body).toBe(200)
    expect((await stand(tabId)).positionen[0]!.gesendetAm).toBeTruthy()
  })

  // ── Freigabe-PIN: die Sperre bleibt im Audit-Log ──────────────────────────────

  it('8 falsche Freigabe-PINs bei Tisch-Korrektur und beim Verwerfen: Sperre steht im Audit-Log, der Tab bleibt unverändert', async () => {
    await setzeStornoSchwelle(1000)
    pinBremse.zuruecksetzen()
    try {
      const tabId  = await oeffneTab('Sperre 12', [pos(STEAK, 1)])
      const vorher = await stand(tabId)
      const sperrenVorher = (await auditEintraege('pin.gesperrt')).length

      const korrektur: number[] = []
      for (let i = 0; i < 8; i++) korrektur.push((await setzePositionen(tabId, [], FALSCH)).statusCode)
      pinBremse.zuruecksetzen()   // eigene Runde fürs Verwerfen
      const verwerfen: number[] = []
      for (let i = 0; i < 8; i++) verwerfen.push((await verwerfe(tabId, FALSCH)).statusCode)

      const sperren = await auditEintraege('pin.gesperrt')
      expect({ korrektur, verwerfen, neueSperren: sperren.length - sperrenVorher, ...(await stand(tabId)) }).toEqual({
        korrektur:   [...Array(7).fill(403), 429],
        verwerfen:   [...Array(7).fill(403), 429],
        neueSperren: 2,
        ...vorher,
      })
      for (const s of sperren.slice(-2)) {
        expect(s.details).toMatchObject({ quelle: 'freigabe', kasseId, fehlversuche: 8 })
      }

      // Nach Ablauf der Sperre gibt die Chefin frei — der Storno geht durch
      pinBremse.jetzt = () => Date.now() + 30_000
      const frei = await setzePositionen(tabId, [], CHEF_PIN)
      expect(frei.statusCode, frei.body).toBe(200)
      expect((await stand(tabId)).positionen).toEqual([])
    } finally {
      pinBremse.jetzt = Date.now
      pinBremse.zuruecksetzen()
      await setzeStornoSchwelle(0)
    }
  })

  // ── RKSV: abgewiesene Änderungen hinterlassen keine Spuren in der Kette ───────

  it('Belegnummern lückenlos, Signaturkette gültig, Kassenstand = letzter Beleg', async () => {
    const r = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    const liste = (r.json() as BelegResponse[]).sort((a, b) => a.belegNummer - b.belegNummer)
    for (let i = 1; i < liste.length; i++) {
      expect(liste[i]!.belegNummer).toBe(liste[i - 1]!.belegNummer + 1)
    }
    expect(pruefeKette(KASSEN_ID, liste.map(b => ({
      maschinenlesbareCode: b.maschinenlesbareCode,
      sigVorbeleg:          b.sigVorbeleg,
    })))).toBe(true)
    const [k] = await idb.db.select({ nr: kassen.letzteBelegNummer, code: kassen.letzterBelegCode })
      .from(kassen).where(eq(kassen.id, kasseId))
    expect(k).toEqual({ nr: liste.at(-1)!.belegNummer, code: liste.at(-1)!.maschinenlesbareCode })
  })
})
