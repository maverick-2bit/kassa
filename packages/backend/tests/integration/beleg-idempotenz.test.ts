/**
 * Integrationstest: Idempotency-Key beim Verkauf (POST /api/belege/barzahlung) gegen echtes PostgreSQL.
 *
 * Hintergrund (Prüfbericht 2026-11, RKSV): Die Offline-Warteschlange der Kassa schickte einen Verkauf
 * erneut, sobald ein fetch scheiterte — auch wenn der Server ihn schon gebucht hatte und nur die
 * Antwort im WLAN verloren ging. Ergebnis: zwei signierte Belege für einen Verkauf. Mit dem Schlüssel
 * liefert die zweite Anfrage den gebuchten Beleg, ohne Lager, Kunde, Signatur oder Druck zu berühren.
 */

import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, kunden } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@idempotenz.at'
const ADMIN_PASSWORT = 'idempotenz-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Idempotenz GmbH',
  uid:        'ATU99999911',
  kassenId:   'ID-001',
  finanzOnline: { teilnehmerId: 'TID-ID', benutzerkennung: 'BID-ID', pin: 'PIN-ID' },
  umgebung: 'test',
  admin: { name: 'ID Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface ArtikelRow { id: string; lagerstandMenge: number | null }

describe('Verkauf mit Idempotency-Key (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let wasserId = ''   // 200 Cent, Lagerstand aktiv, Start 100

  const auth = () => ({ authorization: `Bearer ${token}` })

  function verkaufe(schluessel: string | undefined, menge = 1, extra: Record<string, unknown> = {}) {
    return srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung',
      headers: { ...auth(), ...(schluessel !== undefined && { 'idempotency-key': schluessel }) },
      payload: {
        kasseId,
        positionen: [{ artikelId: wasserId, menge }],
        zahlung: { barCent: menge * 200, karteCent: 0, sonstigeCent: 0 },
        ...extra,
      },
    })
  }

  async function anzahlBelege(): Promise<number> {
    const [r] = await idb.db.select({ n: count() }).from(belege).where(eq(belege.kasseId, kasseId))
    return Number(r?.n ?? 0)
  }

  async function bestand(): Promise<number | null> {
    const liste = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: auth() })
    return (liste.json() as ArtikelRow[]).find(a => a.id === wasserId)?.lagerstandMenge ?? null
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id

    const a = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Wasser', preisBruttoCent: 200, mwstSatz: 'normal', lagerstandAktiv: true, lagerstandMenge: 100 },
    })
    if (a.statusCode !== 201) throw new Error(`Artikel (${a.statusCode}): ${a.body}`)
    wasserId = a.json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('derselbe Verkauf zweimal: ein Beleg, die Wiederholung bekommt ihn mit 200 zurück, Lager einmal abgebucht', async () => {
    const schluessel = randomUUID()
    const vorher = await anzahlBelege()
    const lagerVorher = await bestand()

    const erst = await verkaufe(schluessel, 2)
    expect(erst.statusCode).toBe(201)
    expect(erst.headers['idempotent-replayed']).toBeUndefined()

    const nochmal = await verkaufe(schluessel, 2)
    expect(nochmal.statusCode).toBe(200)
    expect(nochmal.headers['idempotent-replayed']).toBe('true')
    expect(nochmal.json().id).toBe(erst.json().id)
    expect(nochmal.json().belegNummer).toBe(erst.json().belegNummer)
    expect(nochmal.json().maschinenlesbareCode).toBe(erst.json().maschinenlesbareCode)

    expect(await anzahlBelege()).toBe(vorher + 1)
    expect(await bestand()).toBe((lagerVorher ?? 0) - 2)
  })

  it('Schlüssel in Großbuchstaben zählt als derselbe Verkauf', async () => {
    const schluessel = randomUUID()
    const erst = await verkaufe(schluessel)
    const nochmal = await verkaufe(schluessel.toUpperCase())
    expect(erst.statusCode).toBe(201)
    expect(nochmal.statusCode).toBe(200)
    expect(nochmal.json().id).toBe(erst.json().id)
  })

  it('gleichzeitig zweimal derselbe Schlüssel: genau ein Beleg (die Kassen-Sperre serialisiert)', async () => {
    const schluessel = randomUUID()
    const vorher = await anzahlBelege()
    const [a, b] = await Promise.all([verkaufe(schluessel), verkaufe(schluessel)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
    expect(a.json().id).toBe(b.json().id)
    expect(await anzahlBelege()).toBe(vorher + 1)
  })

  it('Wiederholung mit neuem Kunden legt den Kunden nicht ein zweites Mal an', async () => {
    const schluessel = randomUUID()
    const neuerKunde = { firma: 'Doppel-Prüfung OG' }
    const kundenVorher = await idb.db.select({ id: kunden.id }).from(kunden).where(eq(kunden.firma, 'Doppel-Prüfung OG'))
    expect(kundenVorher).toHaveLength(0)

    expect((await verkaufe(schluessel, 1, { neuerKunde })).statusCode).toBe(201)
    expect((await verkaufe(schluessel, 1, { neuerKunde })).statusCode).toBe(200)

    const kundenNachher = await idb.db.select({ id: kunden.id }).from(kunden).where(eq(kunden.firma, 'Doppel-Prüfung OG'))
    expect(kundenNachher).toHaveLength(1)
  })

  it('verschiedene Schlüssel und Verkäufe ohne Schlüssel buchen wie bisher jeweils neu', async () => {
    const vorher = await anzahlBelege()
    expect((await verkaufe(randomUUID())).statusCode).toBe(201)
    expect((await verkaufe(randomUUID())).statusCode).toBe(201)
    expect((await verkaufe(undefined)).statusCode).toBe(201)
    expect((await verkaufe(undefined)).statusCode).toBe(201)
    expect(await anzahlBelege()).toBe(vorher + 4)
  })

  it('derselbe Schlüssel mit ANDEREM Warenkorb: 422, kein zweiter Beleg — und nie der alte Beleg als „Erfolg"', async () => {
    const schluessel = randomUUID()
    const vorher = await anzahlBelege()
    const erst = await verkaufe(schluessel, 1)
    expect(erst.statusCode).toBe(201)
    const anders = await verkaufe(schluessel, 3)
    expect(anders.statusCode).toBe(422)
    // Die Meldung nennt den gebuchten Beleg und warnt vor dem Neu-Kassieren (sonst zweiter Beleg)
    const fehler = anders.json().fehler as string
    expect(fehler).toContain(`schon gebucht (Beleg Nr. ${erst.json().belegNummer})`)
    expect(fehler).toContain('NICHT neu kassieren')
    expect(await anzahlBelege()).toBe(vorher + 1)
  })

  it('anderer Druckwunsch ist derselbe Verkauf (Fingerabdruck ohne keinAutodruck/Freigabe-PIN)', async () => {
    const schluessel = randomUUID()
    const erst = await verkaufe(schluessel, 1)
    const nochmal = await verkaufe(schluessel, 1, { keinAutodruck: true })
    expect(erst.statusCode).toBe(201)
    expect(nochmal.statusCode).toBe(200)
    expect(nochmal.json().id).toBe(erst.json().id)
  })

  it('ungültiger Schlüssel: 400, kein Beleg', async () => {
    const vorher = await anzahlBelege()
    const res = await verkaufe('kein-uuid')
    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toMatch(/Idempotency-Key/)
    expect(await anzahlBelege()).toBe(vorher)
  })

  it('ein abgelehnter Verkauf belegt den Schlüssel nicht: derselbe Schlüssel bucht danach normal', async () => {
    const schluessel = randomUUID()
    const vorher = await anzahlBelege()
    // Zahlung passt nicht zum Beleg → 400, Transaktion rollt zurück
    const falsch = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung',
      headers: { ...auth(), 'idempotency-key': schluessel },
      payload: { kasseId, positionen: [{ artikelId: wasserId, menge: 1 }], zahlung: { barCent: 1, karteCent: 0, sonstigeCent: 0 } },
    })
    expect(falsch.statusCode).toBe(400)
    expect(await anzahlBelege()).toBe(vorher)

    const richtig = await verkaufe(schluessel)
    expect(richtig.statusCode).toBe(201)
    expect(await anzahlBelege()).toBe(vorher + 1)
  })
})
