/**
 * Integrationstest: Automatischer Tagesabschluss (Cron-Kernlogik + Route).
 *
 * Die Kernfunktion fuehreFaelligeAutoAbschluesseDurch wird mit einem FESTEN
 * `jetzt` aufgerufen — deterministisch, kein Warten auf Wanduhrzeiten. SMTP ist
 * nicht konfiguriert (isEmailAktiv=false) → der E-Mail-Versand bleibt bewusst
 * aus; geprüft werden Fälligkeit, Abschlusstag-Logik, Ruhetag-Überspringen,
 * Idempotenz-Stempel, offene-Tische-Zählung und die Einstellungs-Route.
 *
 * Zeitkonstruktion: `${heuteWien}T20:00:00Z` ist in Wien 21:00 (Winter) bzw.
 * 22:00 (Sommer) — immer Abend DESSELBEN Kalendertags. Mit Uhrzeit '13:00'
 * ist der Abschluss damit ganzjährig fällig und der Abschlusstag = heute.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { Config } from '../../src/config.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen } from '../../src/db/schema.js'
import { fuehreFaelligeAutoAbschluesseDurch, wienJetzt, bestimmeAbschlussTag } from '../../src/services/auto-abschluss.service.js'

const ADMIN_EMAIL    = 'admin@auto-abschluss.at'
const ADMIN_PASSWORT = 'auto-abschluss-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'AA-PW' }),
  } as unknown as FinanzOnlineClient
}

// SMTP absichtlich nicht konfiguriert → isEmailAktiv() false, kein Versand
const config = {} as unknown as Config

describe('Automatischer Tagesabschluss (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let heuteWien: string
  let abendHeute: Date   // fester Abend-Zeitpunkt des heutigen Wien-Tags
  let morgenFrueh: Date  // fester Vormittag (Wien 09/10 Uhr) des heutigen Tags

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'AutoAbschluss GmbH',
        uid:        'ATU99999905',
        kassenId:   'AA-001',
        finanzOnline: { teilnehmerId: 'TID-AA', benutzerkennung: 'BID-AA', pin: 'PIN-AA' },
        umgebung: 'test',
        admin: { name: 'AA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    heuteWien   = wienJetzt(new Date()).datum
    abendHeute  = new Date(`${heuteWien}T20:00:00Z`)
    morgenFrueh = new Date(`${heuteWien}T08:00:00Z`)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('bestimmeAbschlussTag: vor 12:00 Vortag, ab 12:00 derselbe Tag', () => {
    expect(bestimmeAbschlussTag('04:00', '2026-07-26')).toBe('2026-07-25')
    expect(bestimmeAbschlussTag('11:59', '2026-03-01')).toBe('2026-02-28')
    expect(bestimmeAbschlussTag('12:00', '2026-07-26')).toBe('2026-07-26')
    expect(bestimmeAbschlussTag('23:30', '2026-01-01')).toBe('2026-01-01')
  })

  it('Route: Uhrzeit setzen + lesen; ungültige Uhrzeit → 400', async () => {
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/abschluss-email`, headers: auth(),
      payload: { abschlussEmail: 'chef@auto-abschluss.at', autoAbschlussUhrzeit: '13:00' },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toEqual({ abschlussEmail: 'chef@auto-abschluss.at', autoAbschlussUhrzeit: '13:00' })

    const get = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/abschluss-email`, headers: auth(),
    })
    expect(get.json().autoAbschlussUhrzeit).toBe('13:00')

    const invalid = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/abschluss-email`, headers: auth(),
      payload: { autoAbschlussUhrzeit: '25:99' },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('Ruhetag (keine Belege): wird ohne E-Mail übersprungen, aber gestempelt', async () => {
    const ergebnisse = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, abendHeute)
    expect(ergebnisse).toHaveLength(1)
    expect(ergebnisse[0]).toMatchObject({
      tag: heuteWien, anzahlBelege: 0, emailGesendet: false, uebersprungen: 'keine-belege',
    })

    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    expect(kasse!.letzterAutoAbschlussTag).toBe(heuteWien)
  })

  it('Uhrzeit-Änderung setzt den Idempotenz-Stempel zurück', async () => {
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/abschluss-email`, headers: auth(),
      payload: { autoAbschlussUhrzeit: '13:00' },
    })
    expect(patch.statusCode).toBe(200)
    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    expect(kasse!.letzterAutoAbschlussTag).toBeNull()
  })

  it('mit Belegen + offenem Tisch: Abschluss läuft durch und zählt beides', async () => {
    // Zwei Belege heute + ein offener Tisch
    for (const cent of [1200, 800]) {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
        payload: {
          kasseId,
          positionen: [{ bezeichnung: 'Menü', preisBruttoCent: cent, mwstSatz: 'normal', menge: 1 }],
          zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 },
        },
      })
      expect(res.statusCode).toBe(201)
    }
    const tab = await srv.fastify.inject({
      method: 'POST', url: '/api/tisch-tabs', headers: auth(),
      payload: { kasseId, tischNummer: 'AA-Tisch 1', kellner: 'AA Admin' },
    })
    expect(tab.statusCode).toBe(201)

    const ergebnisse = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, abendHeute)
    expect(ergebnisse).toHaveLength(1)
    expect(ergebnisse[0]).toMatchObject({
      tag:           heuteWien,
      anzahlBelege:  2,
      offeneTische:  1,
      emailGesendet: false, // SMTP im Test nicht konfiguriert
      uebersprungen: null,
    })
  })

  it('Idempotenz: zweiter Lauf am selben Tag tut nichts', async () => {
    const ergebnisse = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, abendHeute)
    expect(ergebnisse).toHaveLength(0)
  })

  it('vor der konfigurierten Uhrzeit ist nichts fällig', async () => {
    await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/abschluss-email`, headers: auth(),
      payload: { autoAbschlussUhrzeit: '23:59' }, // Stempel-Reset + späte Uhrzeit
    })
    const ergebnisse = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, morgenFrueh)
    expect(ergebnisse).toHaveLength(0)
  })

  it('Uhrzeit null schaltet den Auto-Abschluss ab', async () => {
    await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/abschluss-email`, headers: auth(),
      payload: { autoAbschlussUhrzeit: null },
    })
    const ergebnisse = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, abendHeute)
    expect(ergebnisse).toHaveLength(0)
  })
})
