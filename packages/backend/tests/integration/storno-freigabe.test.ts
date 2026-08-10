/**
 * Integrationstest: Storno-Freigabe (Vier-Augen-Prinzip).
 *
 * Storno-Missbrauch ist im Gastro-Betrieb der klassische Schwundkanal: Ware
 * kassiert, danach storniert, Bargeld bleibt in der Tasche. Ab einer
 * einstellbaren Schwelle muss deshalb jemand mit Freigabe-Recht seinen PIN
 * geben. Der springende Punkt ist die letzte Prüfung: der Kellner darf sich
 * NICHT selbst freigeben.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import type { BelegResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { auditLogs, mandanten, users } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@storno-freigabe.at'
const ADMIN_PASSWORT = 'storno-freigabe-passwort-123'
const CHEF_PIN       = '1379'
const KELLNER_PIN    = '2468'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SF-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Freigabe GmbH',
  uid:        'ATU99999922',
  kassenId:   'SF-001',
  finanzOnline: { teilnehmerId: 'TID-SF', benutzerkennung: 'BID-SF', pin: 'PIN-SF' },
  umgebung: 'test',
  admin: { name: 'SF Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Storno-Freigabe (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function setzeSchwelle(cent: number) {
    const res = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/freigaben', headers: auth(),
      payload: { stornoFreigabeAbCent: cent },
    })
    expect(res.statusCode).toBe(200)
  }

  async function verkaufe(betragCent: number): Promise<BelegResponse> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Artikel', preisBruttoCent: betragCent, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: betragCent, karteCent: 0, sonstigeCent: 0 },
      },
    })
    if (res.statusCode !== 201) throw new Error(`Verkauf (${res.statusCode}): ${res.body}`)
    return res.json() as BelegResponse
  }

  const storniere = (belegId: string, freigabePin?: string) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(),
      payload: { kasseId, verweisBelegId: belegId, grund: 'Test', ...(freigabePin ? { freigabePin } : {}) },
    })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    kasseId   = login.kassen[0].id
    mandantId = login.mandant.id

    // Chef-PIN am Admin
    await idb.db.update(users)
      .set({ pinHash: bcrypt.hashSync(CHEF_PIN, 10) })
      .where(eq(users.email, ADMIN_EMAIL))

    // Kellner MIT PIN, aber OHNE Freigabe-Recht
    await idb.db.insert(users).values({
      mandantId,
      email:          'kellner@storno-freigabe.at',
      passwordHash:   bcrypt.hashSync('egal-egal-123', 10),
      pinHash:        bcrypt.hashSync(KELLNER_PIN, 10),
      name:           'Kellner ohne Recht',
      rolle:          'kellner',
      berechtigungen: ['tische', 'kasse', 'belege.stornieren'],
    })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('ohne Schwelle (0) bleibt der Storno wie bisher frei', async () => {
    await setzeSchwelle(0)
    const beleg = await verkaufe(9900)
    expect((await storniere(beleg.id)).statusCode).toBe(201)
  })

  it('unter der Schwelle braucht es keine Freigabe', async () => {
    await setzeSchwelle(5000)          // ab 50 €
    const beleg = await verkaufe(4999) // 49,99 €
    expect((await storniere(beleg.id)).statusCode).toBe(201)
  })

  it('ab der Schwelle ohne PIN: 403 mit maschinenlesbarem Code', async () => {
    await setzeSchwelle(5000)
    const beleg = await verkaufe(5000) // genau 50 € — die Schwelle greift bereits
    const res = await storniere(beleg.id)
    expect(res.statusCode).toBe(403)
    // Die Oberfläche erkennt daran, dass sie den PIN-Dialog öffnen muss.
    expect(res.json().code).toBe('freigabe_erforderlich')
    expect(res.json().abCent).toBe(5000)
  })

  it('falscher PIN gibt nicht frei', async () => {
    await setzeSchwelle(5000)
    const beleg = await verkaufe(7500)
    expect((await storniere(beleg.id, '0000')).statusCode).toBe(403)
  })

  it('der Kellner kann sich NICHT selbst freigeben', async () => {
    // Der Kern des Ganzen: der PIN ist gültig, aber ohne Freigabe-Recht zählt er
    // nicht. Sonst wäre die Kontrolle wertlos.
    await setzeSchwelle(5000)
    const beleg = await verkaufe(8000)
    const res = await storniere(beleg.id, KELLNER_PIN)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('freigabe_erforderlich')
  })

  it('mit Chef-PIN geht der Storno durch und wird protokolliert', async () => {
    await setzeSchwelle(5000)
    const beleg = await verkaufe(12000)
    const res = await storniere(beleg.id, CHEF_PIN)
    expect(res.statusCode).toBe(201)

    // Das Audit läuft bewusst NACH dem Senden der Antwort (nicht blockierend) —
    // deshalb hier auf den Eintrag warten statt sofort abzufragen.
    await vi.waitFor(async () => {
      const eintraege = await idb.db.select().from(auditLogs).where(eq(auditLogs.aktion, 'storno.freigegeben'))
      expect(eintraege.length).toBeGreaterThanOrEqual(1)
      const details = eintraege.at(-1)!.details as Record<string, unknown>
      expect(details['verweisBelegId']).toBe(beleg.id)
      expect(details['freigeberName']).toBe('SF Admin')
    })
  })

  // -------------------------------------------------------------------------
  // Positions-Storno am offenen Tisch (v0.7.150)
  // -------------------------------------------------------------------------

  describe('Positions-Storno am Tisch', () => {
    async function tischMit(betragCent: number, tisch: string): Promise<{ tabId: string; positionen: unknown[] }> {
      const tab = (await srv.fastify.inject({
        method: 'POST', url: '/api/tisch-tabs', headers: auth(),
        payload: { kasseId, tischNummer: tisch, kellner: 'Karl' },
      })).json()
      const positionen = [{ artikelId: crypto.randomUUID(), bezeichnung: 'Menü', preisBruttoCent: betragCent, menge: 1 }]
      const put = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tab.id}/positionen`, headers: auth(),
        payload: { positionen },
      })
      expect(put.statusCode).toBe(200)
      return { tabId: tab.id, positionen }
    }

    it('Reduzieren über der Schwelle: 403 ohne PIN, 200 mit Chef-PIN — nichts geht verloren', async () => {
      await setzeSchwelle(5000)
      const { tabId } = await tischMit(8000, 'F1')

      // Position entfernen (Storno 80 €) ohne PIN → abgelehnt, Tab UNVERÄNDERT
      const ohne = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
        payload: { positionen: [] },
      })
      expect(ohne.statusCode).toBe(403)
      expect(ohne.json().code).toBe('freigabe_erforderlich')

      const danach = (await srv.fastify.inject({
        method: 'GET', url: `/api/tisch-tabs/${tabId}`, headers: auth(),
      })).json()
      expect(danach.positionen).toHaveLength(1)   // Ablehnung hat NICHTS geschrieben

      // Mit Chef-PIN geht es durch
      const mit = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
        payload: { positionen: [], freigabePin: CHEF_PIN },
      })
      expect(mit.statusCode).toBe(200)
    })

    it('unter der Schwelle bleibt die Korrektur PIN-frei', async () => {
      await setzeSchwelle(5000)
      const { tabId } = await tischMit(3000, 'F2')
      const res = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
        payload: { positionen: [] },
      })
      expect(res.statusCode).toBe(200)
    })

    it('Hinzufügen ist nie freigabepflichtig — nur Reduzieren', async () => {
      await setzeSchwelle(100)   // absurd niedrig: JEDER Storno wäre pflichtig
      const { tabId, positionen } = await tischMit(9000, 'F3')
      const mehr = await srv.fastify.inject({
        method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
        payload: { positionen: [...positionen, { artikelId: crypto.randomUUID(), bezeichnung: 'Noch eins', preisBruttoCent: 9000, menge: 1 }] },
      })
      expect(mehr.statusCode).toBe(200)
    })

    it('Verwerfen des ganzen Tabs unterliegt derselben Schwelle', async () => {
      // Sonst würde man die Positions-Freigabe umgehen, indem man statt der
      // Position einfach den ganzen Tab verwirft.
      await setzeSchwelle(5000)
      const { tabId } = await tischMit(7000, 'F4')

      const ohne = await srv.fastify.inject({
        method: 'POST', url: `/api/tisch-tabs/${tabId}/verwerfen`, headers: auth(), payload: {},
      })
      expect(ohne.statusCode).toBe(403)
      expect(ohne.json().code).toBe('freigabe_erforderlich')

      const mit = await srv.fastify.inject({
        method: 'POST', url: `/api/tisch-tabs/${tabId}/verwerfen`, headers: auth(),
        payload: { freigabePin: CHEF_PIN, grund: 'Test' },
      })
      expect(mit.statusCode).toBe(200)
      expect(mit.json().status).toBe('verworfen')
    })
  })

  it('die Schwelle darf nur mit Einstellungs-Recht gesetzt werden', async () => {
    const kellnerToken = srv.signTestToken({
      mandantId, rolle: 'kellner', berechtigungen: ['kasse', 'belege.stornieren'],
    })
    const res = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/freigaben',
      headers: { authorization: `Bearer ${kellnerToken}` },
      payload: { stornoFreigabeAbCent: 0 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('die Schwelle ist über GET abrufbar', async () => {
    await setzeSchwelle(2500)
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/mandanten/freigaben', headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().stornoFreigabeAbCent).toBe(2500)
    // Aufräumen für nachfolgende Läufe im selben File
    await idb.db.update(mandanten).set({ stornoFreigabeAbCent: 0 }).where(eq(mandanten.id, mandantId))
  })
})
