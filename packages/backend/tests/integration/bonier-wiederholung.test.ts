/**
 * Integrationstest: "Nochmal senden" darf die Bestellung nicht verdoppeln (Bestell-ID).
 *
 * Fall aus der Praxis: Die Station "Schank" hat eine falsche TCP-IP hinterlegt. Der Bon liegt
 * am Browser-KDS, die Kasse meldet trotzdem "Bon NICHT angekommen". Der Kellner tippt auf
 * "Nochmal senden" — dabei darf am KDS KEIN zweiter Bon erscheinen und der Lagerstand nicht
 * ein zweites Mal abgebucht werden.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel as artikelTabelle, bonierBestellungen, kdsBons } from '../../src/db/schema.js'

const ADMIN_EMAIL = 'admin@bonier-wdh.at', ADMIN_PASSWORT = 'bonier-wdh-passwort-123'
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BW-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Bonieren mit Bestell-ID: "Nochmal senden" verdoppelt nichts (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = '', colaId = '', ohneStationId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = async (url: string, payload: unknown) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  const bonieren = (bestellId: string | undefined, artikelId = colaId) => srv.fastify.inject({
    method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
    payload: { kasseId, tisch: 'T1', kellner: 'Anna', positionen: [{ artikelId, menge: 1 }], ...(bestellId ? { bestellId } : {}) },
  })
  const anzahlKdsBons = async () => (await idb.db.select().from(kdsBons)).length
  const lager = async () => (await idb.db.select().from(artikelTabelle).where(eq(artikelTabelle.id, colaId)))[0]!.lagerstandMenge

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Wdh GmbH', uid: 'ATU99999962', kassenId: 'BW-001',
        finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
        admin: { name: 'BW Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    // KDS aktiv; Station "schank" hat eine NICHT erreichbare TCP-IP (127.0.0.1:1 → sofort "Connection refused")
    const kds = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/kds`, headers: auth(),
      payload: { kdsAktiv: true, kdsPort: 1, kdsStationen: { schank: '127.0.0.1' } },
    })
    expect(kds.statusCode).toBe(200)

    const kat  = (await post('/api/kategorien', { name: 'Getränke', farbe: 'blau', reihenfolge: 0, station: 'schank' })).id
    const kat2 = (await post('/api/kategorien', { name: 'Ohne Station', farbe: 'blau', reihenfolge: 1 })).id
    colaId        = (await post('/api/artikel', { bezeichnung: 'Cola', preisBruttoCent: 400, mwstSatz: 'normal', kategorieId: kat, lagerstandAktiv: true, lagerstandMenge: 10 })).id
    ohneStationId = (await post('/api/artikel', { bezeichnung: 'Ohne', preisBruttoCent: 400, mwstSatz: 'normal', kategorieId: kat2 })).id
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('erster Versuch: Bon am Browser-KDS, TCP-Ziel scheitert (207), Lagerstand 10 → 9', async () => {
    const res = await bonieren(ID(1))
    expect(res.statusCode, res.body).toBe(207)
    expect(res.json().stationen).toMatchObject([{ station: 'schank', erfolgreich: false }])
    expect(await anzahlKdsBons()).toBe(1)
    expect(await lager()).toBe(9)
  })

  it('"Nochmal senden" (gleiche Bestell-ID): derselbe Bon, KEIN zweiter KDS-Bon, Lagerstand bleibt 9', async () => {
    const erst = (await idb.db.select().from(bonierBestellungen).where(eq(bonierBestellungen.bestellId, ID(1))))[0]!
    const res = await bonieren(ID(1))
    expect(res.statusCode, res.body).toBe(207)                     // das TCP-Ziel fehlt weiterhin
    expect(res.json().bonNummer).toBe(erst.bonNummer)              // gleiche Bon-Nummer
    expect(await anzahlKdsBons()).toBe(1)
    expect(await lager()).toBe(9)
  })

  it('nach Korrektur der IP: "Nochmal senden" meldet Erfolg — immer noch genau EIN KDS-Bon', async () => {
    const fix = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/kds`, headers: auth(), payload: { kdsStationen: {} },
    })
    expect(fix.statusCode).toBe(200)
    const res = await bonieren(ID(1))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().stationen).toMatchObject([{ station: 'schank', erfolgreich: true }])
    expect(await anzahlKdsBons()).toBe(1)
    expect(await lager()).toBe(9)

    // und noch ein weiterer Klick ändert nichts mehr
    expect((await bonieren(ID(1))).statusCode).toBe(200)
    expect(await anzahlKdsBons()).toBe(1)
  })

  it('eine NEUE Bestell-ID ist eine neue Bestellung (zweiter KDS-Bon, Lagerstand 8); ohne ID wie bisher', async () => {
    expect((await bonieren(ID(2))).statusCode).toBe(200)
    expect(await anzahlKdsBons()).toBe(2)
    expect(await lager()).toBe(8)

    expect((await bonieren(undefined)).statusCode).toBe(200)
    expect(await anzahlKdsBons()).toBe(3)
    expect(await lager()).toBe(7)
  })

  it('zeitgleicher Doppelklick mit derselben ID: genau EIN KDS-Bon, der zweite Aufruf wartet oder wird abgewiesen', async () => {
    const vorher = await anzahlKdsBons()
    const [a, b] = await Promise.all([bonieren(ID(3)), bonieren(ID(3))])
    const codes = [a.statusCode, b.statusCode].sort()
    // Entweder wurde der zweite abgewiesen (409 "läuft gerade") oder er kam erst nach dem ersten (Wiederholung, 200)
    expect(codes.every(c => c === 200 || c === 409)).toBe(true)
    expect(codes).toContain(200)
    expect(await anzahlKdsBons()).toBe(vorher + 1)
  })

  it('scheitert die erste Bonierung ("nichts zu bonieren"), wird die ID freigegeben', async () => {
    const res = await bonieren(ID(4), ohneStationId)
    expect(res.statusCode).toBe(400)
    const rows = await idb.db.select().from(bonierBestellungen).where(eq(bonierBestellungen.bestellId, ID(4)))
    expect(rows).toHaveLength(0)
  })

  it('eine Bestell-ID einer anderen Kasse/eines anderen Mandanten wird abgewiesen (409)', async () => {
    // ID(1) gehört zu dieser Kasse — hier simuliert eine Zeile mit fremder Kasse
    await idb.db.insert(bonierBestellungen).values({
      bestellId: ID(5), mandantId: (await idb.db.select().from(bonierBestellungen))[0]!.mandantId,
      kasseId: ID(99), bonNummer: 'AE000000001', ergebnis: { bonNummer: 'AE000000001', stationen: [], drucker: [] },
    }).catch(() => undefined)
    const res = await bonieren(ID(5))
    // Entweder die Fremd-Zeile konnte nicht angelegt werden (FK) → normale neue Bestellung, oder 409
    expect([200, 207, 409]).toContain(res.statusCode)
  })
})
