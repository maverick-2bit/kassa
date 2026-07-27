/**
 * Integrationstest: Positions-Storno + Tab-Verwerfen (Wunschliste Punkt 5).
 *
 * Ein Fake-Bonierdrucker (net.createServer) empfängt die Storno-Bons. Geprüft:
 * Reduktion über PUT /positionen → Storno-Ereignis + Audit-Eintrag + Storno-Bon
 * mit „*** STORNO ***"-Markierung an den Bonierdrucker des Artikels;
 * POST /verwerfen → Status 'verworfen', Tab raus aus der offenen Liste,
 * Storno-Bon für alle Positionen, Lagerstand zurückgebucht.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { desc, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel, auditLogs, bonierdrucker, tabEreignisse } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@tab-storno.at'
const ADMIN_PASSWORT = 'tab-storno-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'TS-PW' }),
  } as unknown as FinanzOnlineClient
}

describe('Tab-Storno + Verwerfen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let schnitzelId: string
  let fakeDrucker: net.Server
  let empfangen: Buffer[] = []

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Tab-Storno GmbH',
        uid:        'ATU99999909',
        kassenId:   'TS-001',
        finanzOnline: { teilnehmerId: 'TID-TS', benutzerkennung: 'BID-TS', pin: 'PIN-TS' },
        umgebung: 'test',
        admin: { name: 'TS Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id
    const mandantId = login.mandant.id

    // Fake-Bonierdrucker + Artikel, der auf ihn geroutet wird
    fakeDrucker = net.createServer((sock) => { sock.on('data', (c) => empfangen.push(c)) })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    const port = (fakeDrucker.address() as net.AddressInfo).port

    const [d] = await idb.db.insert(bonierdrucker).values({
      mandantId, name: 'Küche (Fake)', ip: '127.0.0.1', port,
    }).returning()

    const [a] = await idb.db.insert(artikel).values({
      mandantId,
      bezeichnung: 'Schnitzel',
      preisBruttoCent: 1450,
      mwstSatz: 'ermaessigt1',
      bonierdruckerId: d!.id,
      lagerstandAktiv: true,
      lagerstandMenge: 20,
    }).returning()
    schnitzelId = a!.id
  })

  afterAll(async () => {
    await new Promise<void>((res) => fakeDrucker.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  async function erstelleTabMit(menge: number, tisch: string): Promise<string> {
    const tab = (await srv.fastify.inject({
      method: 'POST', url: '/api/tisch-tabs', headers: auth(),
      payload: { kasseId, tischNummer: tisch, kellner: 'Kellner Karl' },
    })).json()
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tab.id}/positionen`, headers: auth(),
      payload: { positionen: [{ artikelId: schnitzelId, bezeichnung: 'Schnitzel', preisBruttoCent: 1450, menge }] },
    })
    expect(put.statusCode).toBe(200)
    return tab.id
  }

  it('Reduktion → Storno-Ereignis, Audit-Eintrag und STORNO-Bon am Küchendrucker', async () => {
    const tabId = await erstelleTabMit(3, 'T1')
    empfangen = []

    // 3 → 1 (Storno von 2)
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(),
      payload: { positionen: [{ artikelId: schnitzelId, bezeichnung: 'Schnitzel', preisBruttoCent: 1450, menge: 1 }] },
    })
    expect(put.statusCode).toBe(200)

    // Storno-Bon kam als ESC/POS mit unübersehbarer Markierung an
    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const bon = Buffer.concat(empfangen).toString('latin1')
    expect(bon).toContain('*** STORNO ***')
    expect(bon).toContain('NICHT ZUBEREITEN')
    expect(bon).toContain('2x Schnitzel')

    // Verlaufs-Ereignis 'storno' mit Menge + Verursacher
    const ereignisse = await idb.db.select().from(tabEreignisse)
      .where(eq(tabEreignisse.tabId, tabId)).orderBy(desc(tabEreignisse.createdAt))
    const storno = ereignisse.find(e => e.typ === 'storno')
    expect(storno).toBeTruthy()
    expect((storno!.details as { positionen: Array<{ menge: number }> }).positionen[0]!.menge).toBe(2)
    expect((storno!.details as { durch?: string }).durch).toBe('TS Admin')

    // Audit-Protokoll (wer/was)
    const [audit] = await idb.db.select().from(auditLogs)
      .where(eq(auditLogs.aktion, 'tab.position_storno'))
      .orderBy(desc(auditLogs.createdAt)).limit(1)
    expect(audit).toBeTruthy()
    expect((audit!.details as { tisch: string }).tisch).toBe('T1')
  })

  it('Verwerfen → Status verworfen, raus aus offener Liste, Storno-Bon, Lager zurück', async () => {
    const tabId = await erstelleTabMit(2, 'T2')
    const [vorher] = await idb.db.select({ m: artikel.lagerstandMenge }).from(artikel).where(eq(artikel.id, schnitzelId))
    empfangen = []

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/verwerfen`, headers: auth(),
      payload: { grund: 'Gast gegangen' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('verworfen')

    // Nicht mehr in der offenen Liste
    const offene = (await srv.fastify.inject({
      method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}`, headers: auth(),
    })).json()
    expect(offene.some((t: { id: string }) => t.id === tabId)).toBe(false)

    // Storno-Bon für die kompletten Positionen
    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const bon = Buffer.concat(empfangen).toString('latin1')
    expect(bon).toContain('*** STORNO ***')
    expect(bon).toContain('2x Schnitzel')

    // Verlaufs-Ereignis inkl. Grund + Lagerstand zurückgebucht (+2)
    const ereignisse = await idb.db.select().from(tabEreignisse)
      .where(eq(tabEreignisse.tabId, tabId)).orderBy(desc(tabEreignisse.createdAt))
    const verworfen = ereignisse.find(e => e.typ === 'verworfen')
    expect((verworfen!.details as { grund?: string }).grund).toBe('Gast gegangen')

    const [nachher] = await idb.db.select({ m: artikel.lagerstandMenge }).from(artikel).where(eq(artikel.id, schnitzelId))
    expect(nachher!.m).toBe((vorher!.m ?? 0) + 2)
  })

  it('Verwerfen eines bezahlten Tabs → 409', async () => {
    const tabId = await erstelleTabMit(1, 'T3')
    const bez = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/bezahlen`, headers: auth(),
      payload: { zahlung: { barCent: 1450, karteCent: 0, sonstigeCent: 0 } },
    })
    expect(bez.statusCode).toBe(200)

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/verwerfen`, headers: auth(), payload: {},
    })
    expect(res.statusCode).toBe(409)
  })
})
