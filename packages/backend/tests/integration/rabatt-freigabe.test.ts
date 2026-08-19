/**
 * Integrationstest: Rabatt-Freigabe (Vier-Augen-Prinzip, Schritt 2).
 *
 * Ohne sie ist die Storno-Freigabe wertlos: statt 80 € zu stornieren gibt der
 * Kellner 100 % Rabatt — gleicher Effekt, kein PIN. Geprüft werden beide
 * Schwellen (Prozent ODER Betrag), beide Wege (Kasse-Beleg und Tisch-Bezahlen
 * inkl. Positionsrabatten, die zu Preis-Overrides werden) und der Kern: der
 * Kellner kann sich nicht selbst freigeben.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { auditLogs, users } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@rabatt-freigabe.at'
const ADMIN_PASSWORT = 'rabatt-freigabe-passwort-123'
const CHEF_PIN       = '1379'
const KELLNER_PIN    = '2468'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'RF-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Rabatt-Freigabe (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function setzeSchwellen(input: { prozent?: number; cent?: number }) {
    const res = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/freigaben', headers: auth(),
      payload: {
        rabattFreigabeAbProzent: input.prozent ?? 0,
        rabattFreigabeAbCent:    input.cent ?? 0,
      },
    })
    expect(res.statusCode).toBe(200)
  }

  /** Barzahlung 100 € mit Rabatt — Zahlung passend zum Restbetrag. */
  const barzahlungMitRabatt = (
    rabatt: { typ: 'prozent'; prozent: number } | { typ: 'betrag'; betragCent: number },
    freigabePin?: string,
  ) => {
    const nachlass = rabatt.typ === 'prozent' ? Math.round(10000 * rabatt.prozent / 100) : rabatt.betragCent
    return srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Menü', preisBruttoCent: 10000, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 10000 - nachlass, karteCent: 0, sonstigeCent: 0 },
        rabatt,
        ...(freigabePin ? { freigabePin } : {}),
      },
    })
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Rabatt GmbH',
        uid:        'ATU99999925',
        kassenId:   'RF-001',
        finanzOnline: { teilnehmerId: 'TID-RF', benutzerkennung: 'BID-RF', pin: 'PIN-RF' },
        umgebung: 'test',
        admin: { name: 'RF Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    kasseId   = login.kassen[0].id
    mandantId = login.mandant.id

    await idb.db.update(users)
      .set({ pinHash: bcrypt.hashSync(CHEF_PIN, 10) })
      .where(eq(users.email, ADMIN_EMAIL))

    await idb.db.insert(users).values({
      mandantId,
      email:          'kellner@rabatt-freigabe.at',
      passwordHash:   bcrypt.hashSync('egal-egal-123', 10),
      pinHash:        bcrypt.hashSync(KELLNER_PIN, 10),
      name:           'Kellner ohne Recht',
      rolle:          'kellner',
      berechtigungen: ['tische', 'kasse'],
    })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('ohne Schwellen (0/0) bleibt sogar 100 % Rabatt frei — Bestandsverhalten', async () => {
    await setzeSchwellen({})
    expect((await barzahlungMitRabatt({ typ: 'prozent', prozent: 100 })).statusCode).toBe(201)
  })

  it('Prozent-Schwelle: 50 % Rabatt ohne PIN → 403 mit Code, 10 % bleiben frei', async () => {
    await setzeSchwellen({ prozent: 20 })
    const zuViel = await barzahlungMitRabatt({ typ: 'prozent', prozent: 50 })
    expect(zuViel.statusCode).toBe(403)
    expect(zuViel.json().code).toBe('freigabe_erforderlich')

    expect((await barzahlungMitRabatt({ typ: 'prozent', prozent: 10 })).statusCode).toBe(201)
  })

  it('Betrags-Schwelle: 20 € Nachlass ohne PIN → 403, 5 € bleiben frei', async () => {
    await setzeSchwellen({ cent: 1000 })
    expect((await barzahlungMitRabatt({ typ: 'betrag', betragCent: 2000 })).statusCode).toBe(403)
    expect((await barzahlungMitRabatt({ typ: 'betrag', betragCent: 500 })).statusCode).toBe(201)
  })

  it('der Kellner kann sich NICHT selbst freigeben', async () => {
    await setzeSchwellen({ prozent: 20 })
    const res = await barzahlungMitRabatt({ typ: 'prozent', prozent: 100 }, KELLNER_PIN)
    expect(res.statusCode).toBe(403)
  })

  it('mit Chef-PIN geht der Rabatt durch und wird protokolliert', async () => {
    await setzeSchwellen({ prozent: 20 })
    const res = await barzahlungMitRabatt({ typ: 'prozent', prozent: 50 }, CHEF_PIN)
    expect(res.statusCode).toBe(201)

    await vi.waitFor(async () => {
      const eintraege = await idb.db.select().from(auditLogs).where(eq(auditLogs.aktion, 'rabatt.freigegeben'))
      expect(eintraege.length).toBeGreaterThanOrEqual(1)
      const details = eintraege.at(-1)!.details as Record<string, unknown>
      expect(details['nachlassCent']).toBe(5000)
      expect(details['freigeberName']).toBe('RF Admin')
    })
  })

  it('abgelehnter Rabatt erzeugt KEINEN Beleg', async () => {
    await setzeSchwellen({ prozent: 20 })
    const vorher = (await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}`, headers: auth(),
    })).json().length
    expect((await barzahlungMitRabatt({ typ: 'prozent', prozent: 99 })).statusCode).toBe(403)
    const nachher = (await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}`, headers: auth(),
    })).json().length
    expect(nachher).toBe(vorher)
  })

  // ---------------------------------------------------------------------------
  // Tisch-Bezahlen: Positionsrabatte werden zu Preis-Overrides — die Schwelle
  // muss sie trotzdem sehen
  // ---------------------------------------------------------------------------

  describe('Tisch-Bezahlen', () => {
    async function offenerTisch(preisCent: number): Promise<string> {
      // Echter Artikel — bezahleTab reicht die artikelId an den Beleg-Service
      // durch, und der validiert sie gegen den Artikelstamm.
      const artikel = (await srv.fastify.inject({
        method: 'POST', url: '/api/artikel', headers: auth(),
        payload: { bezeichnung: `Steak ${preisCent}-${Math.random().toString(36).slice(2, 6)}`, preisBruttoCent: preisCent, mwstSatz: 'normal' },
      })).json()
      const tab = (await srv.fastify.inject({
        method: 'POST', url: '/api/tisch-tabs', headers: auth(),
        payload: { kasseId, tischNummer: `RF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kellner: 'Karl' },
      })).json()
      const put = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tab.id}/positionen`, headers: auth(),
        payload: { positionen: [{ artikelId: artikel.id, bezeichnung: artikel.bezeichnung, preisBruttoCent: preisCent, menge: 1 }] },
      })
      expect(put.statusCode).toBe(200)
      return tab.id
    }

    const bezahle = (tabId: string, body: Record<string, unknown>) =>
      srv.fastify.inject({
        method: 'POST', url: `/api/tisch-tabs/${tabId}/bezahlen`, headers: auth(), payload: body,
      })

    it('Positionsrabatt auf 0 € über der Schwelle → 403; mit Chef-PIN → 201', async () => {
      await setzeSchwellen({ prozent: 20 })
      const tabId = await offenerTisch(8000)

      // Position 80 € → 0 € = 100 % Nachlass, als Preis-Override getarnt
      const abgelehnt = await bezahle(tabId, {
        zahlung: { barCent: 0, karteCent: 0, sonstigeCent: 0 },
        positionRabatte: [{ positionIndex: 0, einzelpreisBreuttoCent: 0 }],
      })
      expect(abgelehnt.statusCode).toBe(403)
      expect(abgelehnt.json().code).toBe('freigabe_erforderlich')

      // Tab muss offen geblieben sein
      const tab = (await srv.fastify.inject({
        method: 'GET', url: `/api/tisch-tabs/${tabId}`, headers: auth(),
      })).json()
      expect(tab.status).toBe('offen')

      const erlaubt = await bezahle(tabId, {
        zahlung: { barCent: 0, karteCent: 0, sonstigeCent: 0 },
        positionRabatte: [{ positionIndex: 0, einzelpreisBreuttoCent: 0 }],
        freigabePin: CHEF_PIN,
      })
      expect(erlaubt.statusCode).toBe(200)
    })

    it('normales Bezahlen ohne Rabatt bleibt PIN-frei', async () => {
      await setzeSchwellen({ prozent: 20, cent: 100 })
      const tabId = await offenerTisch(4200)
      const res = await bezahle(tabId, { zahlung: { barCent: 4200, karteCent: 0, sonstigeCent: 0 } })
      expect(res.statusCode).toBe(200)
      await setzeSchwellen({})
    })
  })
})
