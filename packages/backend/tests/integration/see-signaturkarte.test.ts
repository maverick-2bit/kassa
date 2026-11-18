/**
 * Integrationstest: Signaturkarte (a.sign RK CHIP) als Signatureinheit — echtes PostgreSQL, simulierte Karte.
 *
 *   - Einrichten: Karte lesen ohne PIN; falsche PIN = ein Fehlversuch, nichts gespeichert; richtige PIN = AT1
 *   - Verkauf: Beleg mit der Karte signiert (_R1-AT1_), Gegenprobe gegen das Kartenzertifikat
 *   - Karte gezogen / Brücke weg → Ausfallmodus; Sonde stellt wieder her, sobald die Karte steckt
 *   - PIN falsch → kein Beleg, PIN dauerhaft gesperrt: weder Verkauf noch Sonde fassen die Karte wieder an
 *   - fremde Karte → Abbruch VOR der PIN-Prüfung
 *   - FinanzOnline: Einheit wird als SIGNATURKARTE (vda AT1) gemeldet
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import {
  SimulierteSignaturkarte,
  istAusfallBeleg,
  verifiziereQrCode,
  type ApduTransport,
  type FinanzOnlineClient,
} from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { belege, kassen } from '../../src/db/schema.js'
import { encryptPrivateKey } from '../../src/crypto/master-key.js'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { pruefeSeeWiederherstellung, vergesseSondenZustand } from '../../src/services/see-sonde.service.js'

const ADMIN_EMAIL    = 'admin@signaturkarte.at'
const ADMIN_PASSWORT = 'signaturkarte-passwort-123'
const RICHTIGE_PIN   = '123456'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:          vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SK-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(),
    seeAusfallMelden:              vi.fn().mockResolvedValue({ erfolgreich: true }),
    seeWiederinbetriebnahmeMelden: vi.fn().mockResolvedValue({ erfolgreich: true }),
  } as unknown as FinanzOnlineClient
}

describe('SEE: Signaturkarte über die Kartenbrücke (Integration, echtes PostgreSQL + Kartensimulator)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let karte: SimulierteSignaturkarte
  let fremdeKarte: SimulierteSignaturkarte
  /** Weiche: welche Karte gerade im Leser steckt */
  let gesteckt: SimulierteSignaturkarte
  const foClient = mockFoClient()

  const leser: ApduTransport = {
    leser: () => gesteckt.leser(),
    sende: (l, apdus) => gesteckt.sende(l, apdus),
  }

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
  const seePatch = (payload: Record<string, unknown>) =>
    srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasseId}/see`, headers: auth(), payload })
  const kasse = async () => (await idb.db.select().from(kassen).where(eq(kassen.id, kasseId)))[0]!
  const letzterBeleg = async () =>
    (await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId)).orderBy(desc(belege.belegNummer)).limit(1))[0]!
  const belegAnzahl = async () => (await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId))).length
  const deps = () => ({ db: idb.db, masterPassphrase: TEST_MASTER, finanzOnlineClient: foClient, kartenTransport: leser })

  beforeAll(async () => {
    karte       = await SimulierteSignaturkarte.erzeuge({ pin: RICHTIGE_PIN })
    fremdeKarte = await SimulierteSignaturkarte.erzeuge({ pin: '999999' })
    gesteckt    = karte

    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: foClient, kartenTransport: leser })

    // Provisorisch einrichten (ohne FinanzOnline) — die Registrierung kommt nach der Umstellung auf die Karte
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Signaturkarte GmbH', uid: 'ATU99999912', kassenId: 'SK-001', umgebung: 'test',
        admin: { name: 'SK Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Einrichten ────────────────────────────────────────────────────────────

  describe('Einrichten', () => {
    it('„Verbindung testen" ohne PIN: erkennt die Karte, liest das Zertifikat, keine PIN-Prüfung', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasseId}/see/test`, headers: auth(), payload: { seeTyp: 'atrust_chip' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ erfolgreich: true, zdaId: 'AT1', karte: 'A-Trust ACOS-ID 4.1' })
      expect(karte.pinPruefungen).toBe(0)
    })

    it('ohne PIN speichern geht nicht (noch keine PIN hinterlegt)', async () => {
      const res = await seePatch({ seeTyp: 'atrust_chip' })
      expect(res.statusCode).toBe(400)
      expect(res.json().fehler).toMatch(/PIN/)
      expect((await kasse()).seeTyp).toBe('software')
    })

    it('falsche PIN: EIN Fehlversuch, Meldung nennt die Restversuche, nichts gespeichert', async () => {
      const res = await seePatch({ seeTyp: 'atrust_chip', kartePin: '111111' })
      expect(res.statusCode).toBe(400)
      expect(res.json().fehler).toMatch(/noch 2 Versuche/)
      expect(karte.pinPruefungen).toBe(1)
      expect(karte.restVersuche).toBe(2)
      const k = await kasse()
      expect(k.seeTyp).toBe('software')
      expect(k.kartePinEnc).toBeNull()
    })

    it('richtige PIN: Kasse signiert ab jetzt mit der Karte (AT1, Zertifikat der Karte), Zähler der Karte wieder voll', async () => {
      const res = await seePatch({ seeTyp: 'atrust_chip', kartePin: RICHTIGE_PIN })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ erfolgreich: true, zdaId: 'AT1', karte: 'A-Trust ACOS-ID 4.1' })
      expect(karte.restVersuche).toBe(3)
      const k = await kasse()
      expect(k).toMatchObject({ seeTyp: 'atrust_chip', seeZdaId: 'AT1', kartePinGesperrt: false })
      expect(k.seeZertifikatDer).toBe(karte.zertifikatDer.toString('base64'))
      expect(k.kartePinEnc).not.toBeNull()
      expect(k.kartePinEnc).not.toContain(RICHTIGE_PIN)

      const see = (await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/see`, headers: auth() })).json()
      expect(see).toMatchObject({ seeTyp: 'atrust_chip', kartePinGesetzt: true, kartePinGesperrt: false, kartePinHinweis: null })
      expect(JSON.stringify(see)).not.toContain(RICHTIGE_PIN)
    })
  })

  // ── Betrieb ───────────────────────────────────────────────────────────────

  describe('Betrieb', () => {
    beforeEach(async () => {
      gesteckt = karte
      karte.gesteckt = true
      karte.erreichbar = true
      vergesseSondenZustand()
      await idb.db.update(kassen).set({
        seeAusgefallenSeit: null,
        kartePinGesperrt:   false,
        kartePinHinweis:    null,
        kartePinEnc:        encryptPrivateKey(Buffer.from(RICHTIGE_PIN, 'utf8'), TEST_MASTER),
      }).where(eq(kassen.id, kasseId))
    })

    it('Verkauf: mit der Karte signiert, besteht die Gegenprobe gegen das Kartenzertifikat', async () => {
      const vorher = karte.signaturen
      const res = await barzahlen(990)
      expect(res.statusCode).toBe(201)
      const beleg = res.json() as BelegResponse
      expect(beleg.maschinenlesbareCode).toMatch(/^_R1-AT1_SK-001_/)
      expect(istAusfallBeleg(beleg.signaturwert)).toBe(false)
      expect(verifiziereQrCode(beleg.maschinenlesbareCode, karte.zertifikatDer)).toBe(true)
      expect(karte.signaturen).toBe(vorher + 1)
    })

    it('Karte gezogen → Ausfallmodus; Sonde wartet, bis die Karte wieder steckt, dann Sammelbeleg mit Karte', async () => {
      karte.gesteckt = false
      const res = await barzahlen()
      expect(res.statusCode).toBe(201)
      expect(istAusfallBeleg((res.json() as BelegResponse).signaturwert)).toBe(true)
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()

      expect(await pruefeSeeWiederherstellung(idb.db, deps())).toMatchObject([{ kassenId: 'SK-001', ausgang: 'nicht-erreichbar' }])

      karte.gesteckt = true
      expect(await pruefeSeeWiederherstellung(idb.db, deps())).toMatchObject([{ kassenId: 'SK-001', ausgang: 'wiederhergestellt' }])
      const sammel = await letzterBeleg()
      expect(sammel.belegTyp).toBe('Nullbeleg')
      expect(verifiziereQrCode(sammel.maschinenlesbareCode, karte.zertifikatDer)).toBe(true)
      expect((await kasse()).seeAusgefallenSeit).toBeNull()
    })

    it('Kartenbrücke weg → Ausfallmodus (Verkauf läuft weiter)', async () => {
      karte.erreichbar = false
      const res = await barzahlen()
      expect(res.statusCode).toBe(201)
      expect(istAusfallBeleg((res.json() as BelegResponse).signaturwert)).toBe(true)
    })

    it('Wiederherstellen von Hand, Karte noch gezogen: 502, Ausfall bleibt', async () => {
      karte.gesteckt = false
      expect((await barzahlen()).statusCode).toBe(201)
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId },
      })
      expect(res.statusCode).toBe(502)
      expect(res.json().fehler).toMatch(/Signaturkarte|Karte/)
      expect((await kasse()).seeAusgefallenSeit).not.toBeNull()
    })

    it('PIN falsch: kein Beleg, PIN gesperrt — danach fasst die Kassa die Karte NICHT mehr an (Verkauf, Sonde)', async () => {
      await idb.db.update(kassen)
        .set({ kartePinEnc: encryptPrivateKey(Buffer.from('222222', 'utf8'), TEST_MASTER) })
        .where(eq(kassen.id, kasseId))
      const anzahl = await belegAnzahl()
      const pruefungen = karte.pinPruefungen

      const res = await barzahlen()
      expect(res.statusCode).toBe(409)
      expect(res.json().fehler).toMatch(/PIN ist falsch.*NICHT von selbst erneut/s)
      expect(await belegAnzahl()).toBe(anzahl)
      expect(karte.pinPruefungen).toBe(pruefungen + 1)
      expect(await kasse()).toMatchObject({ kartePinGesperrt: true, kartePinHinweis: 'noch 2 Versuche', seeAusgefallenSeit: null })

      // weitere Verkäufe: Fehler OHNE Kartenzugriff
      const nochmal = await barzahlen()
      expect(nochmal.statusCode).toBe(409)
      expect(nochmal.json().fehler).toMatch(/PIN abgelehnt \(noch 2 Versuche\)/)
      expect(karte.pinPruefungen).toBe(pruefungen + 1)

      // Sonde im Ausfall: lässt die Karte in Ruhe
      await idb.db.update(kassen).set({ seeAusgefallenSeit: new Date() }).where(eq(kassen.id, kasseId))
      expect(await pruefeSeeWiederherstellung(idb.db, deps())).toMatchObject([{ kassenId: 'SK-001', ausgang: 'abgelehnt' }])
      expect(karte.pinPruefungen).toBe(pruefungen + 1)

      // neue (richtige) PIN eintragen hebt die Sperre auf
      await idb.db.update(kassen).set({ seeAusgefallenSeit: null }).where(eq(kassen.id, kasseId))
      const neu = await seePatch({ seeTyp: 'atrust_chip', kartePin: RICHTIGE_PIN })
      expect(neu.statusCode).toBe(200)
      expect(await kasse()).toMatchObject({ kartePinGesperrt: false, kartePinHinweis: null })
      expect((await barzahlen()).statusCode).toBe(201)
    })

    it('fremde Karte gesteckt: Abbruch VOR der PIN-Prüfung, kein Beleg, kein Ausfall', async () => {
      gesteckt = fremdeKarte
      const res = await barzahlen()
      expect(res.statusCode).toBe(409)
      expect(res.json().fehler).toMatch(/andere Signaturkarte/)
      expect(fremdeKarte.pinPruefungen).toBe(0)
      expect((await kasse()).seeAusgefallenSeit).toBeNull()
    })
  })

  it('FinanzOnline-Nachtrag meldet die Einheit als SIGNATURKARTE mit vda AT1', async () => {
    gesteckt = karte
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/fo-registrierung', headers: auth(),
      payload: { kasseId, credentials: { teilnehmerId: 'TID', benutzerkennung: 'BID', pin: 'FONPIN' } },
    })
    expect(res.statusCode).toBe(200)
    expect(foClient.kasseInBetriebNehmen).toHaveBeenCalledWith(expect.objectContaining({ artSe: 'SIGNATURKARTE', vdaId: 'AT1' }))
  })
})
