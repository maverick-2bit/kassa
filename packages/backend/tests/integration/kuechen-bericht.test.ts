/**
 * Integrationstest: Küchen-Bericht (KDS-Durchlaufzeiten).
 *
 * Bons werden mit künstlichen erstellt/erledigt-Zeiten direkt eingefügt —
 * geprüft werden Ø/Median/Max je Station, die Artikel-Aggregation aus dem
 * positionen-jsonb, der Stunden-Verlauf, der offene-Bons-Zähler sowie dass
 * kdsBonErledigt den neuen erledigtAt-Stempel setzt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kdsBons } from '../../src/db/schema.js'
import { kdsBonErledigt } from '../../src/services/kds/kds-store.service.js'

const ADMIN_EMAIL    = 'admin@kuechen-bericht.at'
const ADMIN_PASSWORT = 'kuechen-bericht-passwort-1'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KB-PW' }),
  } as unknown as FinanzOnlineClient
}

describe('Küchen-Bericht (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let mandantId: string
  let heuteWien: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  /** Bon mit fixer Dauer (Minuten) einfügen; basisUtc hält den Wien-Tag stabil. */
  async function bonEinfuegen(station: string, dauerMinuten: number | null, positionen: Array<{ bezeichnung: string; menge: number }>) {
    const erstellt = new Date(`${heuteWien}T08:00:00Z`) // Wien 09/10 Uhr — immer „heute"
    await idb.db.insert(kdsBons).values({
      mandantId,
      bonNummer: `KB-${Math.random().toString(36).slice(2, 8)}`,
      station,
      tisch:    'T1',
      kellner:  'KB Admin',
      positionen: positionen.map((p, i) => ({ id: `p${i}`, bezeichnung: p.bezeichnung, menge: p.menge, erledigt: dauerMinuten != null })),
      status:     dauerMinuten != null ? 'erledigt' : 'offen',
      erstelltAt: erstellt,
      ...(dauerMinuten != null && { erledigtAt: new Date(erstellt.getTime() + dauerMinuten * 60_000) }),
    })
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'KuechenBericht GmbH',
        uid:        'ATU99999906',
        kassenId:   'KB-001',
        finanzOnline: { teilnehmerId: 'TID-KB', benutzerkennung: 'BID-KB', pin: 'PIN-KB' },
        umgebung: 'test',
        admin: { name: 'KB Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    mandantId = login.mandant.id
    heuteWien = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Vienna' })

    // Küche: 10 + 20 min (Ø 15, Median 15, Max 20); Schank: 5 min; 1 offener Küchen-Bon
    await bonEinfuegen('kueche', 10, [{ bezeichnung: 'Suppe', menge: 1 }, { bezeichnung: 'Steak', menge: 2 }])
    await bonEinfuegen('kueche', 20, [{ bezeichnung: 'Suppe', menge: 3 }])
    await bonEinfuegen('schank', 5,  [{ bezeichnung: 'Bier',  menge: 2 }])
    await bonEinfuegen('kueche', null, [{ bezeichnung: 'Salat', menge: 1 }])
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('aggregiert Ø/Median/Max je Station und zählt offene Bons', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/berichte/kueche?von=${heuteWien}&bis=${heuteWien}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const b = res.json()

    expect(b.gesamtBons).toBe(3)
    expect(b.offeneBons).toBe(1)

    const kueche = b.stationen.find((s: { station: string }) => s.station === 'kueche')
    expect(kueche).toMatchObject({ anzahlBons: 2, avgMinuten: 15, medianMinuten: 15, maxMinuten: 20 })
    const schank = b.stationen.find((s: { station: string }) => s.station === 'schank')
    expect(schank).toMatchObject({ anzahlBons: 1, avgMinuten: 5 })

    // Gewichteter Gesamt-Ø: (15*2 + 5*1) / 3 = 11.7
    expect(b.avgMinutenGesamt).toBeCloseTo(11.7, 1)
  })

  it('aggregiert Artikel aus dem positionen-jsonb (Menge summiert, Bon-Ø)', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/berichte/kueche?von=${heuteWien}&bis=${heuteWien}`, headers: auth(),
    })
    const b = res.json()

    const suppe = b.topArtikel.find((a: { bezeichnung: string }) => a.bezeichnung === 'Suppe')
    expect(suppe).toMatchObject({ anzahl: 4, avgMinuten: 15 }) // 1+3 Stück über Bons mit 10/20 min
    const steak = b.topArtikel.find((a: { bezeichnung: string }) => a.bezeichnung === 'Steak')
    expect(steak).toMatchObject({ anzahl: 2, avgMinuten: 10 })
    // Offener Salat-Bon zählt nicht in die Artikel-Statistik
    expect(b.topArtikel.some((a: { bezeichnung: string }) => a.bezeichnung === 'Salat')).toBe(false)

    // Stunden-Verlauf enthält alle 4 Bons (auch den offenen)
    const summeStunden = b.stunden.reduce((s: number, z: { anzahlBons: number }) => s + z.anzahlBons, 0)
    expect(summeStunden).toBe(4)
  })

  it('kdsBonErledigt stempelt erledigtAt', async () => {
    const [offener] = await idb.db.select().from(kdsBons)
      .where(eq(kdsBons.status, 'offen'))
    expect(offener).toBeTruthy()
    expect(offener!.erledigtAt).toBeNull()

    const ok = await kdsBonErledigt(idb.db, offener!.id, mandantId)
    expect(ok).toBe(true)

    const [erledigt] = await idb.db.select().from(kdsBons).where(eq(kdsBons.id, offener!.id))
    expect(erledigt!.status).toBe('erledigt')
    expect(erledigt!.erledigtAt).toBeInstanceOf(Date)
  })

  it('lehnt von > bis mit 400 ab', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/berichte/kueche?von=2026-07-10&bis=2026-07-01`, headers: auth(),
    })
    expect(res.statusCode).toBe(400)
  })
})
