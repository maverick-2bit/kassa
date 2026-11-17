/**
 * Integrationstest (echtes PostgreSQL, Migration 0085): EAN als Artikelkennzeichnung.
 *
 *  - Prüfziffer/Länge werden geprüft (400), die EAN ist je Mandant eindeutig (409 mit Artikelname) —
 *    auch gegen deaktivierte Artikel und über den GTIN-14-Schlüssel (UPC-A 12- = 13-stellig);
 *    ein anderer Mandant darf dieselbe EAN führen.
 *  - Der Verkauf schreibt die EAN als Schnappschuss in die Belegposition (Bon, öffentlicher Beleg,
 *    Storno); spätere Änderungen am Artikel ändern den Beleg nicht.
 *  - Migration 0085 bereinigt Altbestand: Leerwerte → NULL, bei Dubletten behält der aktive bzw.
 *    älteste Artikel die EAN, dann greift der eindeutige Index.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel, mandanten } from '../../src/db/schema.js'

const PASSWORT = 'artikel-ean-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: 1 | 2) {
  return {
    firmenname: `EAN Test ${nr} GmbH`,
    uid:        `ATU9999996${nr}`,
    kassenId:   `EAN-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-EAN-${nr}`, benutzerkennung: `BID-EAN-${nr}`, pin: `PIN-EAN-${nr}` },
    umgebung: 'test',
    admin: { name: `EAN Admin ${nr}`, email: `admin${nr}@eantest.at`, passwort: PASSWORT },
  }
}

interface ArtikelRow { id: string; bezeichnung: string; ean: string | null; aktiv: boolean }
interface BelegRow { id: string; positionen: { bezeichnung: string; ean?: string }[] }

describe('EAN als Artikelkennzeichnung (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = '', kasseA = ''
  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })

  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: { authorization: string } | Record<string, never>, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })
  const neuerArtikel = (auth: () => { authorization: string }, bezeichnung: string, ean: string | null) =>
    inject('POST', '/api/artikel', auth(), { bezeichnung, preisBruttoCent: 199, mwstSatz: 'ermaessigt1', ean })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2] as const) {
      const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: setupInput(nr) })
      if (setupRes.statusCode !== 201) throw new Error(`Setup ${nr} (${setupRes.statusCode}): ${setupRes.body}`)
      const login = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@eantest.at`, passwort: PASSWORT } })
      if (login.statusCode !== 200) throw new Error(`Login ${nr} (${login.statusCode}): ${login.body}`)
      if (nr === 1) { tokenA = login.json().token; kasseA = login.json().kassen[0].id } else tokenB = login.json().token
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('gültige EAN wird getrimmt gespeichert; falsche Prüfziffer oder Länge → 400', async () => {
    const ok = await neuerArtikel(authA, 'Vollmilch', ' 9002490100070 ')
    expect(ok.statusCode, ok.body).toBe(201)
    expect((ok.json() as ArtikelRow).ean).toBe('9002490100070')

    expect((await neuerArtikel(authA, 'Tippfehler', '9002490100071')).statusCode).toBe(400)
    expect((await neuerArtikel(authA, 'Zu kurz', '9001')).statusCode).toBe(400)
    expect((await neuerArtikel(authA, 'Buchstaben', '90024901000AB')).statusCode).toBe(400)
  })

  it('dieselbe EAN ein zweites Mal → 409 mit dem Namen des Artikels; ein anderer Mandant darf sie führen', async () => {
    const doppelt = await neuerArtikel(authA, 'Milch Kopie', '9002490100070')
    expect(doppelt.statusCode).toBe(409)
    expect(doppelt.json().fehler).toContain('„Vollmilch"')

    expect((await neuerArtikel(authB, 'Vollmilch bei B', '9002490100070')).statusCode).toBe(201)
  })

  it('UPC-A 12-stellig und 13-stellig mit führender Null gelten als dieselbe EAN', async () => {
    expect((await neuerArtikel(authA, 'Erdnussbutter', '012345678905')).statusCode).toBe(201)
    const res = await neuerArtikel(authA, 'Erdnussbutter Kopie', '0012345678905')
    expect(res.statusCode).toBe(409)
    expect(res.json().fehler).toContain('Erdnussbutter')
  })

  it('Bearbeiten: eigene EAN bleibt speicherbar; fremde → 409, auch wenn deren Artikel deaktiviert ist; nach dem Leeren frei', async () => {
    const tee = (await neuerArtikel(authA, 'Tee', '4006381333931')).json() as ArtikelRow
    const kaffee = (await neuerArtikel(authA, 'Kaffee', null)).json() as ArtikelRow

    const selbst = await inject('PUT', `/api/artikel/${tee.id}`, authA(), { bezeichnung: 'Tee grün', ean: '4006381333931' })
    expect(selbst.statusCode, selbst.body).toBe(200)

    expect((await inject('PUT', `/api/artikel/${kaffee.id}`, authA(), { ean: '4006381333931' })).statusCode).toBe(409)

    expect((await inject('DELETE', `/api/artikel/${tee.id}`, authA())).statusCode).toBeLessThan(300)
    const gegenDeaktiviert = await inject('PUT', `/api/artikel/${kaffee.id}`, authA(), { ean: '4006381333931' })
    expect(gegenDeaktiviert.statusCode).toBe(409)
    expect(gegenDeaktiviert.json().fehler).toContain('(deaktiviert)')

    expect((await inject('PUT', `/api/artikel/${tee.id}`, authA(), { ean: null })).statusCode).toBe(200)
    const frei = await inject('PUT', `/api/artikel/${kaffee.id}`, authA(), { ean: '4006381333931' })
    expect(frei.statusCode, frei.body).toBe(200)
    expect((frei.json() as ArtikelRow).ean).toBe('4006381333931')
  })

  it('Bulk-Import: Zeile mit vergebener oder ungültiger EAN scheitert einzeln mit lesbarer Meldung', async () => {
    const zeile = (bezeichnung: string, ean: string) => ({ bezeichnung, preisBruttoCent: 100, mwstSatz: 'normal', ean })
    const res = await inject('POST', '/api/artikel/bulk', authA(), [
      zeile('Bulk neu', '96385074'), zeile('Bulk doppelt', '9002490100070'), zeile('Bulk kaputt', '96385075'),
    ])
    expect(res.statusCode).toBe(200)
    const body = res.json() as { erstellt: number; fehlzeilen: { index: number; fehler: string }[] }
    expect(body.erstellt).toBe(1)
    expect(body.fehlzeilen.map(f => f.index)).toEqual([1, 2])
    expect(body.fehlzeilen[0]!.fehler).toContain('Vollmilch')
    expect(body.fehlzeilen[1]!.fehler).toContain('Prüfziffer')
  })

  it('Verkauf: Position trägt die EAN (Schnappschuss) — auch öffentlicher Beleg und Storno; Artikeländerung später ändert den Beleg nicht', async () => {
    const saft = (await neuerArtikel(authA, 'Apfelsaft', '2000000000015')).json() as ArtikelRow
    const verkauf = await inject('POST', '/api/belege/barzahlung', authA(), {
      kasseId: kasseA, positionen: [{ artikelId: saft.id, menge: 2 }], zahlung: { barCent: 398, karteCent: 0, sonstigeCent: 0 },
    })
    expect(verkauf.statusCode, verkauf.body).toBe(201)
    const beleg = verkauf.json() as BelegRow
    expect(beleg.positionen[0]).toMatchObject({ bezeichnung: 'Apfelsaft', ean: '2000000000015' })

    await inject('PUT', `/api/artikel/${saft.id}`, authA(), { ean: null })

    const oeffentlich = await srv.fastify.inject({ method: 'GET', url: `/api/oeffentlich/beleg/${beleg.id}` })
    expect(oeffentlich.statusCode, oeffentlich.body).toBe(200)
    expect((oeffentlich.json() as { beleg: BelegRow }).beleg.positionen[0]).toMatchObject({ ean: '2000000000015' })

    const storno = await inject('POST', '/api/belege/storno', authA(), { kasseId: kasseA, verweisBelegId: beleg.id, grund: 'EAN-Test' })
    expect(storno.statusCode, storno.body).toBe(201)
    expect((storno.json() as BelegRow).positionen[0]).toMatchObject({ bezeichnung: 'Storno: Apfelsaft', ean: '2000000000015' })
  })

  it('Migration 0085 bereinigt Altbestand: Leerwerte → NULL, Dublette bleibt beim aktiven bzw. ältesten Artikel', async () => {
    const [m] = await idb.db.select({ id: mandanten.id }).from(mandanten).where(eq(mandanten.firmenname, 'EAN Test 2 GmbH'))
    const mandantId = m!.id
    // Zustand vor 0085 herstellen: ohne Index, Dubletten und Leerwerte wie aus der Zeit ohne Prüfung
    await idb.db.execute(sql`DROP INDEX "artikel_mandant_ean_idx"`)
    const alt = (bezeichnung: string, ean: string, aktiv: boolean, tag: number) => ({
      mandantId, bezeichnung, preisBruttoCent: 100, mwstSatz: 'normal', artikelnummer: `ALT-${bezeichnung}`, ean, aktiv,
      createdAt: new Date(Date.UTC(2026, 0, tag)),
    })
    const ids = await idb.db.insert(artikel).values([
      alt('inaktiv-alt', '4006381333931', false, 1),
      alt('aktiv-jung', '4006381333931', true, 5),
      alt('aktiv-alt-upc', '012345678905', true, 2),
      alt('aktiv-jung-upc', '0012345678905', true, 3),
      alt('leer', '   ', true, 4),
    ]).returning({ id: artikel.id, bezeichnung: artikel.bezeichnung })

    const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0085_artikel_ean_eindeutig.sql'), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) await idb.db.execute(sql.raw(statement))

    const rows = await idb.db.select({ id: artikel.id, ean: artikel.ean }).from(artikel).where(eq(artikel.mandantId, mandantId))
    const eanVon = (name: string) => rows.find(r => r.id === ids.find(i => i.bezeichnung === name)!.id)!.ean
    expect(eanVon('aktiv-jung')).toBe('4006381333931')
    expect(eanVon('inaktiv-alt')).toBeNull()
    expect(eanVon('aktiv-alt-upc')).toBe('012345678905')
    expect(eanVon('aktiv-jung-upc')).toBeNull()
    expect(eanVon('leer')).toBeNull()
    // Unverändertes von vorher (Mandant B, über die API angelegt) bleibt
    expect(rows.some(r => r.ean === '9002490100070')).toBe(true)

    // Index ist wieder da und greift
    await expect(idb.db.insert(artikel).values(alt('noch-einer', '4006381333931', true, 6))).rejects.toThrow()
  })
})
