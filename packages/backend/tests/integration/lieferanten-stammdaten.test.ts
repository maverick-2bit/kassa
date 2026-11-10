/**
 * Integrationstest (echtes PostgreSQL, Migration 0078): Lieferanten-Stammdaten (Adresse, UID, Kundennummer,
 * Zahlungsbedingung, Lieferzeit) und Einkaufsdaten am Artikel (EAN, Einkaufspreis, Lieferanten-/Hersteller-Nr.)
 * werden gespeichert, geliefert, beim Teil-Update nicht überschrieben, per Bulk-Import (Datenübernahme) angelegt
 * und sind je Mandant getrennt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'lieferanten-stamm-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: 1 | 2) {
  return {
    firmenname: `Lieferanten Stamm ${nr} GmbH`,
    uid:        `ATU9999995${nr}`,
    kassenId:   `LS-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-LS-${nr}`, benutzerkennung: `BID-LS-${nr}`, pin: `PIN-LS-${nr}` },
    umgebung: 'test',
    admin: { name: `LS Admin ${nr}`, email: `admin${nr}@lieferantenstamm.at`, passwort: PASSWORT },
  }
}

interface LieferantRow {
  id: string; name: string; strasse: string | null; plz: string | null; ort: string | null; land: string
  uid: string | null; kundennummer: string | null; zahlungsbedingung: string | null; lieferzeitTage: number | null
  notiz: string | null; email: string | null
}
interface ArtikelRow {
  id: string; bezeichnung: string; ean: string | null; einkaufspreisCent: number | null
  lieferantenArtikelnummer: string | null; hersteller: string | null; herstellerArtikelnummer: string | null; lieferantId: string | null
}

describe('Lieferanten-Stammdaten und Einkaufsdaten am Artikel (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = ''
  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })

  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, headers: { authorization: string }, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2] as const) {
      const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: setupInput(nr) })
      if (setupRes.statusCode !== 201) throw new Error(`Setup ${nr} (${setupRes.statusCode}): ${setupRes.body}`)
      const login = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@lieferantenstamm.at`, passwort: PASSWORT } })
      if (login.statusCode !== 200) throw new Error(`Login ${nr} (${login.statusCode}): ${login.body}`)
      if (nr === 1) tokenA = login.json().token; else tokenB = login.json().token
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  const VOLL = {
    name: 'Kosatec Computer GmbH', kontakt: 'Herr Meier', email: 'bestellung@kosatec.de', telefon: '+49 531 235443000',
    strasse: 'Carl-Miele-Straße 3', plz: '38112', ort: 'Braunschweig', land: 'DE', uid: 'DE123456789',
    kundennummer: 'K-20431', zahlungsbedingung: '14 Tage 2 % Skonto, 30 Tage netto', lieferzeitTage: 3, notiz: 'SelectLine-Nr. 70001',
  }

  it('Lieferant: alle neuen Felder werden gespeichert und geliefert; Land ist ohne Angabe AT', async () => {
    const res = await inject('POST', '/api/lieferanten', authA(), VOLL)
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject(VOLL)

    const minimal = await inject('POST', '/api/lieferanten', authA(), { name: 'Nur Name' })
    expect(minimal.statusCode).toBe(201)
    expect(minimal.json()).toMatchObject({ land: 'AT', strasse: null, uid: null, kundennummer: null, zahlungsbedingung: null, lieferzeitTage: null })

    const liste = (await inject('GET', '/api/lieferanten', authA())).json() as LieferantRow[]
    expect(liste.find(l => l.name === VOLL.name)).toMatchObject(VOLL)
  })

  it('Lieferant: Teil-Update lässt die übrigen Felder unverändert, Leeren ist möglich', async () => {
    const id = ((await inject('POST', '/api/lieferanten', authA(), { ...VOLL, name: 'Teil-Update GmbH' })).json() as LieferantRow).id
    const r1 = await inject('PUT', `/api/lieferanten/${id}`, authA(), { lieferzeitTage: 7 })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toMatchObject({ ...VOLL, name: 'Teil-Update GmbH', lieferzeitTage: 7 })

    const r2 = await inject('PUT', `/api/lieferanten/${id}`, authA(), { uid: null, zahlungsbedingung: null, land: 'at' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ uid: null, zahlungsbedingung: null, land: 'AT', strasse: VOLL.strasse })
  })

  it('Lieferant: ungültiges Land / negative Lieferzeit → 400', async () => {
    expect((await inject('POST', '/api/lieferanten', authA(), { name: 'X', land: 'DEU' })).statusCode).toBe(400)
    expect((await inject('POST', '/api/lieferanten', authA(), { name: 'X', lieferzeitTage: -1 })).statusCode).toBe(400)
  })

  it('Lieferanten sind je Mandant getrennt (Mandant B sieht und ändert die Daten von A nicht)', async () => {
    const id = ((await inject('POST', '/api/lieferanten', authA(), { ...VOLL, name: 'Nur für A' })).json() as LieferantRow).id
    const listeB = (await inject('GET', '/api/lieferanten', authB())).json() as LieferantRow[]
    expect(listeB.find(l => l.id === id)).toBeUndefined()
    expect((await inject('PUT', `/api/lieferanten/${id}`, authB(), { uid: 'ATU00000000' })).statusCode).toBe(404)
  })

  it('Artikel: Einkaufsdaten werden angelegt, geliefert und beim Teil-Update nicht überschrieben', async () => {
    const lid = ((await inject('POST', '/api/lieferanten', authA(), { name: 'Für Artikel' })).json() as LieferantRow).id
    const res = await inject('POST', '/api/artikel', authA(), {
      bezeichnung: 'Epson 604XL yellow', preisBruttoCent: 4900, mwstSatz: 'normal', lieferantId: lid,
      ean: '8715946708034', einkaufspreisCent: 3333, lieferantenArtikelnummer: '4670803', hersteller: 'Epson', herstellerArtikelnummer: 'C13T10H44010',
    })
    expect(res.statusCode).toBe(201)
    const a = res.json() as ArtikelRow
    expect(a).toMatchObject({ ean: '8715946708034', einkaufspreisCent: 3333, lieferantenArtikelnummer: '4670803', hersteller: 'Epson', herstellerArtikelnummer: 'C13T10H44010' })

    expect((await inject('PUT', `/api/artikel/${a.id}`, authA(), { bezeichnung: 'Nur Name neu' })).statusCode).toBe(200)
    const liste = (await inject('GET', '/api/artikel', authA())).json() as ArtikelRow[]
    expect(liste.find(x => x.id === a.id)).toMatchObject({ bezeichnung: 'Nur Name neu', ean: '8715946708034', einkaufspreisCent: 3333, lieferantenArtikelnummer: '4670803' })

    expect((await inject('PUT', `/api/artikel/${a.id}`, authA(), { ean: null, einkaufspreisCent: null })).json()).toMatchObject({ ean: null, einkaufspreisCent: null, hersteller: 'Epson' })
  })

  it('Artikel: negativer Einkaufspreis → 400', async () => {
    const res = await inject('POST', '/api/artikel', authA(), { bezeichnung: 'Minus', preisBruttoCent: 100, mwstSatz: 'normal', einkaufspreisCent: -5 })
    expect(res.statusCode).toBe(400)
  })

  it('Datenübernahme: Bulk-Import legt Artikel samt Einkaufsdaten, Warengruppe und Lieferant an; ungültige Zeile blockiert die anderen nicht', async () => {
    const lid = ((await inject('POST', '/api/lieferanten', authA(), { name: 'Bulk-Lieferant', notiz: 'SelectLine-Nr. 70007' })).json() as LieferantRow).id
    const kat = (await inject('POST', '/api/kategorien', authA(), { name: 'Tinte', farbe: 'grau', reihenfolge: 0 })).json() as { id: string }
    const zeile = (n: string, extra: Record<string, unknown> = {}) => ({
      bezeichnung: n, preisBruttoCent: 1000, mwstSatz: 'normal', kategorieId: kat.id, lieferantId: lid,
      ean: `900${n.length}`, einkaufspreisCent: 800, lieferantenArtikelnummer: `SL-${n}`, ...extra,
    })
    const res = await inject('POST', '/api/artikel/bulk', authA(), [zeile('Eins'), zeile('Zwei'), zeile('', { bezeichnung: '' }), zeile('Drei', { einkaufspreisCent: -1 })])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ erstellt: 2, fehlgeschlagen: 2 })
    const liste = (await inject('GET', '/api/artikel', authA())).json() as ArtikelRow[]
    expect(liste.find(x => x.bezeichnung === 'Eins')).toMatchObject({ lieferantId: lid, lieferantenArtikelnummer: 'SL-Eins', einkaufspreisCent: 800 })
    expect(liste.find(x => x.bezeichnung === 'Zwei')).toBeDefined()
  })

  it('Mandantentrennung: ein Lieferant eines anderen Mandanten lässt sich am Artikel nicht verknüpfen', async () => {
    const fremd = ((await inject('POST', '/api/lieferanten', authB(), { name: 'Fremd' })).json() as LieferantRow).id
    const res = await inject('POST', '/api/artikel', authA(), { bezeichnung: 'Fremdlieferant', preisBruttoCent: 100, mwstSatz: 'normal', lieferantId: fremd })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
  })
})
