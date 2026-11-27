/**
 * Integrationstest (echtes PostgreSQL): Storno bucht den Lagerstand zurück — je nach Vorgabe und Auswahl.
 *
 *   - Vorgabe automatisch: Ware (ohne Rezeptur) zurück, Zubereitetes (Rezeptur) nicht
 *   - Auswahl im Dialog (lagerZurueck) gewinnt über die Vorgabe, auch „nichts zurück"
 *   - Vorgabe am Artikel (ja/nein) übersteuert die Automatik
 *   - Rezeptur: zurück heißt, die Rohstoffe kommen zurück
 *   - ältere Belege ohne Artikel-ID: Zuordnung über den Namen
 *   - Vorschau für den Dialog; Stornobeleg vermerkt die zurückgebuchten Positionen
 *   - ein abgewiesener Storno (schon storniert) ändert den Lagerstand nicht; Mandantentrennung
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { StornoLagerPosition } from '@kassa/shared'
import { artikel, belege } from '../../src/db/schema.js'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'storno-lager-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SL-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Storno → Lagerstand (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const tokens: Record<1 | 2, string> = { 1: '', 2: '' }
  const kassen: Record<1 | 2, string> = { 1: '', 2: '' }
  const ids: Record<string, string> = {}

  const kopf = (nr: 1 | 2 = 1) => ({ authorization: `Bearer ${tokens[nr]}` })
  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })
  const neuerArtikel = async (bezeichnung: string, extra: Record<string, unknown> = {}) => {
    const r = await inject('POST', '/api/artikel', kopf(), { bezeichnung, preisBruttoCent: 500, mwstSatz: 'normal', ...extra })
    expect(r.statusCode, r.body).toBe(201)
    return (r.json() as { id: string }).id
  }
  const verkaufe = async (positionen: { artikelId: string; menge: number }[]) => {
    const cent = positionen.reduce((s, p) => s + p.menge * 500, 0)
    const r = await inject('POST', '/api/belege/barzahlung', kopf(), { kasseId: kassen[1], positionen, zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 } })
    expect(r.statusCode, r.body).toBe(201)
    return (r.json() as { id: string }).id
  }
  const storno = (belegId: string, extra: Record<string, unknown> = {}) =>
    inject('POST', '/api/belege/storno', kopf(), { kasseId: kassen[1], verweisBelegId: belegId, ...extra })
  const bestand = async (id: string) => (await idb.db.select({ m: artikel.lagerstandMenge }).from(artikel).where(eq(artikel.id, id)))[0]!.m
  const setzeBestand = (id: string, m: number) => idb.db.update(artikel).set({ lagerstandMenge: m }).where(eq(artikel.id, id))

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2] as const) {
      const s = await srv.fastify.inject({
        method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN },
        payload: {
          firmenname: `Storno Lager ${nr} GmbH`, uid: `ATU9999998${nr}`, kassenId: `SL-00${nr}`, umgebung: 'test',
          finanzOnline: { teilnehmerId: `TID-SL-${nr}`, benutzerkennung: `BID-SL-${nr}`, pin: `PIN-SL-${nr}` },
          admin: { name: `SL Admin ${nr}`, email: `admin${nr}@storno-lager.at`, passwort: PASSWORT },
        },
      })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const l = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@storno-lager.at`, passwort: PASSWORT } })
      tokens[nr] = l.json().token
      kassen[nr] = l.json().kassen[0].id
    }
    const lager = { lagerstandAktiv: true, lagerstandMenge: 10 }
    ids.flasche     = await neuerArtikel('Flasche Bier', lager)
    ids.fleisch     = await neuerArtikel('Schnitzelfleisch', { ...lager, istBestandteil: true })
    ids.schnitzel   = await neuerArtikel('Wiener Schnitzel', { bestandteile: [{ bestandteilArtikelId: ids.fleisch, menge: 1 }] })
    ids.kaffee      = await neuerArtikel('Kaffee')
    ids.offen       = await neuerArtikel('Offener Wein', { ...lager, stornoLagerRueck: false })
    ids.spritzer    = await neuerArtikel('Spritzer', { stornoLagerRueck: true, bestandteile: [{ bestandteilArtikelId: ids.flasche, menge: 1 }] })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Vorschau: Ware zurück, Zubereitetes nicht, ohne Lager keine Wirkung, Vorgabe am Artikel gilt', async () => {
    const beleg = await verkaufe([
      { artikelId: ids.flasche, menge: 2 }, { artikelId: ids.schnitzel, menge: 1 }, { artikelId: ids.kaffee, menge: 1 },
      { artikelId: ids.offen, menge: 1 }, { artikelId: ids.spritzer, menge: 1 },
    ])
    const r = await inject('GET', `/api/belege/${beleg}/storno-lager?kasseId=${kassen[1]}`, kopf())
    expect(r.statusCode, r.body).toBe(200)
    const v = r.json() as StornoLagerPosition[]
    expect(v.map(p => [p.bezeichnung, p.wirkung, p.vorschlag])).toEqual([
      ['Flasche Bier', true, true],
      ['Wiener Schnitzel', true, false],
      ['Kaffee', false, false],
      ['Offener Wein', true, false],
      ['Spritzer', true, true],
    ])
    expect(v[1]!.grund).toMatch(/Rezeptur/)
    // aufräumen für die nächsten Tests: Storno mit „nichts zurück"
    expect((await storno(beleg, { lagerZurueck: [] })).statusCode).toBe(201)
  })

  it('Storno ohne Auswahl: Vorgabe — Flasche zurück, Schnitzelfleisch bleibt verbraucht; Stornobeleg vermerkt es', async () => {
    await setzeBestand(ids.flasche, 10); await setzeBestand(ids.fleisch, 10)
    const beleg = await verkaufe([{ artikelId: ids.flasche, menge: 2 }, { artikelId: ids.schnitzel, menge: 1 }])
    expect([await bestand(ids.flasche), await bestand(ids.fleisch)]).toEqual([8, 9])

    const r = await storno(beleg)
    expect(r.statusCode, r.body).toBe(201)
    expect([await bestand(ids.flasche), await bestand(ids.fleisch)]).toEqual([10, 9])

    const [st] = await idb.db.select({ positionen: belege.positionen }).from(belege).where(eq(belege.id, (r.json() as { id: string }).id))
    expect((st!.positionen as { lagerZurueck?: boolean }[]).map(p => p.lagerZurueck ?? false)).toEqual([true, false])
  })

  it('Auswahl im Dialog gewinnt: Schnitzel zurück (Rohstoffe), Flasche nicht', async () => {
    await setzeBestand(ids.flasche, 10); await setzeBestand(ids.fleisch, 10)
    const beleg = await verkaufe([{ artikelId: ids.flasche, menge: 3 }, { artikelId: ids.schnitzel, menge: 2 }])
    expect([await bestand(ids.flasche), await bestand(ids.fleisch)]).toEqual([7, 8])
    expect((await storno(beleg, { lagerZurueck: [1] })).statusCode).toBe(201)
    expect([await bestand(ids.flasche), await bestand(ids.fleisch)]).toEqual([7, 10])
  })

  it('Vorgabe am Artikel: „nein" bleibt draußen, „ja" holt auch Rezeptur-Rohstoffe zurück', async () => {
    await setzeBestand(ids.flasche, 10); await setzeBestand(ids.offen, 10)
    const beleg = await verkaufe([{ artikelId: ids.offen, menge: 1 }, { artikelId: ids.spritzer, menge: 2 }])
    expect([await bestand(ids.offen), await bestand(ids.flasche)]).toEqual([9, 8])
    expect((await storno(beleg)).statusCode).toBe(201)
    expect([await bestand(ids.offen), await bestand(ids.flasche)]).toEqual([9, 10])
  })

  it('älterer Beleg ohne Artikel-ID: Zuordnung über den Namen', async () => {
    await setzeBestand(ids.flasche, 10)
    const beleg = await verkaufe([{ artikelId: ids.flasche, menge: 4 }])
    await idb.db.execute(sql`UPDATE belege SET positionen = (SELECT jsonb_agg(p - 'artikelId') FROM jsonb_array_elements(positionen) p) WHERE id = ${beleg}`)
    expect(await bestand(ids.flasche)).toBe(6)
    expect((await storno(beleg)).statusCode).toBe(201)
    expect(await bestand(ids.flasche)).toBe(10)
  })

  it('zweiter Storno desselben Belegs wird abgewiesen und bucht nichts', async () => {
    await setzeBestand(ids.flasche, 10)
    const beleg = await verkaufe([{ artikelId: ids.flasche, menge: 1 }])
    expect((await storno(beleg)).statusCode).toBe(201)
    expect(await bestand(ids.flasche)).toBe(10)
    expect((await storno(beleg)).statusCode).toBe(409)
    expect(await bestand(ids.flasche)).toBe(10)
  })

  it('Vorschau: fremder Beleg 404, ungültige Angaben 400, ohne Anmeldung 401', async () => {
    const beleg = await verkaufe([{ artikelId: ids.flasche, menge: 1 }])
    expect((await inject('GET', `/api/belege/${beleg}/storno-lager?kasseId=${kassen[2]}`, kopf(2))).statusCode).toBe(404)
    // fremde Kasse: 404, die Kassa verrät nicht einmal, dass es sie gibt
    expect((await inject('GET', `/api/belege/${beleg}/storno-lager?kasseId=${kassen[1]}`, kopf(2))).statusCode).toBe(404)
    expect((await inject('GET', `/api/belege/x/storno-lager?kasseId=${kassen[1]}`, kopf())).statusCode).toBe(400)
    expect((await inject('GET', `/api/belege/${beleg}/storno-lager?kasseId=${kassen[1]}`, {})).statusCode).toBe(401)
  })
})
