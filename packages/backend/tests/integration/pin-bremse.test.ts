/**
 * Integrationstest: PIN-Bremse (echtes PostgreSQL).
 *
 * Alle PIN-Prüfungen — PIN-Login, Stempeluhr, Freigabe-PIN — laufen unter
 * einer gemeinsamen Fehlversuchs-Sperre. Kernpunkte:
 *  - Sperre je Kasse für fremde Geräte, auch wenn der Angreifer die IP wechselt
 *    (unter Docker Desktop haben ohnehin alle LAN-Clients dieselbe)
 *  - PIN-Login und Stempeluhr teilen den Kassen-Topf (es sind dieselben PINs)
 *  - Geräte mit Merkmal (dort war schon jemand angemeldet) sperrt ein Fremder
 *    nicht aus; ein gefälschtes Merkmal zählt als fremd
 *  - Freigabe-PIN je anfragendem Benutzer — über ALLE Freigabe-Wege hinweg
 *  - Mandanten-Topf fängt Angriffe über mehrere Kassen
 *  - gleichzeitige Anfragen bekommen nicht mehr Versuche als erlaubt
 *  - jede Sperre steht im Audit-Log
 *  - PIN-Länge 6: alte 4-stellige PINs gelten nach der Umstellung nicht mehr
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { auditLogs, mandanten } from '../../src/db/schema.js'
import { pinBremse } from '../../src/services/pin-bremse.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'PB-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const ADMIN_EMAIL    = 'admin@pin-bremse.at'
const ADMIN_PASSWORT = 'pin-bremse-passwort-123'
const KARL_PIN  = '1234'   // Kellner
const BEA_PIN   = '5678'   // Kellnerin
const CHEF_PIN  = '9876'   // Chefin mit Freigabe-Recht
const FALSCH    = '0000'

describe('PIN-Bremse (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let adminToken: string
  let mandantId: string
  let kasse1: string
  let kasse2: string
  let kasse3: string
  let karlId: string
  let beaId: string

  /** Uhr der Bremse — Sperrablauf ohne Warten */
  let uhr = Date.now()

  /**
   * Jede Anfrage kommt von einer anderen Client-IP: die Bremse darf sich darauf
   * nicht verlassen — und das Login-Rate-Limit (10/min je IP) greift so nicht
   * vor ihr.
   */
  let ipZaehler = 0
  const neueIp = () => {
    ipZaehler++
    return `10.9.${Math.floor(ipZaehler / 250)}.${(ipZaehler % 250) + 1}`
  }

  const adminAuth = () => ({ authorization: `Bearer ${adminToken}` })
  const kellnerAuth = (sub: string) => ({
    authorization: `Bearer ${srv.signTestToken({
      sub, mandantId, rolle: 'kellner', name: 'Kellner', berechtigungen: ['kasse', 'tische', 'belege.stornieren'],
    })}`,
  })

  const pinLogin = (kasseId: string, pin: string, opts: { geraetToken?: string; ip?: string } = {}) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/auth/pin-login',
      headers: { 'x-real-ip': opts.ip ?? neueIp() },
      payload: { kasseId, pin, ...(opts.geraetToken ? { geraetToken: opts.geraetToken } : {}) },
    })

  const stempeln = (kasseId: string, pin: string, geraetToken?: string) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/zeiterfassung/stempeln',
      headers: { 'x-real-ip': neueIp() },
      payload: { kasseId, pin, ...(geraetToken ? { geraetToken } : {}) },
    })

  /** Gerät, an dem sich schon jemand angemeldet hat (hier: Admin per E-Mail) → Merkmal. */
  async function vertrautesGeraet(): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', headers: { 'x-real-ip': neueIp() },
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    expect(res.statusCode).toBe(200)
    const token = res.json().geraetToken as string
    expect(token).toBeTruthy()
    return token
  }

  /** Geräte-ID aus dem Merkmal lesen (nur für die Prüfung „dasselbe Gerät"). */
  const geraetIdAus = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')).g as string

  /** n falsche PIN-Logins an einer Kasse, liefert die Statuscodes */
  async function falscheLogins(kasseId: string, n: number, geraetToken?: string): Promise<number[]> {
    const codes: number[] = []
    for (let i = 0; i < n; i++) codes.push((await pinLogin(kasseId, FALSCH, geraetToken ? { geraetToken } : {})).statusCode)
    return codes
  }

  async function sperrEintraege() {
    return idb.db.select().from(auditLogs)
      .where(and(eq(auditLogs.mandantId, mandantId), eq(auditLogs.aktion, 'pin.gesperrt')))
      .orderBy(auditLogs.createdAt)
  }

  async function neuerBenutzer(name: string, pin: string, berechtigungen: string[]): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: adminAuth(),
      payload: { name, rolle: 'kellner', berechtigungen, kassenIds: [kasse1, kasse2, kasse3], pin },
    })
    if (res.statusCode !== 201) throw new Error(`Benutzer ${name} (${res.statusCode}): ${res.body}`)
    return res.json().id
  }

  async function neueKasse(kassenId: string): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: adminAuth(),
      payload: { kassenId, bezeichnung: kassenId, umgebung: 'test' },
    })
    if (res.statusCode !== 201) throw new Error(`Kasse ${kassenId} (${res.statusCode}): ${res.body}`)
    return res.json().kasseId
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'PIN-Bremse OG', uid: 'ATU99999951', kassenId: 'PB-001',
        finanzOnline: { teilnehmerId: 'TID-PB', benutzerkennung: 'BID-PB', pin: 'PIN-PB' },
        umgebung: 'test',
        admin: { name: 'PB Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup: ${setup.body}`)
    const login = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    if (login.statusCode !== 200) throw new Error(`Login: ${login.body}`)
    adminToken = login.json().token
    mandantId  = login.json().mandant.id
    kasse1     = login.json().kassen[0].id
    kasse2     = await neueKasse('PB-002')
    kasse3     = await neueKasse('PB-003')

    karlId = await neuerBenutzer('Karl Kellner', KARL_PIN, ['kasse', 'tische', 'belege.stornieren'])
    beaId  = await neuerBenutzer('Bea Kellnerin', BEA_PIN, ['kasse', 'tische', 'belege.stornieren'])
    await neuerBenutzer('Chefin', CHEF_PIN, ['kasse', 'freigabe'])

    await idb.db.update(mandanten).set({ modulZeiterfassungAktiv: true }).where(eq(mandanten.id, mandantId))
    pinBremse.jetzt = () => uhr
  })

  beforeEach(() => {
    pinBremse.zuruecksetzen()
    uhr = Date.now()
  })

  afterAll(async () => {
    pinBremse.jetzt = Date.now
    pinBremse.zuruecksetzen()
    await srv?.close()
    await idb?.zerstoeren()
  })

  // -------------------------------------------------------------------------
  // PIN-Login
  // -------------------------------------------------------------------------

  describe('PIN-Login', () => {
    it('sperrt die Kasse beim 8. Fehlversuch — trotz wechselnder IP, auch für die richtige PIN', async () => {
      expect(await falscheLogins(kasse1, 7)).toEqual(Array(7).fill(401))

      const achter = await pinLogin(kasse1, FALSCH)
      expect(achter.statusCode).toBe(429)
      expect(achter.json()).toMatchObject({ code: 'pin_gesperrt', wartenSekunden: 30 })
      expect(achter.json().fehler).toMatch(/PIN ungültig.*30 Sekunden/)
      expect(achter.headers['retry-after']).toBe('30')

      // Während der Sperre wird gar nicht geprüft — auch die richtige PIN nicht
      const richtig = await pinLogin(kasse1, KARL_PIN)
      expect(richtig.statusCode).toBe(429)
      expect(richtig.json().fehler).toMatch(/Zu viele falsche PIN-Eingaben/)

      uhr += 30_000
      const danach = await pinLogin(kasse1, KARL_PIN)
      expect(danach.statusCode).toBe(200)
      expect(danach.json().user.name).toBe('Karl Kellner')
    })

    it('ein Erfolg setzt den Zähler NICHT zurück (sonst leert die eigene PIN ihn)', async () => {
      await falscheLogins(kasse1, 7)
      expect((await pinLogin(kasse1, KARL_PIN)).statusCode).toBe(200)
      expect((await pinLogin(kasse1, FALSCH)).statusCode).toBe(429)   // 8. Fehlversuch
    })

    it('andere Kassen bleiben frei — die Stempeluhr der gesperrten Kasse ist mitgesperrt', async () => {
      await falscheLogins(kasse1, 8)
      expect((await pinLogin(kasse2, KARL_PIN)).statusCode).toBe(200)
      const stempel = await stempeln(kasse1, BEA_PIN)
      expect(stempel.statusCode).toBe(429)
      expect(stempel.json().code).toBe('pin_gesperrt')
    })

    it('die Sperre steht im Audit-Log — mit Kasse, Quelle, Stand und Client-IP', async () => {
      const vorher = (await sperrEintraege()).length
      await falscheLogins(kasse1, 7)
      await pinLogin(kasse1, FALSCH, { ip: '192.168.192.77' })
      const eintraege = await sperrEintraege()
      expect(eintraege).toHaveLength(vorher + 1)
      const e = eintraege.at(-1)!
      expect(e.ipAdresse).toBe('192.168.192.77')
      expect(e.details).toMatchObject({
        quelle: 'pin_login', bereich: 'kasse', kasseId: kasse1, fehlversuche: 8, sperreSekunden: 30,
      })
      // Abgewiesene Versuche während der Sperre schreiben KEINEN weiteren Eintrag
      await falscheLogins(kasse1, 5)
      expect(await sperrEintraege()).toHaveLength(vorher + 1)
    })

    it('gleichzeitige Fehlversuche: genau 8 werden geprüft, der Rest sofort abgewiesen', async () => {
      const antworten = await Promise.all(Array.from({ length: 30 }, () => pinLogin(kasse2, FALSCH)))
      const codes = antworten.map(a => a.statusCode)
      expect(codes.filter(c => c === 401)).toHaveLength(7)
      expect(codes.filter(c => c === 429)).toHaveLength(23)
      expect(pinBremse.stand({ art: 'kasse', id: kasse2 }).fehlversuche).toBe(8)
    })

    it('Mandanten-Topf: über drei Kassen verteilt sperren 20 Fehlversuche alle fremden Geräte', async () => {
      await falscheLogins(kasse1, 7)
      await falscheLogins(kasse2, 7)
      expect(await falscheLogins(kasse3, 5)).toEqual(Array(5).fill(401))
      const zwanzigster = await pinLogin(kasse3, FALSCH)
      expect(zwanzigster.statusCode).toBe(429)
      // Kasse 1 selbst ist nicht gesperrt — der Mandant schon
      expect((await pinLogin(kasse1, KARL_PIN)).statusCode).toBe(429)
      expect((await sperrEintraege()).at(-1)!.details).toMatchObject({ bereich: 'mandant', fehlversuche: 20 })
      // Ein vertrautes Gerät betrifft das nicht
      expect((await pinLogin(kasse1, KARL_PIN, { geraetToken: await vertrautesGeraet() })).statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // Geräte-Vertrauen
  // -------------------------------------------------------------------------

  describe('Geräte mit Merkmal', () => {
    it('kommen trotz Kassen-Sperre hinein und behalten beim Verlängern ihre Geräte-ID', async () => {
      const merkmal = await vertrautesGeraet()
      await falscheLogins(kasse1, 8)
      expect((await pinLogin(kasse1, KARL_PIN)).statusCode).toBe(429)

      const res = await pinLogin(kasse1, KARL_PIN, { geraetToken: merkmal })
      expect(res.statusCode).toBe(200)
      expect(geraetIdAus(res.json().geraetToken)).toBe(geraetIdAus(merkmal))
    })

    it('ein gefälschtes Merkmal oder ein Anmelde-JWT als Merkmal zählt als fremdes Gerät', async () => {
      await falscheLogins(kasse1, 8)
      const echt = await vertrautesGeraet()
      const [rumpf] = echt.split('.') as [string]
      const gefaelscht = `${rumpf}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
      expect((await pinLogin(kasse1, KARL_PIN, { geraetToken: gefaelscht })).statusCode).toBe(429)
      // Ein echt signierter Anmelde-JWT ist kein Merkmal
      const jwt = kellnerAuth(karlId).authorization.slice('Bearer '.length)
      expect(jwt.length).toBeLessThan(512)
      expect((await pinLogin(kasse1, KARL_PIN, { geraetToken: jwt })).statusCode).toBe(429)
      // Übergroße Werte weist schon das Schema ab
      expect((await pinLogin(kasse1, KARL_PIN, { geraetToken: 'x'.repeat(600) })).statusCode).toBe(400)
    })

    it('das Merkmal ist kein Anmelde-Token', async () => {
      const merkmal = await vertrautesGeraet()
      const me = await srv.fastify.inject({
        method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${merkmal}` },
      })
      expect(me.statusCode).toBe(401)
      expect(() => srv.fastify.jwt.verify(merkmal)).toThrow()
    })

    it('Fehlversuche eines vertrauten Geräts sperren nur dieses Gerät', async () => {
      const geraetA = await vertrautesGeraet()
      const geraetB = await vertrautesGeraet()
      expect(geraetIdAus(geraetA)).not.toBe(geraetIdAus(geraetB))

      expect(await falscheLogins(kasse1, 8, geraetA)).toEqual([...Array(7).fill(401), 429])
      expect((await pinLogin(kasse1, KARL_PIN, { geraetToken: geraetA })).statusCode).toBe(429)
      expect((await pinLogin(kasse1, KARL_PIN, { geraetToken: geraetB })).statusCode).toBe(200)
      expect((await pinLogin(kasse1, KARL_PIN)).statusCode).toBe(200)   // Kassen-Topf unberührt

      expect((await sperrEintraege()).at(-1)!.details).toMatchObject({
        bereich: 'geraet', geraetId: geraetIdAus(geraetA), quelle: 'pin_login',
      })
    })
  })

  // -------------------------------------------------------------------------
  // Stempeluhr
  // -------------------------------------------------------------------------

  describe('Stempeluhr', () => {
    it('sperrt nach 8 falschen PINs — abgewiesene Versuche werden gar nicht erst geprüft', async () => {
      const codes: number[] = []
      for (let i = 0; i < 20; i++) codes.push((await stempeln(kasse3, FALSCH)).statusCode)
      expect(codes).toEqual([...Array(7).fill(401), ...Array(13).fill(429)])
      expect(pinBremse.stand({ art: 'kasse', id: kasse3 }).fehlversuche).toBe(8)
      expect((await sperrEintraege()).at(-1)!.details).toMatchObject({ quelle: 'stempeln', bereich: 'kasse', kasseId: kasse3 })
    })

    it('ein Gerät mit Merkmal stempelt trotz Sperre', async () => {
      const merkmal = await vertrautesGeraet()
      for (let i = 0; i < 8; i++) await stempeln(kasse3, FALSCH)
      const ein = await stempeln(kasse3, BEA_PIN, merkmal)
      expect(ein.statusCode).toBe(200)
      expect(ein.json().userName).toBe('Bea Kellnerin')
      expect((await stempeln(kasse3, BEA_PIN, merkmal)).json().aktion).toBe('ausgestempelt')
    })

    it('eine PIN in der falschen Länge wird ohne Prüfung abgelehnt und zählt nicht', async () => {
      const res = await stempeln(kasse3, '123456')
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'pin_laenge', pinLaenge: 4 })
      expect(pinBremse.stand({ art: 'kasse', id: kasse3 }).fehlversuche).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Freigabe-PIN
  // -------------------------------------------------------------------------

  describe('Freigabe-PIN', () => {
    beforeAll(async () => {
      const res = await srv.fastify.inject({
        method: 'PATCH', url: '/api/mandanten/freigaben', headers: adminAuth(),
        payload: { stornoFreigabeAbCent: 5000, rabattFreigabeAbProzent: 20 },
      })
      expect(res.statusCode).toBe(200)
    })

    async function verkaufe(betragCent: number): Promise<string> {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung', headers: adminAuth(),
        payload: {
          kasseId: kasse1,
          positionen: [{ bezeichnung: 'Menü', preisBruttoCent: betragCent, mwstSatz: 'normal', menge: 1 }],
          zahlung: { barCent: betragCent, karteCent: 0, sonstigeCent: 0 },
        },
      })
      if (res.statusCode !== 201) throw new Error(`Verkauf (${res.statusCode}): ${res.body}`)
      return res.json().id
    }

    const storniere = (belegId: string, anfragerId: string, freigabePin: string) =>
      srv.fastify.inject({
        method: 'POST', url: '/api/belege/storno', headers: kellnerAuth(anfragerId),
        payload: { kasseId: kasse1, verweisBelegId: belegId, grund: 'Test', freigabePin },
      })

    const rabattBeleg = (anfragerId: string, freigabePin: string) =>
      srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung', headers: kellnerAuth(anfragerId),
        payload: {
          kasseId: kasse1,
          positionen: [{ bezeichnung: 'Menü', preisBruttoCent: 10000, mwstSatz: 'normal', menge: 1 }],
          zahlung: { barCent: 5000, karteCent: 0, sonstigeCent: 0 },
          rabatt: { typ: 'prozent', prozent: 50 },
          freigabePin,
        },
      })

    async function tischMit(betragCent: number, tisch: string): Promise<string> {
      const tab = (await srv.fastify.inject({
        method: 'POST', url: '/api/tisch-tabs', headers: adminAuth(),
        payload: { kasseId: kasse1, tischNummer: tisch, kellner: 'Karl' },
      })).json()
      const put = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tab.id}/positionen`, headers: adminAuth(),
        payload: { positionen: [{ artikelId: crypto.randomUUID(), bezeichnung: 'Menü', preisBruttoCent: betragCent, menge: 1 }] },
      })
      expect(put.statusCode).toBe(200)
      return tab.id
    }

    it('8 falsche Freigabe-PINs sperren den anfragenden Kellner — auch die richtige Chef-PIN', async () => {
      const beleg = await verkaufe(8000)
      for (let i = 0; i < 7; i++) {
        const r = await storniere(beleg, karlId, '1111')
        expect(r.statusCode).toBe(403)
        expect(r.json()).toMatchObject({ code: 'freigabe_erforderlich', fehler: 'Freigabe-PIN ist nicht gültig.' })
      }
      const achter = await storniere(beleg, karlId, '1111')
      expect(achter.statusCode).toBe(429)
      expect(achter.json()).toMatchObject({ code: 'pin_gesperrt', wartenSekunden: 30 })
      expect(achter.json().fehler).toMatch(/Freigabe-PIN ist nicht gültig\. Zu viele Fehlversuche/)
      expect((await storniere(beleg, karlId, CHEF_PIN)).statusCode).toBe(429)

      const e = (await sperrEintraege()).at(-1)!
      expect(e.userId).toBe(karlId)
      expect(e.details).toMatchObject({ quelle: 'freigabe', bereich: 'benutzer', kasseId: kasse1, fehlversuche: 8 })

      // Andere Kellner sind davon nicht betroffen
      expect((await storniere(beleg, beaId, CHEF_PIN)).statusCode).toBe(201)
    })

    it('alle Freigabe-Wege teilen die Sperre: Rabatt, Storno, Tisch-Korrektur, Tisch verwerfen', async () => {
      const belegeVorher = (await srv.fastify.inject({
        method: 'GET', url: `/api/belege?kasseId=${kasse1}&limit=500`, headers: adminAuth(),
      })).json().length

      // Gesperrt wird über den Rabatt-Weg …
      const codes: number[] = []
      for (let i = 0; i < 8; i++) codes.push((await rabattBeleg(karlId, '1111')).statusCode)
      expect(codes).toEqual([...Array(7).fill(403), 429])
      const belegeNachher = (await srv.fastify.inject({
        method: 'GET', url: `/api/belege?kasseId=${kasse1}&limit=500`, headers: adminAuth(),
      })).json().length
      expect(belegeNachher).toBe(belegeVorher)   // abgelehnt = kein Beleg

      // … und gilt auf allen anderen Wegen, auch mit der richtigen PIN
      expect((await rabattBeleg(karlId, CHEF_PIN)).statusCode).toBe(429)
      expect((await storniere(await verkaufe(9000), karlId, CHEF_PIN)).statusCode).toBe(429)
      const tabId = await tischMit(8000, 'PB1')
      const korrektur = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: kellnerAuth(karlId),
        payload: { positionen: [], freigabePin: CHEF_PIN },
      })
      expect(korrektur.statusCode).toBe(429)
      expect(korrektur.json().code).toBe('pin_gesperrt')
      const verwerfen = await srv.fastify.inject({
        method: 'POST', url: `/api/tisch-tabs/${tabId}/verwerfen`, headers: kellnerAuth(karlId),
        payload: { freigabePin: CHEF_PIN, grund: 'Test' },
      })
      expect(verwerfen.statusCode).toBe(429)

      // Nach Ablauf geht es wieder
      uhr += 30_000
      expect((await rabattBeleg(karlId, CHEF_PIN)).statusCode).toBe(201)
    })

    it('eine Freigabe-PIN in falscher Länge wird ohne Prüfung abgelehnt und zählt nicht', async () => {
      const res = await storniere(await verkaufe(7000), karlId, '12345')
      expect(res.statusCode).toBe(403)
      expect(res.json().fehler).toMatch(/4 Ziffern/)
      expect(pinBremse.stand({ art: 'benutzer', id: karlId }).fehlversuche).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // PIN-Länge 4 oder 6 (zuletzt — stellt den Mandanten um)
  // -------------------------------------------------------------------------

  describe('PIN-Länge je Betrieb', () => {
    it('pin-info nennt die Länge öffentlich (vor dem Login)', async () => {
      const res = await srv.fastify.inject({ method: 'GET', url: `/api/auth/pin-info?kasseId=${kasse1}` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ pinLaenge: 4 })
      const unbekannt = await srv.fastify.inject({ method: 'GET', url: `/api/auth/pin-info?kasseId=${crypto.randomUUID()}` })
      expect(unbekannt.statusCode).toBe(404)
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/auth/pin-info?kasseId=x' })).statusCode).toBe(400)
    })

    it('nur Admins stellen die PIN-Länge um', async () => {
      const res = await srv.fastify.inject({
        method: 'PATCH', url: '/api/mandanten/pin-laenge', headers: kellnerAuth(karlId),
        payload: { pinLaenge: 6 },
      })
      expect(res.statusCode).toBe(403)
    })

    it('Umstellung auf 6: alte PINs gelten nicht mehr, neue müssen 6 Ziffern haben', async () => {
      const stand = await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/pin-laenge', headers: adminAuth() })
      expect(stand.json()).toEqual({ pinLaenge: 4, pinsMit4: 3, pinsMit6: 0 })

      const um = await srv.fastify.inject({
        method: 'PATCH', url: '/api/mandanten/pin-laenge', headers: adminAuth(), payload: { pinLaenge: 6 },
      })
      expect(um.statusCode).toBe(200)
      expect(um.json()).toEqual({ pinLaenge: 6, pinsMit4: 3, pinsMit6: 0 })
      const audit = await idb.db.select().from(auditLogs)
        .where(and(eq(auditLogs.mandantId, mandantId), eq(auditLogs.aktion, 'einstellungen.geaendert')))
      expect(audit.at(-1)!.details).toMatchObject({ bereich: 'pin_laenge', vorher: 4, nachher: 6, ungueltigePins: 3 })

      expect((await srv.fastify.inject({ method: 'GET', url: `/api/auth/pin-info?kasseId=${kasse1}` })).json())
        .toEqual({ pinLaenge: 6 })

      // Alte 4-stellige PIN: 400 mit der gültigen Länge, ohne Prüfung und ohne Fehlversuch
      const alt = await pinLogin(kasse1, KARL_PIN)
      expect(alt.statusCode).toBe(400)
      expect(alt.json()).toMatchObject({ code: 'pin_laenge', pinLaenge: 6 })
      expect(pinBremse.stand({ art: 'kasse', id: kasse1 }).fehlversuche).toBe(0)
      expect((await stempeln(kasse1, KARL_PIN)).statusCode).toBe(400)

      // Neue PIN muss 6 Ziffern haben
      const zuKurz = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${karlId}`, headers: adminAuth(), payload: { pin: '4321' },
      })
      expect(zuKurz.statusCode).toBe(400)
      expect(zuKurz.json().fehler).toMatch(/6 Ziffern/)
      const neu = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${karlId}`, headers: adminAuth(), payload: { pin: '246813' },
      })
      expect(neu.statusCode).toBe(200)
      expect(neu.json()).toMatchObject({ hatPin: true, pinLaenge: 6 })

      const login = await pinLogin(kasse1, '246813')
      expect(login.statusCode).toBe(200)
      expect(login.json().mandant.pinLaenge).toBe(6)
      expect((await pinLogin(kasse1, '999999')).statusCode).toBe(401)   // falsch in richtiger Länge zählt
      expect(pinBremse.stand({ art: 'kasse', id: kasse1 }).fehlversuche).toBe(1)

      // Die Chefin hat noch die alte PIN → keine Freigabe damit
      const beleg = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung', headers: adminAuth(),
        payload: {
          kasseId: kasse1,
          positionen: [{ bezeichnung: 'Menü', preisBruttoCent: 9900, mwstSatz: 'normal', menge: 1 }],
          zahlung: { barCent: 9900, karteCent: 0, sonstigeCent: 0 },
        },
      })
      const storno = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/storno', headers: kellnerAuth(karlId),
        payload: { kasseId: kasse1, verweisBelegId: beleg.json().id, grund: 'Test', freigabePin: CHEF_PIN },
      })
      expect(storno.statusCode).toBe(403)
      expect(storno.json().fehler).toMatch(/6 Ziffern/)

      // Benutzerliste: wer noch eine alte PIN hat, sieht man an pinLaenge
      const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/users', headers: adminAuth() })).json() as
        { name: string; hatPin: boolean; pinLaenge: number }[]
      expect(liste.find(u => u.name === 'Bea Kellnerin')).toMatchObject({ hatPin: true, pinLaenge: 4 })
      expect(liste.find(u => u.name === 'Karl Kellner')).toMatchObject({ hatPin: true, pinLaenge: 6 })
    })
  })
})
