/**
 * Integrationstest: POST /api/setup ist nicht mehr für jeden offen.
 *
 * Früher legte die öffentliche Route auch auf einer EINGERICHTETEN Installation einen weiteren Mandanten
 * samt Admin an — wer im Netz war, konnte sich ein Konto auf dem Kassen-PC schaffen. Jetzt:
 *   - leere Installation: offen (Ersteinrichtung); der erste Admin ist Betreiber
 *   - eingerichtete Installation: nur der angemeldete Betreiber ODER der Einrichtungs-Schlüssel (SETUP_TOKEN)
 *   - Prüfung und Anlage sind atomar (zwei gleichzeitige Ersteinrichtungen: nur eine gewinnt)
 *   - eigenes enges Rate-Limit je Client
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { auditLogs, mandanten, users } from '../../src/db/schema.js'
import { buildTestServer, TEST_SETUP_TOKEN, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'sperre-passwort-123'

function fo(verzoegerungMs = 0): FinanzOnlineClient {
  const warte = () => (verzoegerungMs > 0 ? new Promise<void>(r => setTimeout(r, verzoegerungMs)) : Promise.resolve())
  return {
    kasseInBetriebNehmen:     vi.fn().mockImplementation(async () => { await warte(); return { erfolgreich: true } }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SG-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function einrichtung(nr: number) {
  return {
    firmenname: `Sperre ${nr} GmbH`,
    uid:        `ATU8888880${nr}`,
    kassenId:   `SG-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-SG-${nr}`, benutzerkennung: `BID-SG-${nr}`, pin: `PIN-SG-${nr}` },
    umgebung: 'test',
    admin: { name: `Admin ${nr}`, email: `admin${nr}@sperre.at`, passwort: PASSWORT },
  }
}

describe('POST /api/setup — wer einrichten darf (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let srvOhneSchluessel: TestServer
  const finanzOnline = fo()
  let tokenBetreiber: string
  let tokenNormalerAdmin: string

  const setup = (nr: number, headers: Record<string, string> = {}, server = srv) =>
    server.fastify.inject({ method: 'POST', url: '/api/setup', headers, payload: einrichtung(nr) })

  const anzahl = async () => ({
    mandanten: (await idb.db.select({ n: count() }).from(mandanten))[0]!.n,
    benutzer:  (await idb.db.select({ n: count() }).from(users))[0]!.n,
  })

  const login = async (nr: number): Promise<string> => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: `admin${nr}@sperre.at`, passwort: PASSWORT },
    })
    expect(res.statusCode).toBe(200)
    return res.json().token as string
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: finanzOnline })
    // Dieselbe Datenbank, aber ohne konfigurierten Einrichtungs-Schlüssel (so läuft eine Installation ohne SETUP_TOKEN)
    srvOhneSchluessel = await buildTestServer(idb.db, { finanzOnlineClient: fo(), config: { SETUP_TOKEN: undefined } })
  })

  afterAll(async () => {
    await srvOhneSchluessel?.close()
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('frische Installation: jeder richtet ein — der erste Admin ist der Betreiber', async () => {
    const res = await setup(1)
    expect(res.statusCode).toBe(201)

    const [admin] = await idb.db.select().from(users).where(eq(users.email, 'admin1@sperre.at'))
    expect(admin!.istBetreiber).toBe(true)
    tokenBetreiber = await login(1)
  })

  it('eingerichtete Installation: ohne Anmeldung 403 — und es wird nichts angelegt', async () => {
    const vorher = await anzahl()
    const res = await setup(2)
    expect(res.statusCode).toBe(403)
    const body = res.json() as { erfolgreich: boolean; fehler: string }
    expect(body.erfolgreich).toBe(false)
    expect(body.fehler).toMatch(/Betreiber/)
    expect(await anzahl()).toEqual(vorher)

    // Der Versuch steht im Audit-Log
    const [versuch] = await idb.db.select({ n: count() }).from(auditLogs).where(eq(auditLogs.aktion, 'setup.verweigert'))
    expect(versuch!.n).toBeGreaterThanOrEqual(1)
  })

  it('ein Unberechtigter löst weder die RKSV-Einrichtung (FinanzOnline!) aus noch erfährt er, was schon vergeben ist', async () => {
    const registrierungenVorher = vi.mocked(finanzOnline.kasseInBetriebNehmen).mock.calls.length
    // UID und E-Mail des ersten Mandanten: mit Berechtigung käme "bereits vergeben" (400) — hier muss es 403 sein
    const belegt = await srv.fastify.inject({
      method: 'POST', url: '/api/setup', payload: einrichtung(1),
    })
    expect(belegt.statusCode).toBe(403)
    expect(belegt.body).not.toMatch(/vergeben|registriert/)
    // ... und mit ganz neuen Daten wird nichts bei FinanzOnline angemeldet
    expect((await setup(2)).statusCode).toBe(403)
    expect(vi.mocked(finanzOnline.kasseInBetriebNehmen).mock.calls.length).toBe(registrierungenVorher)
  })

  it('ein ungültiges Token zählt wie keines', async () => {
    const vorher = await anzahl()
    const res = await setup(2, { authorization: 'Bearer das.ist.kein.token' })
    expect(res.statusCode).toBe(403)
    expect(await anzahl()).toEqual(vorher)
  })

  it('der angemeldete Betreiber legt einen weiteren Mandanten an — dessen Admin ist KEIN Betreiber', async () => {
    const res = await setup(2, { authorization: `Bearer ${tokenBetreiber}` })
    expect(res.statusCode).toBe(201)

    const [admin2] = await idb.db.select().from(users).where(eq(users.email, 'admin2@sperre.at'))
    expect(admin2!.istBetreiber).toBe(false)
    tokenNormalerAdmin = await login(2)
  })

  it('ein Admin, der nicht Betreiber ist, darf keinen weiteren Mandanten anlegen', async () => {
    const vorher = await anzahl()
    const res = await setup(3, { authorization: `Bearer ${tokenNormalerAdmin}` })
    expect(res.statusCode).toBe(403)
    expect(await anzahl()).toEqual(vorher)
  })

  it('ein deaktivierter Betreiber verliert sofort die Berechtigung — sein altes Token gilt nicht mehr', async () => {
    await idb.db.update(users).set({ aktiv: false }).where(eq(users.email, 'admin1@sperre.at'))
    try {
      const vorher = await anzahl()
      const res = await setup(3, { authorization: `Bearer ${tokenBetreiber}` })
      expect(res.statusCode).toBe(403)
      expect(await anzahl()).toEqual(vorher)
    } finally {
      await idb.db.update(users).set({ aktiv: true }).where(eq(users.email, 'admin1@sperre.at'))
    }
  })

  it('Einrichtungs-Schlüssel: der richtige richtet ein, ein falscher nicht', async () => {
    const vorher = await anzahl()
    const falsch = await setup(3, { 'x-setup-token': TEST_SETUP_TOKEN + 'x' })
    expect(falsch.statusCode).toBe(403)
    expect(await anzahl()).toEqual(vorher)

    const richtig = await setup(3, { 'x-setup-token': TEST_SETUP_TOKEN })
    expect(richtig.statusCode).toBe(201)
    const [admin3] = await idb.db.select().from(users).where(eq(users.email, 'admin3@sperre.at'))
    expect(admin3!.istBetreiber).toBe(false)
  })

  it('ohne konfigurierten Schlüssel gibt es diesen Weg nicht — auch nicht mit einem leeren Header', async () => {
    const vorher = await anzahl()
    for (const wert of [TEST_SETUP_TOKEN, '']) {
      const res = await setup(4, { 'x-setup-token': wert }, srvOhneSchluessel)
      expect(res.statusCode).toBe(403)
    }
    expect(await anzahl()).toEqual(vorher)
  })
})

describe('POST /api/setup — Prüfung und Anlage sind atomar', () => {
  let idb: IntegrationsDb
  let srv: TestServer

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    // Langsame FinanzOnline-Anmeldung: beide Anfragen bestehen die Vorab-Prüfung ("noch kein Benutzer"),
    // bevor eine von beiden fertig ist
    srv = await buildTestServer(idb.db, { finanzOnlineClient: fo(300) })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('zwei gleichzeitige Ersteinrichtungen: genau eine gewinnt, die andere bekommt 403', async () => {
    const [a, b] = await Promise.all([1, 2].map(nr => srv.fastify.inject({
      method: 'POST', url: '/api/setup', payload: einrichtung(nr),
    })))
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([201, 403])

    expect((await idb.db.select({ n: count() }).from(mandanten))[0]!.n).toBe(1)
    const alle = await idb.db.select().from(users)
    expect(alle).toHaveLength(1)
    expect(alle[0]!.istBetreiber).toBe(true)
  })
})

describe('POST /api/setup — enges Rate-Limit', () => {
  let idb: IntegrationsDb
  let srv: TestServer

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: fo(), setupRateLimitMax: 3 })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('nach drei Anfragen je Minute folgt 429 — auch für Unberechtigte und mit ungültigem Inhalt', async () => {
    const senden = () => srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: {} })
    for (let i = 0; i < 3; i++) expect((await senden()).statusCode).toBe(400)
    const gebremst = await senden()
    expect(gebremst.statusCode).toBe(429)
    expect((gebremst.json() as { fehler: string }).fehler).toMatch(/Zu viele Anfragen/)
  })
})
