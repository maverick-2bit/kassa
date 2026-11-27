/**
 * Integrationstest (echtes PostgreSQL): Jede verkaufte Ware wird genau einmal vom Lager abgebucht — egal ob ein Bon
 * gedruckt wird.
 *
 *   - Direkt kassieren ohne Bonieren: auch Artikel MIT Station werden abgebucht (Speisen-Bar ohne Bon)
 *   - „Bonieren", dann kassieren: der Beleg verrechnet den Abzug der Bonierung (nichts doppelt — auch Artikel OHNE
 *     Station nicht mehr); mehr verkauft als boniert → der Rest wird abgebucht
 *   - eine Bonierung zählt nur einmal; unbekannte IDs ändern nichts
 *   - „Bonierbon auch bei Direktverkauf": der Beleg bucht ab, der Bon nur noch drucken
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { artikel, bonierLagerabzuege, kdsBons } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL = 'admin@lager-einmal.at', ADMIN_PASSWORT = 'lager-einmal-passwort-123'
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'LE-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Lagerstand: jede Ware genau einmal (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = ''
  const ids: Record<string, string> = {}

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = async (url: string, payload: unknown) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  type Pos = { artikelId: string; menge: number }
  const bonieren = async (bestellId: string, positionen: Pos[]) => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
      payload: { kasseId, kellner: 'Anna', positionen, bestellId },
    })
    expect([200, 207], res.body).toContain(res.statusCode)
  }
  const kassieren = async (positionen: Pos[], bonierungen?: string[]) => {
    const cent = positionen.reduce((s, p) => s + p.menge * 500, 0)
    await post('/api/belege/barzahlung', {
      kasseId, positionen, zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 }, ...(bonierungen && { bonierungen }),
    })
  }
  const bestand = async (id: string) => (await idb.db.select({ m: artikel.lagerstandMenge }).from(artikel).where(eq(artikel.id, id)))[0]!.m
  const bestaende = async () => ({
    bier: await bestand(ids.bier!), semmel: await bestand(ids.semmel!), fleisch: await bestand(ids.fleisch!), flag: await bestand(ids.flag!),
  })
  const setzeAlle = async () => {
    for (const k of ['bier', 'semmel', 'fleisch', 'flag']) await idb.db.update(artikel).set({ lagerstandMenge: 100 }).where(eq(artikel.id, ids[k]!))
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Lager Einmal GmbH', uid: 'ATU99999990', kassenId: 'LE-001',
        finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
        admin: { name: 'LE Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })).json()
    token = login.token
    kasseId = login.kassen[0].id

    // Browser-KDS (kein Drucker nötig): Schank und Küche
    const kds = await srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasseId}/kds`, headers: auth(), payload: { kdsAktiv: true, kdsStationen: {} } })
    expect(kds.statusCode, kds.body).toBe(200)

    const schank = (await post('/api/kategorien', { name: 'Getränke', farbe: 'blau', reihenfolge: 0, station: 'schank' })).id
    const kueche = (await post('/api/kategorien', { name: 'Speisen', farbe: 'rot', reihenfolge: 1, station: 'kueche' })).id
    const ohne   = (await post('/api/kategorien', { name: 'Gebäck', farbe: 'gelb', reihenfolge: 2 })).id
    const lager = { preisBruttoCent: 500, mwstSatz: 'normal', lagerstandAktiv: true, lagerstandMenge: 100 }
    ids.bier      = (await post('/api/artikel', { ...lager, bezeichnung: 'Bier', kategorieId: schank })).id
    ids.semmel    = (await post('/api/artikel', { ...lager, bezeichnung: 'Semmel', kategorieId: ohne })).id
    ids.fleisch   = (await post('/api/artikel', { ...lager, bezeichnung: 'Schnitzelfleisch', kategorieId: ohne, istBestandteil: true })).id
    ids.schnitzel = (await post('/api/artikel', {
      preisBruttoCent: 500, mwstSatz: 'normal', bezeichnung: 'Schnitzel', kategorieId: kueche,
      bestandteile: [{ bestandteilArtikelId: ids.fleisch, menge: 1 }],
    })).id
    ids.flag      = (await post('/api/artikel', { ...lager, bezeichnung: 'Spritzer', kategorieId: schank, bonierBeiDirektverkauf: true })).id
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('direkt kassiert ohne Bonieren: auch Artikel mit Station werden abgebucht (Speisen-Bar ohne Bon)', async () => {
    await setzeAlle()
    await kassieren([{ artikelId: ids.bier!, menge: 2 }, { artikelId: ids.semmel!, menge: 1 }, { artikelId: ids.schnitzel!, menge: 1 }])
    expect(await bestaende()).toMatchObject({ bier: 98, semmel: 99, fleisch: 99 })
  })

  it('„Bonieren", dann kassieren mit Verweis: genau einmal — auch Artikel ohne Station nicht doppelt', async () => {
    await setzeAlle()
    const korb = [{ artikelId: ids.bier!, menge: 2 }, { artikelId: ids.semmel!, menge: 1 }, { artikelId: ids.schnitzel!, menge: 1 }]
    await bonieren(ID(1), korb)
    expect(await bestaende()).toMatchObject({ bier: 98, semmel: 99, fleisch: 99 })
    const [abzug] = await idb.db.select().from(bonierLagerabzuege).where(eq(bonierLagerabzuege.bestellId, ID(1)))
    expect(abzug).toMatchObject({ verrechnetAm: null })

    await kassieren(korb, [ID(1)])
    expect(await bestaende()).toMatchObject({ bier: 98, semmel: 99, fleisch: 99 })
    const [danach] = await idb.db.select().from(bonierLagerabzuege).where(eq(bonierLagerabzuege.bestellId, ID(1)))
    expect(danach!.verrechnetAm).not.toBeNull()
  })

  it('nach dem Bonieren noch etwas dazu: der Beleg bucht genau den Rest ab', async () => {
    await setzeAlle()
    await bonieren(ID(2), [{ artikelId: ids.bier!, menge: 1 }])
    await kassieren([{ artikelId: ids.bier!, menge: 3 }], [ID(2)])
    expect(await bestand(ids.bier!)).toBe(97)
  })

  it('eine Bonierung zählt nur einmal; unbekannte IDs ändern nichts', async () => {
    await setzeAlle()
    await kassieren([{ artikelId: ids.bier!, menge: 1 }], [ID(2)])          // ID(2) ist schon verrechnet
    expect(await bestand(ids.bier!)).toBe(99)
    await kassieren([{ artikelId: ids.bier!, menge: 1 }], [ID(999)])        // nie boniert
    expect(await bestand(ids.bier!)).toBe(98)
  })

  it('„Bonierbon auch bei Direktverkauf": der Beleg bucht ab, der Bon druckt nur', async () => {
    await setzeAlle()
    const vorher = (await idb.db.select().from(kdsBons)).length
    await kassieren([{ artikelId: ids.flag!, menge: 2 }])
    // Der Bon kommt nach dem Beleg (fire-and-forget) — warten, bis er da ist
    for (let i = 0; i < 50 && (await idb.db.select().from(kdsBons)).length === vorher; i++) await new Promise(r => setTimeout(r, 50))
    expect((await idb.db.select().from(kdsBons)).length).toBeGreaterThan(vorher)
    expect(await bestand(ids.flag!)).toBe(98)
  })
})
