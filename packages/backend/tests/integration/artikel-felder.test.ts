/**
 * Integrationstest: Artikel anlegen und bearbeiten gegen echtes PostgreSQL (zwei Mandanten) —
 * JEDES Feld des Artikel-Formulars landet in der Datenbank und kommt über GET /api/artikel wieder heraus.
 *
 * Anlass: Beim Bearbeiten eines bestehenden Artikels gingen „Eigene Farbe", Lieferant, Mindestbestand,
 * Rohstoff-Flag, Bonierbon-Option, Seriennummern und die Zusammensetzung (Rezept) verloren — das Formular
 * schickte nur einen Teil seiner Felder mit (Frontend: lib/artikel-update.ts). Zusätzlich schrieb der Server den
 * Lieferanten weder beim Anlegen noch beim Bearbeiten und den Mindestbestand nicht beim Anlegen (auch nicht
 * beim Excel-Import) — selbst ein vollständiges Formular hätte den Lieferanten also nie gespeichert.
 *
 * Der Wächter-Test fällt um, sobald dem Update-Schema ein Feld hinzukommt, das der Server nicht schreibt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { ArtikelUpdateSchema, type ArtikelUpdate } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'artikelfelder-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: 1 | 2) {
  return {
    firmenname: `Artikelfelder ${nr} GmbH`,
    uid:        `ATU9999994${nr}`,
    kassenId:   `AF-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-AF-${nr}`, benutzerkennung: `BID-AF-${nr}`, pin: `PIN-AF-${nr}` },
    umgebung: 'test',
    admin: { name: `AF Admin ${nr}`, email: `admin${nr}@artikelfelder.at`, passwort: PASSWORT },
  }
}

interface ArtikelRow {
  id: string
  bezeichnung: string
  preisBruttoCent: number
  mwstSatz: string
  station: string | null
  farbe: string | null
  kategorieId: string | null
  rasterPosition: number | null
  aktiv: boolean
  lagerstandAktiv: boolean
  lagerstandMenge: number | null
  mindestbestand: number | null
  seriennummernAktiv: boolean
  istFavorit: boolean
  reihenfolge: number
  favoritenReihenfolge: number
  bonierdruckerId: string | null
  bonierBeiDirektverkauf: boolean
  istBestandteil: boolean
  bestandteile: { bestandteilArtikelId: string; bezeichnung: string; menge: number }[]
  verfuegbareMenge?: number | null
  lieferantId: string | null
  terminalSichtbar: boolean | null
  bild?: string | null
}

/** Rezept ohne Anzeigenamen, nach Artikel-ID sortiert (die Reihenfolge im Rezept ist nicht festgelegt). */
const rezept = (a: Pick<ArtikelRow, 'bestandteile'> | { bestandteile?: { bestandteilArtikelId: string; menge: number }[] }) =>
  (a.bestandteile ?? [])
    .map(b => ({ bestandteilArtikelId: b.bestandteilArtikelId, menge: b.menge }))
    .sort((x, y) => x.bestandteilArtikelId.localeCompare(y.bestandteilArtikelId))

describe('Artikel anlegen und bearbeiten: alle Formularfelder werden gespeichert (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = ''

  // Stammdaten Mandant A
  let kategorieId = '', druckerId = '', lieferantA1 = '', lieferantA2 = '', rohstoffA1 = '', rohstoffA2 = ''
  // Stammdaten Mandant B (dürfen von A aus nie erreichbar sein)
  let lieferantB = '', rohstoffB = ''

  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })

  async function post(url: string, headers: { authorization: string }, payload: unknown) {
    const res = await srv.fastify.inject({ method: 'POST', url, headers, payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }

  async function legeArtikelAn(bezeichnung: string, extra: Record<string, unknown> = {}): Promise<string> {
    return (await post('/api/artikel', authA(), { bezeichnung, preisBruttoCent: 350, mwstSatz: 'normal', ...extra })).id
  }

  async function alleArtikel(): Promise<ArtikelRow[]> {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: authA() })
    expect(res.statusCode).toBe(200)
    return res.json() as ArtikelRow[]
  }

  async function artikel(id: string): Promise<ArtikelRow> {
    const a = (await alleArtikel()).find(x => x.id === id)
    if (!a) throw new Error(`Artikel ${id} fehlt in GET /api/artikel`)
    return a
  }

  const put = (id: string, payload: Record<string, unknown>) =>
    srv.fastify.inject({ method: 'PUT', url: `/api/artikel/${id}`, headers: authA(), payload })

  /** Ein Wert in JEDEM Feld des Update-Schemas (`satisfies` erzwingt beim Kompilieren, der Wächter-Test zur Laufzeit, dass keins fehlt). */
  const vollstaendigesUpdate = () => ({
    bezeichnung:            'Alles geändert',
    preisBruttoCent:        420,
    mwstSatz:               'ermaessigt1',
    station:                'schank',
    farbe:                  '#336699',
    kategorieId,
    rasterPosition:         7,
    aktiv:                  true,
    lagerstandAktiv:        true,
    lagerstandMenge:        12,
    mindestbestand:         3,
    seriennummernAktiv:     true,
    istFavorit:             true,
    reihenfolge:            5,
    favoritenReihenfolge:   2,
    bonierdruckerId:        druckerId,
    bonierBeiDirektverkauf: true,
    istBestandteil:         true,
    bestandteile:           [{ bestandteilArtikelId: rohstoffA1, menge: 3 }, { bestandteilArtikelId: rohstoffA2, menge: 2 }],
    lieferantId:            lieferantA2,
    terminalSichtbar:       true,
    bild:                   'data:image/jpeg;base64,/9j/AAAA',
  } satisfies Record<keyof ArtikelUpdate, unknown>)

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    for (const nr of [1, 2] as const) {
      const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setupRes.statusCode !== 201) throw new Error(`Setup ${nr} (${setupRes.statusCode}): ${setupRes.body}`)
      const loginRes = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@artikelfelder.at`, passwort: PASSWORT },
      })
      if (loginRes.statusCode !== 200) throw new Error(`Login ${nr} (${loginRes.statusCode}): ${loginRes.body}`)
      if (nr === 1) tokenA = loginRes.json().token
      else          tokenB = loginRes.json().token
    }

    kategorieId = (await post('/api/kategorien', authA(), { name: 'Heiße Getränke', farbe: 'blau', reihenfolge: 0 })).id
    // legt nur den Stammsatz an — verbunden wird erst beim Drucken
    druckerId   = (await post('/api/bonierdrucker', authA(), { name: 'Küchendrucker', ip: '127.0.0.1', port: 9100 })).id
    lieferantA1 = (await post('/api/lieferanten', authA(), { name: 'Kaffee-Großhandel' })).id
    lieferantA2 = (await post('/api/lieferanten', authA(), { name: 'Molkerei' })).id
    rohstoffA1  = await legeArtikelAn('Rohstoff Bohnen', { preisBruttoCent: 0, istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 50 })
    rohstoffA2  = await legeArtikelAn('Rohstoff Milch',  { preisBruttoCent: 0, istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 40 })

    lieferantB  = (await post('/api/lieferanten', authB(), { name: 'Fremder Lieferant' })).id
    rohstoffB   = (await post('/api/artikel', authB(), {
      bezeichnung: 'Fremder Rohstoff', preisBruttoCent: 0, mwstSatz: 'normal', istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 10,
    })).id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Anlegen: Lieferant, Mindestbestand, Farbe, Bonierbon-Option, Seriennummern und Rezept werden gespeichert', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: authA(),
      payload: {
        bezeichnung: 'Anlege-Test', preisBruttoCent: 350, mwstSatz: 'ermaessigt1', farbe: '#336699', kategorieId,
        lagerstandAktiv: true, lagerstandMenge: 12, mindestbestand: 3, lieferantId: lieferantA1,
        bonierBeiDirektverkauf: true, seriennummernAktiv: true,
        bestandteile: [{ bestandteilArtikelId: rohstoffA1, menge: 2 }],
      },
    })
    expect(res.statusCode).toBe(201)
    const angelegt = res.json() as ArtikelRow
    const gelesen  = await artikel(angelegt.id)
    for (const a of [angelegt, gelesen]) {
      expect(a).toMatchObject({
        farbe: '#336699', kategorieId, lagerstandAktiv: true, lagerstandMenge: 12, mindestbestand: 3,
        lieferantId: lieferantA1, bonierBeiDirektverkauf: true, seriennummernAktiv: true,
      })
      expect(rezept(a)).toEqual([{ bestandteilArtikelId: rohstoffA1, menge: 2 }])
    }
  })

  it('Bearbeiten: JEDES Feld des Update-Schemas wird geschrieben und wieder geliefert (Wächter gegen nicht verdrahtete Felder)', async () => {
    const body = vollstaendigesUpdate()
    // Wächter: das Beispiel deckt jedes Feld des Update-Schemas ab — kommt eins hinzu, muss es hier und im Service ergänzt werden
    expect(Object.keys(body).sort()).toEqual(Object.keys(ArtikelUpdateSchema.shape).sort())

    const id  = await legeArtikelAn('Wächter-Artikel')
    const res = await put(id, body)
    expect(res.statusCode).toBe(200)

    const antwort = res.json() as ArtikelRow
    const gelesen = await artikel(id)
    for (const [feld, soll] of Object.entries(body)) {
      for (const [quelle, ist] of [['Antwort des PUT', antwort], ['GET /api/artikel', gelesen]] as const) {
        if (feld === 'bestandteile') {
          expect(rezept(ist), `Feld „${feld}" (${quelle})`).toEqual(rezept({ bestandteile: soll as { bestandteilArtikelId: string; menge: number }[] }))
        } else {
          expect((ist as unknown as Record<string, unknown>)[feld], `Feld „${feld}" (${quelle})`).toEqual(soll)
        }
      }
    }
  })

  it('Teil-Update: nicht mitgeschickte Felder bleiben unverändert (Lieferant, Rezept, Farbe, Mindestbestand, Rohstoff-Flag …)', async () => {
    const id = await legeArtikelAn('Teil-Update', {
      farbe: '#336699', lagerstandAktiv: true, lagerstandMenge: 12, mindestbestand: 3, lieferantId: lieferantA1,
      bonierBeiDirektverkauf: true, seriennummernAktiv: true, istBestandteil: true,
      bestandteile: [{ bestandteilArtikelId: rohstoffA1, menge: 4 }],
    })
    const vorher = await artikel(id)
    expect(vorher.lieferantId).toBe(lieferantA1)           // schon das Anlegen speichert den Lieferanten

    expect((await put(id, { bezeichnung: 'Nur der Name' })).statusCode).toBe(200)

    const nachher = await artikel(id)
    expect(nachher.bezeichnung).toBe('Nur der Name')
    expect({ ...nachher, bezeichnung: vorher.bezeichnung, updatedAt: undefined })
      .toEqual({ ...vorher, updatedAt: undefined })
  })

  it('null und [] leeren: Lieferant lösen, Farbe auf Automatisch, Mindestbestand/Station/Warengruppe/Drucker/Bild leeren, Rezept leeren', async () => {
    const id = await legeArtikelAn('Wird geleert', {
      farbe: '#336699', kategorieId, station: 'schank', bonierdruckerId: druckerId, lieferantId: lieferantA1,
      lagerstandAktiv: true, lagerstandMenge: 12, mindestbestand: 3, bild: 'data:image/jpeg;base64,/9j/AAAA',
      bestandteile: [{ bestandteilArtikelId: rohstoffA1, menge: 2 }],
    })
    const res = await put(id, {
      farbe: null, kategorieId: null, station: null, bonierdruckerId: null, lieferantId: null,
      mindestbestand: null, lagerstandMenge: null, bild: null, bestandteile: [],
    })
    expect(res.statusCode).toBe(200)

    const a = await artikel(id)
    expect(a).toMatchObject({
      farbe: null, kategorieId: null, station: null, bonierdruckerId: null, lieferantId: null,
      mindestbestand: null, lagerstandMenge: null, bestandteile: [], verfuegbareMenge: null,
    })
    expect(a.bild ?? null).toBeNull()
  })

  it('Rezept: ersetzen, ändern, unverändert lassen, leeren — die abgeleitete Verfügbarkeit stimmt jeweils', async () => {
    const id = await legeArtikelAn('Cappuccino')

    // hinzufügen: Bohnen 3 (Lager 50 → 16), Milch 2 (Lager 40 → 20) → Engpass 16
    expect((await put(id, { bestandteile: [
      { bestandteilArtikelId: rohstoffA1, menge: 3 }, { bestandteilArtikelId: rohstoffA2, menge: 2 },
    ] })).statusCode).toBe(200)
    let a = await artikel(id)
    expect(rezept(a)).toEqual(rezept({ bestandteile: [
      { bestandteilArtikelId: rohstoffA1, menge: 3 }, { bestandteilArtikelId: rohstoffA2, menge: 2 },
    ] }))
    expect(a.verfuegbareMenge).toBe(16)

    // ändern: Bohnen 5, Milch entfernt → 10
    expect((await put(id, { bestandteile: [{ bestandteilArtikelId: rohstoffA1, menge: 5 }] })).statusCode).toBe(200)
    a = await artikel(id)
    expect(rezept(a)).toEqual([{ bestandteilArtikelId: rohstoffA1, menge: 5 }])
    expect(a.verfuegbareMenge).toBe(10)

    // ohne „bestandteile" im Body bleibt das Rezept, wie es ist
    expect((await put(id, { bezeichnung: 'Cappuccino groß' })).statusCode).toBe(200)
    expect(rezept(await artikel(id))).toEqual([{ bestandteilArtikelId: rohstoffA1, menge: 5 }])

    // leeren
    expect((await put(id, { bestandteile: [] })).statusCode).toBe(200)
    a = await artikel(id)
    expect(a.bestandteile).toEqual([])
    expect(a.verfuegbareMenge).toBeNull()
  })

  it('Rezept eines anderen Mandanten wird abgewiesen — und die Änderung ist atomar: Artikel und altes Rezept bleiben unverändert', async () => {
    const id = await legeArtikelAn('Atomar', { farbe: '#112233', bestandteile: [{ bestandteilArtikelId: rohstoffA1, menge: 2 }] })
    const vorher = await artikel(id)

    const res = await put(id, {
      bezeichnung: 'Sollte nicht ankommen', farbe: '#ff0000',
      bestandteile: [{ bestandteilArtikelId: rohstoffB, menge: 1 }],
    })
    // der genaue Status (400 oder 500) ist Sache des Fehler-Handlings — hier zählt: abgewiesen und nichts halb geschrieben
    expect(res.statusCode).toBeGreaterThanOrEqual(400)

    const nachher = await artikel(id)
    expect(nachher.bezeichnung).toBe('Atomar')
    expect(nachher.farbe).toBe('#112233')
    expect(rezept(nachher)).toEqual(rezept(vorher))
  })

  it('Lieferant eines anderen Mandanten oder unbekannte ID → 400 { fehler }, beim Bearbeiten wie beim Anlegen; es ändert sich nichts', async () => {
    const id = await legeArtikelAn('Fremdlieferant', { lieferantId: lieferantA1 })

    for (const fremd of [lieferantB, '99999999-9999-4999-8999-999999999999']) {
      const res = await put(id, { bezeichnung: 'Sollte nicht ankommen', lieferantId: fremd })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ fehler: 'Lieferant nicht gefunden' })
    }
    const nachher = await artikel(id)
    expect(nachher.bezeichnung).toBe('Fremdlieferant')
    expect(nachher.lieferantId).toBe(lieferantA1)

    const neu = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: authA(),
      payload: { bezeichnung: 'Fremdlieferant neu', preisBruttoCent: 100, mwstSatz: 'normal', lieferantId: lieferantB },
    })
    expect(neu.statusCode).toBe(400)
    expect(neu.json()).toEqual({ fehler: 'Lieferant nicht gefunden' })
    expect((await alleArtikel()).some(a => a.bezeichnung === 'Fremdlieferant neu')).toBe(false)
  })

  it('ein später deaktivierter Lieferant blockiert das Bearbeiten nicht — das Formular schickt die Verknüpfung bei jedem Speichern mit', async () => {
    const lid = (await post('/api/lieferanten', authA(), { name: 'Wird deaktiviert' })).id
    const id  = await legeArtikelAn('Mit altem Lieferanten', { lieferantId: lid })
    const del = await srv.fastify.inject({ method: 'DELETE', url: `/api/lieferanten/${lid}`, headers: authA() })
    expect(del.statusCode).toBe(204)

    const res = await put(id, { bezeichnung: 'Umbenannt', lieferantId: lid })
    expect(res.statusCode).toBe(200)
    expect((res.json() as ArtikelRow).lieferantId).toBe(lid)
  })

  it('Bulk-Import (Excel-Weg): der Mindestbestand wird gespeichert; ein fremder Lieferant ist ein Zeilenfehler, die übrigen Zeilen laufen', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel/bulk', headers: authA(),
      payload: [
        { bezeichnung: 'Bulk OK',    preisBruttoCent: 200, mwstSatz: 'normal', lagerstandAktiv: true, lagerstandMenge: 9, mindestbestand: 5 },
        { bezeichnung: 'Bulk Fremd', preisBruttoCent: 200, mwstSatz: 'normal', lieferantId: lieferantB },
      ],
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      erstellt: 1, fehlgeschlagen: 1,
      fehlzeilen: [{ index: 1, fehler: 'Lieferant nicht gefunden' }],
    })

    const liste = await alleArtikel()
    expect(liste.find(a => a.bezeichnung === 'Bulk OK')).toMatchObject({ lagerstandMenge: 9, mindestbestand: 5 })
    expect(liste.some(a => a.bezeichnung === 'Bulk Fremd')).toBe(false)
  })
})
