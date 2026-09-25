/**
 * Integrationstest: Routen geben keine internen Fehlermeldungen mehr heraus
 * (echtes PostgreSQL).
 *
 * Befund (Audit 2026-09-24): Rund 66 catch-Blöcke in den Routen schickten bei
 * UNERWARTETEN Fehlern die Rohmeldung an den Client — mit drizzle-orm 0.45
 * „Failed query: <SQL> params: <Werte>". Reservierung, Dienstplan, Zeiterfassung
 * und Online-Buchung meldeten DB-Fehler sogar als 404, die öffentliche
 * Stempeluhr und Online-Buchung auch Unangemeldeten.
 *
 * Kernpunkte:
 *  - DB-Fehler im try-Block → 500 { fehler: 'Interner Serverfehler' } ohne SQL,
 *    Parameter oder Eingaben; die Einzelheiten stehen im Log
 *  - Setup und „weitere Kasse" behalten ihr Antwortformat (Schritte), nur ohne Interna
 *  - Artikel-Import: eine Zeile mit DB-Fehler bricht den Import nicht ab und
 *    steht ohne Interna in der Fehlerliste
 *  - gewollte Meldungen bleiben mit Status und Text: Fachfehler der Services,
 *    Druckerfehler, Mailserver, A-Trust, FinanzOnline
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import { FonSoapError, type FinanzOnlineClient } from '@kassa/rksv'
import { schema, type Db } from '../../src/db/client.js'
import { belege, kassen, mandanten, users } from '../../src/db/schema.js'
import { encryptPrivateKey } from '../../src/crypto/master-key.js'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const INTERN = { fehler: 'Interner Serverfehler' }

/** Nichts davon darf je beim Client ankommen. */
const INTERNE_DETAILS = /Failed query|params:|duplicate key|constraint|insert into|select |delete from|update "|kassa_test_|kassa_gibt_es_nicht|Geheimsache/i

const EMAIL    = 'admin@route-fehler.at'
const PASSWORT = 'route-fehler-passwort-1'

/** Irgendeine ID, die es nicht gibt */
const UNBEKANNT = '50000000-0000-0000-0000-000000000001'

function mockFoClient() {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'RF-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  }
}

/** Log-Zeilen eines Test-Servers (pino-JSON). */
function logSammler() {
  const zeilen: string[] = []
  const eintraege = () => zeilen.map(z => JSON.parse(z) as { msg?: string; err?: { message?: string } })
  return {
    stream: { write: (zeile: string) => { zeilen.push(zeile) } },
    leeren: () => { zeilen.length = 0 },
    mit:    (msg: string) => eintraege().filter(e => e.msg === msg),
  }
}

describe('Routen ohne interne Fehlermeldungen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string
  const fo  = mockFoClient()
  const log = logSammler()

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, {
      finanzOnlineClient: fo as unknown as FinanzOnlineClient,
      // Mailserver, der nicht antwortet: 127.0.0.1:9 ist zu → sofort ECONNREFUSED
      config:    { LOG_LEVEL: 'error', SMTP_HOST: '127.0.0.1', SMTP_PORT: 9, SMTP_USER: 'u', SMTP_PASS: 'p' },
      logStream: log.stream,
    })
    // Provisorisch (ohne FinanzOnline) — für den Nachtrag der FON-Registrierung
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Route Fehler OG', uid: 'ATU99999943', kassenId: 'RF-001', umgebung: 'test',
        admin: { name: 'RF Admin', email: EMAIL, passwort: PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup: ${setup.body}`)
    const login = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, passwort: PASSWORT } })
    if (login.statusCode !== 200) throw new Error(`Login: ${login.body}`)
    token   = login.json().token
    kasseId = login.json().kassen[0].id
    const [m] = await idb.db.select({ id: mandanten.id }).from(mandanten).limit(1)
    mandantId = m!.id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  beforeEach(() => log.leeren())

  // -------------------------------------------------------------------------
  // Unerwartete Fehler
  // -------------------------------------------------------------------------

  describe('Datenbank nicht erreichbar — Fehler im try-Block der Route', () => {
    let kaputtSql: ReturnType<typeof postgres>
    let srvOhneDb: TestServer
    const logOhneDb = logSammler()

    beforeAll(async () => {
      const url = new URL(idb.url)
      url.pathname = '/kassa_gibt_es_nicht'
      // backoff aus: sonst wartet jeder weitere Verbindungsversuch exponentiell länger (bis 20 s)
      kaputtSql = postgres(url.toString(), { max: 1, fetch_types: false, onnotice: () => {}, backoff: false })
      srvOhneDb = await buildTestServer(drizzle(kaputtSql, { schema }) as Db, {
        finanzOnlineClient: mockFoClient() as unknown as FinanzOnlineClient,
        config:    { LOG_LEVEL: 'error' },
        logStream: logOhneDb.stream,
      })
    })

    afterAll(async () => {
      await srvOhneDb?.close()
      await kaputtSql?.end()
    })

    beforeEach(() => logOhneDb.leeren())

    // Bis hierher meldeten diese Routen die Rohmeldung — teils als 404/409
    it.each([
      ['Stempeluhr (öffentlich)',            'POST',   '/api/zeiterfassung/stempeln', { kasseId: UNBEKANNT, pin: '4711' }],
      ['Online-Buchung: Info (öffentlich)',  'GET',    `/api/buchung/${UNBEKANNT}`, undefined],
      ['Online-Buchung: Freie Tische (öffentlich)', 'GET', `/api/buchung/${UNBEKANNT}/tische?datum=2026-10-01&zeitVon=19:00`, undefined],
      ['Online-Buchung: Buchen (öffentlich)', 'POST',  `/api/buchung/${UNBEKANNT}`,
        { datum: '2026-10-01', zeitVon: '19:00', personenAnzahl: 2, name: 'Geheimsache 4711' }],
      ['Online-Buchung: Stornieren (öffentlich)', 'POST', `/api/buchung/${UNBEKANNT}/stornieren/${UNBEKANNT}`, undefined],
      ['Reservierung löschen',               'DELETE', `/api/reservierungen/${UNBEKANNT}`, undefined],
      ['Dienstplan-Schicht löschen',         'DELETE', `/api/dienstplan/${UNBEKANNT}`, undefined],
      ['Arbeitszeit löschen',                'DELETE', `/api/zeiterfassung/${UNBEKANNT}`, undefined],
      ['Lieferbestellung: Status',           'PATCH',  `/api/lieferbestellungen/${UNBEKANNT}`, { status: 'bestaetigt' }],
      ['Lieferbestellung: Drucken',          'POST',   `/api/lieferbestellungen/${UNBEKANNT}/drucken`, undefined],
      ['Umsatzbericht',                      'GET',    '/api/berichte/umsatz?von=2026-09-01&bis=2026-09-24', undefined],
      ['Tagesabschluss',                     'GET',    `/api/belege/tagesabschluss?kasseId=${UNBEKANNT}&datum=2026-09-24`, undefined],
    ] as const)('%s: 500 ohne interne Meldung, Einzelheiten im Log', async (_route, method, url, payload) => {
      const res = await srvOhneDb.fastify.inject({
        method, url, headers: srvOhneDb.authHeader(), ...(payload && { payload }),
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual(INTERN)
      expect(res.body).not.toMatch(INTERNE_DETAILS)
      expect(logOhneDb.mit('Unbehandelter Serverfehler')).toHaveLength(1)
    })

    it('Setup (öffentlich): Antwort im SetupResponse-Format, aber ohne Interna', async () => {
      const res = await srvOhneDb.fastify.inject({
        method: 'POST', url: '/api/setup',
        payload: {
          firmenname: 'Geheimsache 4711 GmbH', uid: 'ATU99999944', kassenId: 'RF-002', umgebung: 'test',
          admin: { name: 'X', email: 'x@route-fehler.at', passwort: 'route-fehler-passwort-2' },
        },
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toMatchObject({
        erfolgreich: false,
        fehler:      'Interner Serverfehler',
        schritte:    [{ status: 'fehler', meldung: 'Interner Serverfehler' }],
      })
      expect(res.body).not.toMatch(INTERNE_DETAILS)
      expect(logOhneDb.mit('Setup unerwartet fehlgeschlagen')[0]?.err?.message).toContain('Failed query')
    })

    it('Weitere Kasse anlegen: Antwort mit Schritten, aber ohne Interna', async () => {
      const res = await srvOhneDb.fastify.inject({
        method: 'POST', url: '/api/kassen', headers: srvOhneDb.authHeader(),
        payload: { kassenId: 'RF-003', umgebung: 'test' },
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toMatchObject({ erfolgreich: false, fehler: 'Interner Serverfehler' })
      expect(res.body).not.toMatch(INTERNE_DETAILS)
      expect(logOhneDb.mit('Kasse anlegen unerwartet fehlgeschlagen')).toHaveLength(1)
    })

    it('Artikel-Import: Zeile mit DB-Fehler steht ohne Interna in der Fehlerliste', async () => {
      const res = await srvOhneDb.fastify.inject({
        method: 'POST', url: '/api/artikel/bulk', headers: srvOhneDb.authHeader(),
        payload: [{ bezeichnung: 'Geheimsache 4711', preisBruttoCent: 350, mwstSatz: 'normal' }],
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        erstellt: 0, fehlgeschlagen: 1,
        fehlzeilen: [{ index: 0, fehler: 'Interner Serverfehler' }],
      })
      expect(logOhneDb.mit('Artikel-Import: Zeile unerwartet fehlgeschlagen')).toHaveLength(1)
    })
  })

  it('echte Constraint-Verletzung beim Dienstplan: 500 statt 404 mit SQL und Eingaben', async () => {
    // Test-Index, den keine Route vorab prüft — die zweite Schicht verletzt ihn
    await idb.db.execute(sql.raw('CREATE UNIQUE INDEX routefehler_schicht_user ON dienstplan_schichten (user_id)'))
    try {
      const [admin] = await idb.db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL))
      const anlegen = () => srv.fastify.inject({
        method: 'POST', url: '/api/dienstplan', headers: auth(),
        payload: {
          kasseId, userId: admin!.id, datum: '2026-10-01',
          beginnGeplant: '08:00', endeGeplant: '16:00', notiz: 'Geheimsache 4711',
        },
      })
      expect((await anlegen()).statusCode).toBe(201)

      const res = await anlegen()
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual(INTERN)
      expect(res.body).not.toMatch(INTERNE_DETAILS)
      expect(log.mit('Unbehandelter Serverfehler')[0]?.err?.message).toContain('insert into "dienstplan_schichten"')
    } finally {
      await idb.db.execute(sql.raw('DROP INDEX IF EXISTS routefehler_schicht_user'))
    }
  })

  // -------------------------------------------------------------------------
  // Gewollte Meldungen bleiben
  // -------------------------------------------------------------------------

  describe('Fachfehler der Services: Status + Meldung', () => {
    it.each([
      ['Reservierung löschen',          'DELETE', `/api/reservierungen/${UNBEKANNT}`,     404, 'Reservierung nicht gefunden'],
      ['Dienstplan-Schicht löschen',    'DELETE', `/api/dienstplan/${UNBEKANNT}`,         404, 'Schicht nicht gefunden'],
      ['Arbeitszeit löschen',           'DELETE', `/api/zeiterfassung/${UNBEKANNT}`,      404, 'Eintrag nicht gefunden'],
      ['Lieferbestellung: Status',      'PATCH',  `/api/lieferbestellungen/${UNBEKANNT}`, 404, 'Bestellung nicht gefunden'],
      ['Lieferbestellung: Drucken',     'POST',   `/api/lieferbestellungen/${UNBEKANNT}/drucken`, 404, 'Bestellung nicht gefunden'],
    ] as const)('%s: %i', async (_route, method, url, status, fehler) => {
      const res = await srv.fastify.inject({
        method, url, headers: auth(), ...(method === 'PATCH' && { payload: { status: 'bestaetigt' } }),
      })
      expect(res.statusCode).toBe(status)
      expect(res.json()).toEqual({ fehler })
      expect(log.mit('Unbehandelter Serverfehler')).toHaveLength(0)
    })

    it('Dienstplan für deaktivierten Benutzer: 409', async () => {
      const [inaktiv] = await idb.db.insert(users).values({
        mandantId, email: 'inaktiv@route-fehler.at', passwordHash: 'x', name: 'Inaktiv',
        rolle: 'kellner', berechtigungen: [], aktiv: false,
      }).returning({ id: users.id })
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/dienstplan', headers: auth(),
        payload: { kasseId, userId: inaktiv!.id, datum: '2026-10-02', beginnGeplant: '08:00', endeGeplant: '16:00' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ fehler: 'Benutzer ist deaktiviert' })
    })

    it('Stempeluhr (öffentlich): Modul aus → 403, falscher PIN → 401', async () => {
      const stempeln = () => srv.fastify.inject({
        method: 'POST', url: '/api/zeiterfassung/stempeln', payload: { kasseId, pin: '9999' },
      })
      const aus = await stempeln()
      expect(aus.statusCode).toBe(403)
      expect(aus.json()).toEqual({ fehler: 'Zeiterfassungs-Modul nicht aktiviert' })

      await idb.db.update(mandanten).set({ modulZeiterfassungAktiv: true }).where(eq(mandanten.id, mandantId))
      const falsch = await stempeln()
      expect(falsch.statusCode).toBe(401)
      expect(falsch.json().fehler).toMatch(/^PIN ungültig/)
    })

    it('Online-Buchung (öffentlich): nicht aktiviert → 403, unbekannter Token → 404', async () => {
      const buchen = await srv.fastify.inject({
        method: 'POST', url: `/api/buchung/${kasseId}`,
        payload: { datum: '2026-10-01', zeitVon: '19:00', personenAnzahl: 2, name: 'Gast' },
      })
      expect(buchen.statusCode).toBe(403)
      expect(buchen.json()).toEqual({ fehler: 'Online-Buchung nicht aktiviert' })

      const stornieren = await srv.fastify.inject({
        method: 'POST', url: `/api/buchung/${kasseId}/stornieren/${UNBEKANNT}`,
      })
      expect(stornieren.statusCode).toBe(404)
      expect(stornieren.json()).toEqual({ fehler: 'Reservierung nicht gefunden' })
    })
  })

  it('Drucker nicht erreichbar: Druckerfehler mit Grund statt 500', async () => {
    await idb.db.update(kassen)
      .set({ druckerAktiv: true, druckerIp: '127.0.0.1', druckerPort: 9, druckerTimeoutSek: 2 })
      .where(eq(kassen.id, kasseId))
    try {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/kassensturz/drucken', headers: auth(),
        payload: { kasseId, datum: '2026-09-24', istCent: 0, sollCent: 0, differenzCent: 0, stueck: [] },
      })
      expect(res.statusCode).toBe(502)
      expect(res.json().fehler).toMatch(/^Drucker-Fehler: .*ECONNREFUSED/)
      expect(log.mit('Unbehandelter Serverfehler')).toHaveLength(0)
    } finally {
      await idb.db.update(kassen).set({ druckerAktiv: false }).where(eq(kassen.id, kasseId))
    }
  })

  it('Mailserver nicht erreichbar: Meldung des Versands statt 500', async () => {
    const [startbeleg] = await idb.db.select({ id: belege.id }).from(belege).where(eq(belege.kasseId, kasseId)).limit(1)
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/belege/${startbeleg!.id}/email`, headers: auth(),
      payload: { empfaenger: 'gast@route-fehler.at' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().fehler).toMatch(/^E-Mail konnte nicht gesendet werden: .*ECONNREFUSED/)
    expect(log.mit('Unbehandelter Serverfehler')).toHaveLength(0)
  })

  it('FinanzOnline nicht erreichbar beim Nachtrag der Registrierung: 502 mit Grund', async () => {
    fo.kasseInBetriebNehmen.mockRejectedValueOnce(
      new FonSoapError('FinanzOnline login nicht erreichbar: Timeout nach 20000 ms'),
    )
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/fo-registrierung', headers: auth(),
      payload: { kasseId, credentials: { teilnehmerId: 'TID', benutzerkennung: 'BEN', pin: 'PIN' } },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ fehler: 'FinanzOnline login nicht erreichbar: Timeout nach 20000 ms' })
    expect(log.mit('Unbehandelter Serverfehler')).toHaveLength(0)
  })

  describe('A-Trust-Einheit nicht erreichbar', () => {
    const TOT = 'http://127.0.0.1:1'

    it('Verbindungstest: Testergebnis mit Grund', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasseId}/see/test`, headers: auth(),
        payload: { seeTyp: 'atrust_hsm', atrustBasisUrl: TOT, atrustBenutzer: 'u123456789', atrustPasswort: 'geheim' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ erfolgreich: false, fehler: expect.stringMatching(/^A-Trust \/(ZDA|Certificate) nicht erreichbar/) })
    })

    it('Wiederinbetriebnahme: 502 mit Grund, der Ausfall bleibt bestehen', async () => {
      await idb.db.update(kassen).set({
        seeTyp:             'atrust_hsm',
        atrustBasisUrl:     TOT,
        atrustBenutzer:     'u123456789',
        atrustPasswortEnc:  encryptPrivateKey(Buffer.from('geheim', 'utf8'), TEST_MASTER),
        seeAusgefallenSeit: new Date(),
      }).where(eq(kassen.id, kasseId))
      try {
        const res = await srv.fastify.inject({
          method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId },
        })
        expect(res.statusCode).toBe(502)
        expect(res.json()).toEqual({ fehler: expect.stringMatching(/^A-Trust \/Sign\/JWS nicht erreichbar/) })
        expect(log.mit('Unbehandelter Serverfehler')).toHaveLength(0)

        const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
        expect(kasse!.seeAusgefallenSeit).not.toBeNull()
      } finally {
        await idb.db.update(kassen)
          .set({ seeTyp: 'software', seeAusgefallenSeit: null })
          .where(eq(kassen.id, kasseId))
      }
    })
  })
})
