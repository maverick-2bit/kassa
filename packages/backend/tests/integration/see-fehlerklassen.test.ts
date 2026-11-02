/**
 * Integrationstest: Fehlerklassen beim Signieren, Gegenprobe der frischen Signatur,
 * Uhr-Plausibilisierung und die Hintergrundsonde für die automatische Wiederherstellung.
 *
 * Bis v0.8.74 wurde JEDER Fehler beim Signieren zum automatischen SEE-Ausfall — auch ein falsches
 * A-Trust-Passwort (HTTP 401) oder eine Konfiguration, die nie funktionieren wird —, eine frisch
 * erzeugte Signatur wurde nie geprüft, und der Weg aus dem Ausfall war nur der Knopf im Banner.
 *
 * Ein lokaler A-Trust-Mock mit echtem ECDSA-Schlüssel und umschaltbarem Verhalten:
 *   - Netz weg / HTTP 5xx / unbrauchbare Antwort / Signatur mit fremdem Schlüssel → Ausfall (Beleg mit Marker)
 *   - HTTP 4xx → harter Fehler (409), KEIN Beleg, KEIN Ausfall
 *   - Sonde: Ausfall < 48 h und Einheit wieder da → Wiederherstellung von selbst
 *   - Uhr: Rücksprung bis 1 Minute → Zeit des Vorbelegs; größer → abgelehnt
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import {
  generateSEE,
  jwsSigningInput,
  signiereRoh,
  istAusfallBeleg,
  verifiziereQrCode,
  type FinanzOnlineClient,
  type SEEConfig,
} from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { auditLogs, belege, kassen } from '../../src/db/schema.js'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { pruefeSeeWiederherstellung, vergesseSondenZustand, SONDE_PAUSE_NACH_ABLEHNUNG_MS } from '../../src/services/see-sonde.service.js'

const ADMIN_EMAIL     = 'admin@seefehler.at'
const ADMIN_PASSWORT  = 'seefehler-passwort-123'
const ATRUST_BENUTZER = 'u123456789'
const ATRUST_PASSWORT = 'test-passwort'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:          vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SF-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(),
    seeAusfallMelden:              vi.fn().mockResolvedValue({ erfolgreich: true }),
    seeWiederinbetriebnahmeMelden: vi.fn().mockResolvedValue({ erfolgreich: true }),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'SEE Fehlerklassen GmbH',
  uid:        'ATU99999911',
  kassenId:   'SF-001',
  finanzOnline: { teilnehmerId: 'TID-SF', benutzerkennung: 'BID-SF', pin: 'PIN-SF' },
  umgebung: 'test',
  admin: { name: 'SF Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

type Modus = 'ok' | 'http401' | 'http404' | 'http503' | 'http429' | 'muell' | 'fremd' | 'leer'

describe('SEE: Fehlerklassen, Gegenprobe, Uhr, Sonde (Integration, echtes PostgreSQL + A-Trust-Mock)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let hsmSee: SEEConfig
  let fremdSee: SEEConfig
  let mock: { server: Server; basisUrl: string }
  let modus: Modus = 'ok'
  let zdaOk = true
  const foClient = mockFoClient()

  const auth = () => ({ authorization: `Bearer ${token}` })
  const barzahlen = (cent = 500) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Probe', preisBruttoCent: cent, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 },
      },
    })
  const kasse = async () => (await idb.db.select().from(kassen).where(eq(kassen.id, kasseId)))[0]!
  const belegAnzahl = async () => (await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId))).length
  const letzterBeleg = async () =>
    (await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId)).orderBy(desc(belege.belegNummer)).limit(1))[0]!
  const auditAnzahl = async (aktion: string) =>
    (await idb.db.select().from(auditLogs).where(eq(auditLogs.aktion, aktion))).length
  const deps = () => ({ db: idb.db, masterPassphrase: TEST_MASTER, finanzOnlineClient: foClient })

  /** A-Trust-Mock: echte API-Formen, Verhalten über `modus`. */
  async function starteMock(): Promise<{ server: Server; basisUrl: string }> {
    const server = createServer((req, res) => {
      const antworte = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET' && req.url?.endsWith('/ZDA')) {
        return zdaOk ? antworte(200, { zdaid: 'AT1' }) : antworte(503, { fehler: 'wartung' })
      }
      if (req.method === 'GET' && req.url?.endsWith('/Certificate')) {
        return antworte(200, { Signaturzertifikat: hsmSee.zertifikatDER.toString('base64'), ZertifikatsseriennummerHex: '', Zertifizierungsstellen: [] })
      }
      if (req.method === 'POST' && req.url?.endsWith('/Sign/JWS')) {
        let raw = ''
        req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
        req.on('end', () => {
          const body = JSON.parse(raw) as { password?: string; jws_payload?: string }
          switch (modus) {
            case 'http401': return antworte(401, { fehler: 'Falsches Passwort' })
            case 'http404': return antworte(404, { fehler: 'Benutzer unbekannt' })
            case 'http503': return antworte(503, { fehler: 'Wartungsarbeiten' })
            case 'http429': return antworte(429, { fehler: 'zu viele Anfragen' })
            case 'leer':    return antworte(200, {})
            case 'muell':   return antworte(200, { result: randomBytes(64).toString('base64url') })
            case 'fremd':   return antworte(200, { result: signiereRoh(jwsSigningInput(body.jws_payload ?? ''), fremdSee).toString('base64url') })
            default:        return antworte(200, { result: signiereRoh(jwsSigningInput(body.jws_payload ?? ''), hsmSee).toString('base64url') })
          }
        })
        return
      }
      antworte(404, { fehler: 'Unbekannter Pfad' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const adresse = server.address()
    const port    = typeof adresse === 'object' && adresse ? adresse.port : 0
    return { server, basisUrl: `http://127.0.0.1:${port}` }
  }

  /** Setzt die Kasse in einen sauberen Zustand: Einheit ok, kein Ausfall, Uhr in Ordnung. */
  async function bereinige(): Promise<void> {
    modus = 'ok'; zdaOk = true
    vergesseSondenZustand()
    await idb.db.update(kassen)
      .set({ seeAusgefallenSeit: null, atrustBasisUrl: mock.basisUrl })
      .where(eq(kassen.id, kasseId))
  }

  beforeAll(async () => {
    hsmSee   = await generateSEE({ kassenId: 'ATRUST-HSM', uid: 'ATU00000001', firmenname: 'A-Trust Mock' })
    fremdSee = await generateSEE({ kassenId: 'FREMD-HSM',  uid: 'ATU00000002', firmenname: 'Fremder Schlüssel' })
    mock     = await starteMock()

    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: foClient })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/see`, headers: auth(),
      payload: { seeTyp: 'atrust_hsm', atrustBasisUrl: mock.basisUrl, atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT },
    })
    if (patch.statusCode !== 200) throw new Error(`SEE-Umstellung (${patch.statusCode}): ${patch.body}`)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
    mock?.server.close()
  })

  beforeEach(bereinige)

  it('Normalbetrieb mit der Einheit: Beleg signiert, Gegenprobe besteht, kein Ausfall', async () => {
    const res = await barzahlen(990)
    expect(res.statusCode).toBe(201)
    const beleg = res.json() as BelegResponse
    expect(istAusfallBeleg(beleg.signaturwert)).toBe(false)
    expect(verifiziereQrCode(beleg.maschinenlesbareCode, hsmSee.zertifikatDER)).toBe(true)
    expect((await kasse()).seeAusgefallenSeit).toBeNull()
  })

  // ── Fehlerklassen ─────────────────────────────────────────────────────────

  describe.each([
    ['HTTP 401 (falsches Passwort)', 'http401', 401],
    ['HTTP 404 (Benutzer/Adresse falsch)', 'http404', 404],
  ] as const)('Einheit weist ab: %s → harter Fehler', (_name, m, httpStatus) => {
    it('kein Beleg, kein Ausfall, Zähler unverändert, Meldung ohne Wortlaut der Gegenstelle', async () => {
      const vorher = await kasse()
      const anzahl = await belegAnzahl()
      const audit  = await auditAnzahl('see.signatur_abgelehnt')
      modus = m

      const res = await barzahlen(500)
      // 409, nicht 401: Die Oberfläche meldet bei 401 ab
      expect(res.statusCode).toBe(409)
      const text = res.json().fehler as string
      expect(text).toContain('A-Trust')
      expect(text).toContain(`HTTP ${httpStatus}`)
      expect(text).toContain('kein Beleg')
      expect(text).not.toContain('Falsches Passwort')   // Wortlaut der Gegenstelle bleibt im Audit-Log

      const nachher = await kasse()
      expect(nachher.seeAusgefallenSeit).toBeNull()                     // KEIN Ausfall
      expect(nachher.letzteBelegNummer).toBe(vorher.letzteBelegNummer)  // kein Beleg
      expect(nachher.umsatzzaehlerCent).toBe(vorher.umsatzzaehlerCent)
      expect(await belegAnzahl()).toBe(anzahl)
      expect(await auditAnzahl('see.signatur_abgelehnt')).toBe(audit + 1)
    })

    it('sobald die Einheit wieder annimmt, läuft die nächste Zahlung normal', async () => {
      modus = m
      expect((await barzahlen()).statusCode).toBe(409)
      modus = 'ok'
      const res = await barzahlen()
      expect(res.statusCode).toBe(201)
      expect(istAusfallBeleg((res.json() as BelegResponse).signaturwert)).toBe(false)
    })
  })

  describe.each([
    ['HTTP 503', 'http503'],
    ['HTTP 429 (zu viele Anfragen)', 'http429'],
    ['Antwort ohne Signatur', 'leer'],
    ['Signatur aus Zufallsbytes (64 Byte, aber falsch)', 'muell'],
    ['Signatur mit einem fremden Schlüssel (passt nicht zum gespeicherten Zertifikat)', 'fremd'],
  ] as const)('Einheit nicht verfügbar oder unbrauchbar: %s → Ausfall', (_name, m) => {
    it('der Beleg trägt den Marker, NICHT die falsche Signatur; Kette und Zähler bleiben richtig', async () => {
      const vorher = await kasse()
      const audit  = await auditAnzahl('see.ausfall_erkannt')
      modus = m

      const res = await barzahlen(700)
      expect(res.statusCode).toBe(201)
      const beleg = res.json() as BelegResponse
      expect(istAusfallBeleg(beleg.signaturwert)).toBe(true)

      const nachher = await kasse()
      expect(nachher.seeAusgefallenSeit).not.toBeNull()
      expect(nachher.letzteBelegNummer).toBe(vorher.letzteBelegNummer + 1)
      expect(nachher.umsatzzaehlerCent).toBe(vorher.umsatzzaehlerCent + 700n)   // genau einmal gebucht
      // Eine unbrauchbare Signatur wird nirgends gespeichert
      const alle = await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId))
      expect(alle.filter(b => !istAusfallBeleg(b.signaturwert) && !verifiziereQrCode(b.maschinenlesbareCode, hsmSee.zertifikatDER)
                              && b.belegTyp !== 'Startbeleg')).toHaveLength(0)
      expect(await auditAnzahl('see.ausfall_erkannt')).toBe(audit + 1)
    })
  })

  it('Netz weg (Adresse nicht erreichbar) → Ausfall wie bisher', async () => {
    await idb.db.update(kassen).set({ atrustBasisUrl: 'http://127.0.0.1:1' }).where(eq(kassen.id, kasseId))
    const res = await barzahlen()
    expect(res.statusCode).toBe(201)
    expect(istAusfallBeleg((res.json() as BelegResponse).signaturwert)).toBe(true)
    expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
  }, 15_000)

  it('A-Trust ohne vollständige Zugangsdaten: harter Fehler statt Beleg mit dem falschen Schlüssel', async () => {
    await idb.db.update(kassen).set({ atrustPasswortEnc: null }).where(eq(kassen.id, kasseId))
    const anzahl = await belegAnzahl()
    const res = await barzahlen()
    expect(res.statusCode).toBe(409)
    expect(res.json().fehler).toContain('nicht vollständig eingerichtet')
    expect(await belegAnzahl()).toBe(anzahl)
    expect((await kasse()).seeAusgefallenSeit).toBeNull()
    // Zugangsdaten wieder herstellen: PATCH
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/see`, headers: auth(),
      payload: { seeTyp: 'atrust_hsm', atrustBasisUrl: mock.basisUrl, atrustBenutzer: ATRUST_BENUTZER, atrustPasswort: ATRUST_PASSWORT },
    })
    expect(patch.statusCode).toBe(200)
  })

  it('im laufenden Ausfall wird die Einheit nicht angesprochen (Belege tragen sofort den Marker)', async () => {
    modus = 'http503'
    expect((await barzahlen()).statusCode).toBe(201)          // geht in den Ausfall
    modus = 'http401'                                         // würde jetzt hart abweisen — aber im Ausfall wird nicht signiert
    const res = await barzahlen()
    expect(res.statusCode).toBe(201)
    expect(istAusfallBeleg((res.json() as BelegResponse).signaturwert)).toBe(true)
  })

  describe('manuelle Wiederherstellung', () => {
    beforeEach(async () => {
      modus = 'http503'
      expect((await barzahlen()).statusCode).toBe(201)        // Ausfall
    })

    it('Einheit weiterhin nicht verfügbar: 409 mit klarer Meldung (nicht „Interner Serverfehler"), Ausfall bleibt', async () => {
      const res = await srv.fastify.inject({ method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId } })
      expect(res.statusCode).toBe(409)
      expect(res.json().fehler).toContain('weiterhin nicht verfügbar')
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
    })

    it('Einheit lehnt ab: 409 mit Hinweis auf die Zugangsdaten, Ausfall bleibt', async () => {
      modus = 'http401'
      const res = await srv.fastify.inject({ method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId } })
      expect(res.statusCode).toBe(409)
      expect(res.json().fehler).toContain('abgelehnt')
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
    })

    it('Einheit wieder da: Sammelbeleg signiert, Ausfall beendet', async () => {
      modus = 'ok'
      const res = await srv.fastify.inject({ method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId } })
      expect(res.statusCode).toBe(201)
      expect((await kasse()).seeAusgefallenSeit).toBeNull()
    })
  })

  // ── Hintergrundsonde ──────────────────────────────────────────────────────

  describe('Hintergrundsonde (automatische Wiederherstellung)', () => {
    beforeEach(async () => {
      modus = 'http503'
      expect((await barzahlen()).statusCode).toBe(201)        // Ausfall
    })

    it('Einheit weiterhin weg: nichts geschieht, die Kasse bleibt im Ausfall', async () => {
      zdaOk = false
      const anzahl = await belegAnzahl()
      const e = await pruefeSeeWiederherstellung(idb.db, deps())
      expect(e).toMatchObject([{ kassenId: 'SF-001', ausgang: 'nicht-erreichbar' }])
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
      expect(await belegAnzahl()).toBe(anzahl)                // kein Sammelbeleg
    })

    it('Einheit wieder da: Signatur wird von selbst wiederhergestellt (Sammelbeleg, Flag zurück, Audit)', async () => {
      modus = 'ok'
      const audit = await auditAnzahl('see.automatisch_wiederhergestellt')
      const e = await pruefeSeeWiederherstellung(idb.db, deps())
      expect(e).toMatchObject([{ kassenId: 'SF-001', ausgang: 'wiederhergestellt' }])

      expect((await kasse()).seeAusgefallenSeit).toBeNull()
      const sammel = await letzterBeleg()
      expect(sammel.belegTyp).toBe('Nullbeleg')
      expect(istAusfallBeleg(sammel.signaturwert)).toBe(false)
      expect(verifiziereQrCode(sammel.maschinenlesbareCode, hsmSee.zertifikatDER)).toBe(true)
      expect(await auditAnzahl('see.automatisch_wiederhergestellt')).toBe(audit + 1)

      // und danach ist wieder alles signiert
      const res = await barzahlen()
      expect(istAusfallBeleg((res.json() as BelegResponse).signaturwert)).toBe(false)

      // ein zweiter Durchlauf findet nichts mehr
      expect(await pruefeSeeWiederherstellung(idb.db, deps())).toEqual([])
    })

    it('erreichbar, aber Signieren scheitert noch (503): bleibt im Ausfall, kein halber Beleg', async () => {
      const anzahl = await belegAnzahl()
      modus = 'http503'                                      // /ZDA antwortet, /Sign/JWS nicht
      const e = await pruefeSeeWiederherstellung(idb.db, deps())
      expect(e).toMatchObject([{ ausgang: 'nicht-erreichbar' }])
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
      expect(await belegAnzahl()).toBe(anzahl)
    })

    it('Einheit lehnt ab (401): kein Beleg, danach 15 Minuten Pause, dann ein neuer Versuch', async () => {
      modus = 'http401'
      const anzahl = await belegAnzahl()
      const jetzt  = new Date()
      expect(await pruefeSeeWiederherstellung(idb.db, deps(), jetzt)).toMatchObject([{ ausgang: 'abgelehnt' }])
      expect(await belegAnzahl()).toBe(anzahl)
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()

      expect(await pruefeSeeWiederherstellung(idb.db, deps(), new Date(jetzt.getTime() + 60_000)))
        .toMatchObject([{ ausgang: 'pausiert' }])
      expect(await pruefeSeeWiederherstellung(idb.db, deps(), new Date(jetzt.getTime() + SONDE_PAUSE_NACH_ABLEHNUNG_MS + 1_000)))
        .toMatchObject([{ ausgang: 'abgelehnt' }])

      // Passwort korrigiert → der nächste Versuch nach der Pause gelingt
      modus = 'ok'
      expect(await pruefeSeeWiederherstellung(idb.db, deps(), new Date(jetzt.getTime() + 2 * SONDE_PAUSE_NACH_ABLEHNUNG_MS + 5_000)))
        .toMatchObject([{ ausgang: 'wiederhergestellt' }])
    })

    it('Ausfall ab 48 Stunden: die Sonde lässt die Hände davon (FinanzOnline-Meldung kommt aus dem Banner)', async () => {
      await idb.db.update(kassen).set({ seeAusgefallenSeit: new Date(Date.now() - 49 * 3_600_000) }).where(eq(kassen.id, kasseId))
      modus = 'ok'
      const e = await pruefeSeeWiederherstellung(idb.db, deps())
      expect(e).toMatchObject([{ ausgang: 'zu-lange-ausgefallen' }])
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
    })

    it('eine Software-SEE im (bewusst gemeldeten) Ausfall wird nicht angefasst', async () => {
      await idb.db.update(kassen).set({ seeTyp: 'software' }).where(eq(kassen.id, kasseId))
      modus = 'ok'
      try {
        expect(await pruefeSeeWiederherstellung(idb.db, deps())).toEqual([])
        expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
      } finally {
        await idb.db.update(kassen).set({ seeTyp: 'atrust_hsm' }).where(eq(kassen.id, kasseId))
      }
    })
  })

  // ── Uhr ───────────────────────────────────────────────────────────────────

  describe('Uhr-Plausibilisierung', () => {
    it('Rücksprung bis 1 Minute: der Beleg bekommt die Zeit des Vorbelegs (nie davor)', async () => {
      const vorbeleg = await letzterBeleg()
      const zukunft  = new Date(Date.now() + 30_000)
      await idb.db.update(belege).set({ belegDatum: zukunft }).where(eq(belege.id, vorbeleg.id))
      const audit = await auditAnzahl('beleg.zeit_angeglichen')
      try {
        const res = await barzahlen()
        expect(res.statusCode).toBe(201)
        const neu = await letzterBeleg()
        expect(neu.belegNummer).toBe(vorbeleg.belegNummer + 1)
        expect(neu.belegDatum.getTime()).toBe(zukunft.getTime())
        expect(await auditAnzahl('beleg.zeit_angeglichen')).toBe(audit + 1)
        // Der neue Beleg liegt nicht VOR dem Vorbeleg
        expect(neu.belegDatum.getTime()).toBeGreaterThanOrEqual(zukunft.getTime())
      } finally {
        // Beide Zeitstempel zurück auf die echte Zeit des Vorbelegs, damit die übrigen Tests eine
        // gerade Kette sehen (der angeglichene Beleg stünde sonst 30 s in der Zukunft)
        await idb.db.update(belege).set({ belegDatum: vorbeleg.belegDatum }).where(eq(belege.id, vorbeleg.id))
        const jetztLetzter = await letzterBeleg()
        if (jetztLetzter.belegNummer > vorbeleg.belegNummer) {
          await idb.db.update(belege).set({ belegDatum: vorbeleg.belegDatum }).where(eq(belege.id, jetztLetzter.id))
        }
      }
    })

    it('größerer Rücksprung: abgelehnt, kein Beleg, Meldung nennt die Uhr', async () => {
      const vorbeleg = await letzterBeleg()
      await idb.db.update(belege).set({ belegDatum: new Date(Date.now() + 10 * 60_000) }).where(eq(belege.id, vorbeleg.id))
      const anzahl = await belegAnzahl()
      try {
        const res = await barzahlen()
        expect(res.statusCode).toBe(409)
        expect(res.json().fehler).toMatch(/Systemuhr.*nach/)
        expect(res.json().fehler).toMatch(/\d+ Minuten? VOR dem letzten Beleg/)
        expect(await belegAnzahl()).toBe(anzahl)
      } finally {
        await idb.db.update(belege).set({ belegDatum: vorbeleg.belegDatum }).where(eq(belege.id, vorbeleg.id))
      }
    })

    it('gleichmäßig laufende Uhr: Belegzeiten steigen, keine Korrektur nötig', async () => {
      const vorher = await auditAnzahl('beleg.zeit_angeglichen')
      for (let i = 0; i < 3; i++) expect((await barzahlen()).statusCode).toBe(201)
      expect(await auditAnzahl('beleg.zeit_angeglichen')).toBe(vorher)
      const rows = (await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId)))
        .sort((a, b) => a.belegNummer - b.belegNummer)
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.belegDatum.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.belegDatum.getTime())
      }
    })
  })
})
