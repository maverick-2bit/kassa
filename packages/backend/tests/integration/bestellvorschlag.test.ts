/**
 * Integrationstest (echtes PostgreSQL): Bestellvorschlag aus dem Verbrauch der letzten Tage.
 *
 *   - Verbrauch = Verkäufe − Stornos im Zeitraum, aus allen Kassen; ältere Belege außerhalb zählen nicht
 *   - Bestandteile: Verkauf eines Rezept-Artikels zählt als Verbrauch des Rohstoffs
 *   - ältere Belege ohne Artikel-ID werden über den (eindeutigen) Artikelnamen zugeordnet
 *   - unterwegs: gesendete Bestellungen (nicht Entwürfe) mindern den Vorschlag, Geliefertes nicht mehr
 *   - Mandantentrennung, Berechtigung
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { Bestellvorschlag, BestellvorschlagZeile } from '@kassa/shared'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'bestellvorschlag-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BV-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Bestellvorschlag (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const tokens: Record<1 | 2, string> = { 1: '', 2: '' }
  const kassen: Record<1 | 2, string> = { 1: '', 2: '' }
  let tokenKellner = ''
  let lieferant = ''
  const ids: Record<string, string> = {}

  const kopf = (nr: 1 | 2) => ({ authorization: `Bearer ${tokens[nr]}` })
  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })

  const neuerArtikel = async (nr: 1 | 2, bezeichnung: string, extra: Record<string, unknown> = {}) => {
    const r = await inject('POST', '/api/artikel', kopf(nr), { bezeichnung, preisBruttoCent: 300, mwstSatz: 'normal', ...extra })
    expect(r.statusCode, r.body).toBe(201)
    return (r.json() as { id: string }).id
  }
  const verkaufe = async (nr: 1 | 2, positionen: { artikelId: string; menge: number }[]) => {
    const cent = positionen.reduce((s, p) => s + p.menge * 300, 0)
    const r = await inject('POST', '/api/belege/barzahlung', kopf(nr), {
      kasseId: kassen[nr], positionen, zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 },
    })
    expect(r.statusCode, r.body).toBe(201)
    return (r.json() as { id: string }).id
  }
  const vorschlag = async (nr: 1 | 2 = 1, query = '') => {
    const r = await inject('GET', `/api/einkauf/bestellvorschlag${query}`, kopf(nr))
    expect(r.statusCode, r.body).toBe(200)
    return r.json() as Bestellvorschlag
  }
  const zeile = (v: Bestellvorschlag, id: string) => v.zeilen.find(z => z.artikelId === id) as BestellvorschlagZeile

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2] as const) {
      const s = await srv.fastify.inject({
        method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN },
        payload: {
          firmenname: `Vorschlag ${nr} GmbH`, uid: `ATU9999997${nr}`, kassenId: `BV-00${nr}`, umgebung: 'test',
          finanzOnline: { teilnehmerId: `TID-BV-${nr}`, benutzerkennung: `BID-BV-${nr}`, pin: `PIN-BV-${nr}` },
          admin: { name: `BV Admin ${nr}`, email: `admin${nr}@vorschlag.at`, passwort: PASSWORT },
        },
      })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const l = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@vorschlag.at`, passwort: PASSWORT } })
      tokens[nr] = l.json().token
      kassen[nr] = l.json().kassen[0].id
    }
    const k = await inject('POST', '/api/users', kopf(1), { name: 'Kellner', email: 'kellner@vorschlag.at', passwort: PASSWORT, rolle: 'kellner', berechtigungen: ['kasse'], kassenIds: [] })
    expect(k.statusCode, k.body).toBe(201)
    tokenKellner = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kellner@vorschlag.at', passwort: PASSWORT } })).json().token

    lieferant = (await inject('POST', '/api/lieferanten', kopf(1), { name: 'Getränke Huber' })).json().id
    const lager = { lagerstandAktiv: true, lieferantId: lieferant }
    ids.bier    = await neuerArtikel(1, 'Bier',    { ...lager, lagerstandMenge: 100, mindestbestand: 5 })
    ids.zitrone = await neuerArtikel(1, 'Zitrone', { ...lager, lagerstandMenge: 100, istBestandteil: true })
    ids.limo    = await neuerArtikel(1, 'Limo',    { bestandteile: [{ bestandteilArtikelId: ids.zitrone, menge: 2 }] })
    ids.wein    = await neuerArtikel(1, 'Wein',    { ...lager, lagerstandMenge: 100 })
    ids.ruhig   = await neuerArtikel(1, 'Ladenhüter', { ...lager, lagerstandMenge: 1, mindestbestand: 4 })
    ids.ohneLager = await neuerArtikel(1, 'Kaffee')
    ids.bierB   = await neuerArtikel(2, 'Bier', { lagerstandAktiv: true, lagerstandMenge: 100 })

    // Verkäufe im Zeitraum
    await verkaufe(1, [{ artikelId: ids.bier, menge: 10 }, { artikelId: ids.limo, menge: 3 }])
    await verkaufe(1, [{ artikelId: ids.bier, menge: 4 }])
    const storniert = await verkaufe(1, [{ artikelId: ids.bier, menge: 2 }])
    const st = await inject('POST', '/api/belege/storno', kopf(1), { kasseId: kassen[1], verweisBelegId: storniert })
    expect(st.statusCode, st.body).toBe(201)
    // Außerhalb des Zeitraums: 20 Tage alt
    const alt = await verkaufe(1, [{ artikelId: ids.bier, menge: 50 }])
    await idb.db.execute(sql`UPDATE belege SET beleg_datum = now() - interval '20 days' WHERE id = ${alt}`)
    // Älterer Beleg ohne Artikel-ID (vor der Umstellung): nur der Name steht drin
    const ohneId = await verkaufe(1, [{ artikelId: ids.wein, menge: 7 }])
    await idb.db.execute(sql`UPDATE belege SET positionen = (SELECT jsonb_agg(p - 'artikelId') FROM jsonb_array_elements(positionen) p) WHERE id = ${ohneId}`)
    // Anderer Mandant, gleicher Name
    await verkaufe(2, [{ artikelId: ids.bierB, menge: 30 }])
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('jede neue Belegposition trägt die Artikel-ID, auch die Stornoposition', async () => {
    const rows = await idb.db.execute<{ beleg_typ: string; artikel_id: string | null }>(sql`
      SELECT beleg_typ, pos->>'artikelId' AS artikel_id FROM belege, jsonb_array_elements(positionen) pos
      WHERE pos->>'artikelName' IN ('Bier', 'Storno: Bier') AND mandant_id = (SELECT mandant_id FROM kassen WHERE id = ${kassen[1]})`)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.artikel_id === ids.bier)).toBe(true)
    expect(rows.some(r => r.beleg_typ === 'Stornobeleg')).toBe(true)
  })

  it('Verbrauch der letzten 14 Tage: Verkäufe minus Stornos, Älteres zählt nicht', async () => {
    const v = await vorschlag()
    expect(v).toMatchObject({ tage: 14, reichweite: 14 })
    // 10 + 4 + 2 − 2 (Storno) = 14; der 20 Tage alte Beleg mit 50 zählt nicht
    expect(zeile(v, ids.bier)).toMatchObject({ verbrauch: 14, verbrauchProTag: 1, bedarf: 14, bestand: 100 - 66, unterwegs: 0, mindestbestand: 5 })
    // Bestand 34 reicht: 14 + 5 − 34 < 0
    expect(zeile(v, ids.bier).vorschlag).toBe(0)
  })

  it('Bestandteile: 3 Limo à 2 Zitronen = 6 Zitronen Verbrauch', async () => {
    expect(zeile(await vorschlag(), ids.zitrone)).toMatchObject({ verbrauch: 6 })
  })

  it('ältere Positionen ohne Artikel-ID zählen über den Namen', async () => {
    expect(zeile(await vorschlag(), ids.wein)).toMatchObject({ verbrauch: 7 })
  })

  it('nur Lagerartikel; ohne Verbrauch wird nur bis zum Mindestbestand aufgefüllt', async () => {
    const v = await vorschlag()
    expect(v.zeilen.find(z => z.artikelId === ids.ohneLager)).toBeUndefined()
    expect(v.zeilen.find(z => z.artikelId === ids.limo)).toBeUndefined()
    expect(zeile(v, ids.ruhig)).toMatchObject({ verbrauch: 0, reichtTage: null, vorschlag: 3 })
  })

  it('Reichweite und Rückblick lassen sich einstellen', async () => {
    // Bestand Bier auf 0: für 28 Tage bei 1/Tag → 28 + Mindestbestand 5
    await idb.db.execute(sql`UPDATE artikel SET lagerstand_menge = 0 WHERE id = ${ids.bier}`)
    expect(zeile(await vorschlag(1, '?reichweite=28'), ids.bier)).toMatchObject({ bedarf: 28, vorschlag: 33 })
    expect(zeile(await vorschlag(1, '?tage=7&reichweite=7'), ids.bier)).toMatchObject({ verbrauch: 14, verbrauchProTag: 2, bedarf: 14, vorschlag: 19 })
    expect((await inject('GET', '/api/einkauf/bestellvorschlag?tage=0', kopf(1))).statusCode).toBe(400)
  })

  it('unterwegs: gesendete Bestellung mindert den Vorschlag, ein Entwurf nicht, Geliefertes nicht mehr', async () => {
    const vorher = zeile(await vorschlag(), ids.bier).vorschlag   // Bestand 0: 14 + 5 = 19
    expect(vorher).toBe(19)

    const entwurf = await inject('POST', '/api/einkauf/bestellungen', kopf(1), {
      lieferantId: lieferant, positionen: [{ artikelId: ids.bier, bezeichnung: 'Bier', menge: 12 }],
    })
    expect(entwurf.statusCode, entwurf.body).toBe(201)
    expect(zeile(await vorschlag(), ids.bier)).toMatchObject({ unterwegs: 0, vorschlag: 19 })

    const id = (entwurf.json() as { id: string }).id
    const gesendet = await inject('POST', `/api/einkauf/bestellungen/${id}/status`, kopf(1), { status: 'gesendet' })
    expect(gesendet.statusCode, gesendet.body).toBe(200)
    expect(zeile(await vorschlag(), ids.bier)).toMatchObject({ unterwegs: 12, vorschlag: 7 })

    // 5 davon geliefert (Teillieferung): noch 7 unterwegs
    await idb.db.execute(sql`UPDATE einkauf_bestellpositionen SET geliefert_menge = 5 WHERE bestellung_id = ${id}`)
    expect(zeile(await vorschlag(), ids.bier)).toMatchObject({ unterwegs: 7 })
  })

  it('Mandantentrennung: der andere Betrieb sieht nur seinen Verbrauch', async () => {
    const b = await vorschlag(2)
    expect(b.zeilen.map(z => z.artikelId)).toEqual([ids.bierB])
    expect(zeile(b, ids.bierB)).toMatchObject({ verbrauch: 30 })
    // und umgekehrt: die 30 Bier des anderen Betriebs zählen bei uns nicht
    expect(zeile(await vorschlag(1), ids.bier).verbrauch).toBe(14)
  })

  it('nur mit dem Recht „Artikel verwalten"', async () => {
    expect((await inject('GET', '/api/einkauf/bestellvorschlag', { authorization: `Bearer ${tokenKellner}` })).statusCode).toBe(403)
    expect((await inject('GET', '/api/einkauf/bestellvorschlag', {})).statusCode).toBe(401)
  })
})
