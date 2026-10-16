/**
 * Integrationstest: Layout-Export (GET /api/artikel/layout-export) gegen echtes PostgreSQL.
 *
 * Drei Mandanten: A (Quelle: Kellner Getränke/Speisen mit Untergruppe, Artikel, Farben, Raster-Plätze, Optionen),
 * B (Unbeteiligter mit eigenen Daten), C (leeres Ziel). Geprüft: nur Admin, Mandanten-Trennung, Auswahl,
 * Export schreibt nichts — und der Rundlauf: Datei aus A per Layout-Import in C ergibt dieselbe Kassa (idempotent),
 * ohne A oder B zu berühren.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { farbeZuHex, type LayoutExport, type LayoutBericht } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import {
  artikel, artikelModifikatorGruppen, kategorien, modifikatoren, modifikatorGruppen,
} from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'LE-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = (nr: number) => ({
  firmenname: `Export ${nr} GmbH`, uid: `ATU9999994${nr}`, kassenId: `LE-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-LE-${nr}`, benutzerkennung: `BID-LE-${nr}`, pin: `PIN-LE-${nr}` },
  umgebung: 'test',
  admin: { name: `LE Admin ${nr}`, email: `admin${nr}@layout-export.at`, passwort: 'layout-export-passwort-123' },
})

describe('Layout-Export (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const token: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' }
  const mandant: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' }
  const authVon = (m: 'A' | 'B' | 'C') => ({ authorization: `Bearer ${token[m]}` })
  const ids = { getraenke: '', bier: '', speisen: '', fremd: '' }

  const exportiere = (auth: { authorization?: string }, query = '') =>
    srv.fastify.inject({ method: 'GET', url: `/api/artikel/layout-export${query}`, headers: auth })
  const importiere = (m: 'A' | 'B' | 'C', body: unknown, query = 'dryRun=false') =>
    srv.fastify.inject({ method: 'POST', url: `/api/artikel/layout-import?${query}`, headers: authVon(m), payload: body as object })

  /** Kompletter Datenstand eines Mandanten (inkl. updatedAt — „unverändert" heißt auch: keine Schreibzugriffe) */
  async function schnappschuss(mandantId: string) {
    const [g, a, og, mo, zu] = await Promise.all([
      idb.db.select().from(kategorien).where(eq(kategorien.mandantId, mandantId)),
      idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantId)),
      idb.db.select().from(modifikatorGruppen).where(eq(modifikatorGruppen.mandantId, mandantId)),
      idb.db.select().from(modifikatoren).where(eq(modifikatoren.mandantId, mandantId)),
      idb.db.select({ artikelId: artikelModifikatorGruppen.artikelId, gruppeId: artikelModifikatorGruppen.gruppeId })
        .from(artikelModifikatorGruppen).innerJoin(artikel, eq(artikel.id, artikelModifikatorGruppen.artikelId))
        .where(eq(artikel.mandantId, mandantId)),
    ])
    const sortiere = <T extends object>(l: T[]) => [...l].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
    return JSON.stringify({ g: sortiere(g), a: sortiere(a), og: sortiere(og), mo: sortiere(mo), zu: sortiere(zu) })
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const [nr, m] of [[1, 'A'], [2, 'B'], [3, 'C']] as const) {
      const s = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@layout-export.at`, passwort: 'layout-export-passwort-123' },
      })).json()
      token[m] = login.token
      mandant[m] = srv.fastify.jwt.decode<{ mandantId: string }>(login.token)!.mandantId
    }

    // Mandant A: der Katalog, der wandern soll
    const [getraenke, bier, speisen] = await idb.db.insert(kategorien).values([
      { mandantId: mandant.A, name: 'Kellner Getränke', farbe: 'blau',    reihenfolge: 0, station: 'schank' },
      { mandantId: mandant.A, name: 'Bier',             farbe: '#c8a000', reihenfolge: 0 },
      { mandantId: mandant.A, name: 'Kellner Speisen',  farbe: 'rot',     reihenfolge: 1, station: 'kueche' },
    ]).returning()
    await idb.db.update(kategorien).set({ parentId: getraenke!.id }).where(eq(kategorien.id, bier!.id))
    ids.getraenke = getraenke!.id; ids.bier = bier!.id; ids.speisen = speisen!.id

    const artikelA = await idb.db.insert(artikel).values([
      { mandantId: mandant.A, bezeichnung: 'Cola 0,33',      preisBruttoCent: 320,  mwstSatz: 'normal',      artikelnummer: '0001', kategorieId: ids.getraenke, rasterPosition: 1, reihenfolge: 1 },
      { mandantId: mandant.A, bezeichnung: 'Wasser',         preisBruttoCent: 290,  mwstSatz: 'ermaessigt1', artikelnummer: '0002', kategorieId: ids.getraenke, rasterPosition: 3, reihenfolge: 3, farbe: 'gruen' },
      { mandantId: mandant.A, bezeichnung: 'Pils 0,5',       preisBruttoCent: 450,  mwstSatz: 'normal',      artikelnummer: '0003', kategorieId: ids.bier,      rasterPosition: 1, reihenfolge: 1 },
      { mandantId: mandant.A, bezeichnung: 'Schnitzel',      preisBruttoCent: 1450, mwstSatz: 'normal',      artikelnummer: '0004', kategorieId: ids.speisen,   rasterPosition: 2, reihenfolge: 2, allergene: 'A,C', farbe: '#aa5500' },
      { mandantId: mandant.A, bezeichnung: 'Pfand-Rückgabe', preisBruttoCent: -50,  mwstSatz: 'null',        artikelnummer: '0005', kategorieId: ids.getraenke, rasterPosition: 4, reihenfolge: 4 },
      { mandantId: mandant.A, bezeichnung: 'Alt (inaktiv)',  preisBruttoCent: 100,  mwstSatz: 'normal',      artikelnummer: '0006', kategorieId: ids.speisen,   aktiv: false },
    ]).returning()
    const cola = artikelA.find(a => a.bezeichnung === 'Cola 0,33')!
    const [groesse] = await idb.db.insert(modifikatorGruppen).values({ mandantId: mandant.A, name: 'Größe', typ: 'pflicht', maxAuswahl: 1 }).returning()
    await idb.db.insert(modifikatoren).values([
      { mandantId: mandant.A, gruppeId: groesse!.id, name: 'Klein', aufschlagCent: 0,   reihenfolge: 0 },
      { mandantId: mandant.A, gruppeId: groesse!.id, name: 'Groß',  aufschlagCent: 100, reihenfolge: 1 },
    ])
    await idb.db.insert(artikelModifikatorGruppen).values({ artikelId: cola.id, gruppeId: groesse!.id, reihenfolge: 0 })

    // Mandant B: Unbeteiligter mit eigenen Daten — darf weder im Export von A auftauchen noch vom Import in C berührt werden
    const [fremd] = await idb.db.insert(kategorien).values({ mandantId: mandant.B, name: 'Nur in B', farbe: 'lila', reihenfolge: 0 }).returning()
    ids.fremd = fremd!.id
    await idb.db.insert(artikel).values({ mandantId: mandant.B, bezeichnung: 'Geheimartikel B', preisBruttoCent: 999, mwstSatz: 'normal', artikelnummer: '0001', kategorieId: fremd!.id })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('nur Admin: Kellner bekommt 403, ohne Token 401', async () => {
    const kellner = { authorization: `Bearer ${srv.signTestToken({ rolle: 'kellner', mandantId: mandant.A })}` }
    expect((await exportiere(kellner)).statusCode).toBe(403)
    expect((await exportiere({})).statusCode).toBe(401)
    expect((await exportiere(authVon('A'))).statusCode).toBe(200)
  })

  it('liefert den Katalog des Mandanten: Baum, Artikel, Farben, Raster-Plätze, Optionen — und nichts von anderen', async () => {
    const res = await exportiere(authVon('A'))
    expect(res.statusCode).toBe(200)
    const e = res.json() as LayoutExport
    expect(e.layout.quelle).toMatch(/^Kassa-Export Export 1 GmbH \(\d{4}-\d{2}-\d{2}\)$/)
    expect(e.layout.gruppen.map(g => g.name)).toEqual(['Kellner Getränke', 'Kellner Speisen'])
    const getraenke = e.layout.gruppen[0]!
    expect(getraenke).toMatchObject({ farbe: farbeZuHex('blau'), station: 'schank' })
    expect(getraenke.untergruppen.map(g => [g.name, g.farbe])).toEqual([['Bier', '#c8a000']])
    expect(getraenke.artikel.map(a => [a.name, a.preisCent, a.mwst, a.slot])).toEqual([
      ['Cola 0,33', 320, 0.2, 1], ['Wasser', 290, 0.1, 3], ['Pfand-Rückgabe', -50, 0, 4],
    ])
    expect(getraenke.artikel[0]!.optionen).toEqual([
      { gruppe: 'Größe', exakterName: true, pflicht: true, mehrfach: false, maxAuswahl: 1,
        optionen: [{ name: 'Klein', aufschlagCent: 0 }, { name: 'Groß', aufschlagCent: 100 }] },
    ])
    expect(e.layout.gruppen[1]!.artikel[0]).toMatchObject({ name: 'Schnitzel', allergene: 'A,C', farbe: '#aa5500', nr: '0004' })
    expect(e.zusammenfassung).toEqual({ gruppen: 3, artikel: 5, optionsgruppen: 1 })
    const text = JSON.stringify(e)
    expect(text).not.toContain('Geheimartikel B')
    expect(text).not.toContain('Nur in B')
    expect(text).not.toContain('Alt (inaktiv)')
  })

  it('Auswahl per kategorieIds: Untergruppen kommen mit; fremde IDs bleiben ohne Wirkung; Unsinn wird abgelehnt', async () => {
    const nurGetraenke = (await exportiere(authVon('A'), `?kategorieIds=${ids.getraenke}`)).json() as LayoutExport
    expect(nurGetraenke.layout.gruppen.map(g => g.name)).toEqual(['Kellner Getränke'])
    expect(nurGetraenke.layout.gruppen[0]!.untergruppen.map(g => g.name)).toEqual(['Bier'])
    expect(nurGetraenke.zusammenfassung.gruppen).toBe(2)

    const nurBier = (await exportiere(authVon('A'), `?kategorieIds=${ids.bier}`)).json() as LayoutExport
    expect(nurBier.layout.gruppen.map(g => g.name)).toEqual(['Bier'])

    // Eine Gruppe von Mandant B: für A gibt es sie nicht — nichts zu exportieren
    const fremd = await exportiere(authVon('A'), `?kategorieIds=${ids.fremd}`)
    expect(fremd.statusCode).toBe(422)
    // … und gemischt: nur die eigene Gruppe kommt
    const gemischt = (await exportiere(authVon('A'), `?kategorieIds=${ids.fremd},${ids.speisen}`)).json() as LayoutExport
    expect(gemischt.layout.gruppen.map(g => g.name)).toEqual(['Kellner Speisen'])

    expect((await exportiere(authVon('A'), '?kategorieIds=kein-uuid')).statusCode).toBe(400)
  })

  it('Mandant ohne Katalog: klare Meldung statt leerer Datei', async () => {
    const res = await exportiere(authVon('C'))
    expect(res.statusCode).toBe(422)
    expect(res.json().fehler).toMatch(/Keine Warengruppen/)
  })

  it('der Export schreibt nichts', async () => {
    const vorher = await schnappschuss(mandant.A)
    await exportiere(authVon('A'))
    await exportiere(authVon('A'), `?kategorieIds=${ids.getraenke}`)
    expect(await schnappschuss(mandant.A)).toBe(vorher)
  })

  it('Rundlauf: die Datei aus A per Layout-Import in C ergibt dieselbe Kassa — ohne A oder B zu berühren, beim zweiten Mal ohne Änderung', async () => {
    const vorherA = await schnappschuss(mandant.A)
    const vorherB = await schnappschuss(mandant.B)
    const datei = (await exportiere(authVon('A'))).json().layout           // so wandert die Datei: als JSON

    const vorherC = await schnappschuss(mandant.C)
    const vorschau = (await importiere('C', datei, 'dryRun=true')).json() as LayoutBericht
    expect(vorschau.zaehler.artikel).toMatchObject({ imLayout: 5, neu: 5, mehrdeutig: 0 })
    expect(await schnappschuss(mandant.C)).toBe(vorherC)                                // die Vorschau schreibt nichts

    const res = await importiere('C', datei)
    expect(res.statusCode).toBe(200)
    const bericht = res.json() as LayoutBericht
    expect(bericht.zaehler.gruppen).toMatchObject({ imLayout: 3, neu: 3 })
    expect(bericht.zaehler.artikel).toMatchObject({ imLayout: 5, neu: 5 })
    expect(bericht.zaehler.optionen).toMatchObject({ gruppenNeu: 1, zuordnungenNeu: 1 })

    // Gruppen in C: Baum, Farben, Stationen, Reihenfolge
    const gruppenC = await idb.db.select().from(kategorien).where(eq(kategorien.mandantId, mandant.C))
    const gruppe = (name: string) => gruppenC.find(g => g.name === name)!
    expect(gruppenC.map(g => g.name).sort()).toEqual(['Bier', 'Kellner Getränke', 'Kellner Speisen'])
    expect(gruppe('Kellner Getränke')).toMatchObject({ farbe: farbeZuHex('blau'), station: 'schank', parentId: null, reihenfolge: 0 })
    expect(gruppe('Bier')).toMatchObject({ farbe: '#c8a000', parentId: gruppe('Kellner Getränke').id })
    expect(gruppe('Kellner Speisen')).toMatchObject({ farbe: farbeZuHex('rot'), station: 'kueche', reihenfolge: 1 })

    // Artikel in C: Preis, MwSt, Raster-Platz, Farbe, Allergene, Gruppe — die inaktive Altlast kommt nicht mit
    const artikelC = await idb.db.select().from(artikel).where(eq(artikel.mandantId, mandant.C))
    const a = (name: string) => artikelC.find(x => x.bezeichnung === name)!
    expect(artikelC).toHaveLength(5)
    expect(a('Cola 0,33')).toMatchObject({ preisBruttoCent: 320, mwstSatz: 'normal', rasterPosition: 1, kategorieId: gruppe('Kellner Getränke').id })
    expect(a('Wasser')).toMatchObject({ preisBruttoCent: 290, mwstSatz: 'ermaessigt1', rasterPosition: 3, farbe: farbeZuHex('gruen') })
    expect(a('Pils 0,5')).toMatchObject({ preisBruttoCent: 450, kategorieId: gruppe('Bier').id })
    expect(a('Schnitzel')).toMatchObject({ preisBruttoCent: 1450, allergene: 'A,C', farbe: '#aa5500', kategorieId: gruppe('Kellner Speisen').id })
    expect(a('Pfand-Rückgabe')).toMatchObject({ preisBruttoCent: -50, mwstSatz: 'null', rasterPosition: 4 })
    expect(new Set(artikelC.map(x => x.artikelnummer)).size).toBe(5)                  // eigene, eindeutige Nummern in C

    // Optionen in C: Name unverändert („Größe", nicht „Größe (Klein / Groß)"), Pflicht, genau eine Auswahl, am richtigen Artikel
    const optionenC = await idb.db.select().from(modifikatorGruppen).where(eq(modifikatorGruppen.mandantId, mandant.C))
    expect(optionenC.map(o => [o.name, o.typ, o.maxAuswahl])).toEqual([['Größe', 'pflicht', 1]])
    const optC = await idb.db.select().from(modifikatoren).where(and(eq(modifikatoren.mandantId, mandant.C), eq(modifikatoren.gruppeId, optionenC[0]!.id)))
    expect(optC.sort((x, y) => x.reihenfolge - y.reihenfolge).map(o => [o.name, o.aufschlagCent])).toEqual([['Klein', 0], ['Groß', 100]])
    const zu = await idb.db.select().from(artikelModifikatorGruppen).where(eq(artikelModifikatorGruppen.artikelId, a('Cola 0,33').id))
    expect(zu.map(z => z.gruppeId)).toEqual([optionenC[0]!.id])

    // Zweiter Import derselben Datei: nichts Neues, nichts geändert
    const nachC = await schnappschuss(mandant.C)
    const zweiter = (await importiere('C', datei)).json() as LayoutBericht
    expect(zweiter.zaehler.gruppen).toMatchObject({ neu: 0, geaendert: 0 })
    expect(zweiter.zaehler.artikel).toMatchObject({ neu: 0, geaendert: 0 })
    expect(zweiter.zaehler.optionen).toMatchObject({ gruppenNeu: 0, zuordnungenNeu: 0 })
    expect(await schnappschuss(mandant.C)).toBe(nachC)

    // A und B sind unberührt
    expect(await schnappschuss(mandant.A)).toBe(vorherA)
    expect(await schnappschuss(mandant.B)).toBe(vorherB)
  })

  it('der Export aus C (dem Ziel) gleicht dem aus A — bis auf Herkunft, Artikelnummern und die vererbte Station der Untergruppe', async () => {
    type Knoten = { station?: string | null; untergruppen: Knoten[] }
    // Eine Untergruppe ohne eigene Station erbt die der Elterngruppe — der Import schreibt sie ausdrücklich dazu (wirkt gleich)
    const ohneVererbung = (gs: Knoten[], istUnter: boolean): void => {
      for (const g of gs) { if (istUnter) g.station = null; ohneVererbung(g.untergruppen, true) }
    }
    const aus = async (m: 'A' | 'C') => {
      const e = (await exportiere(authVon(m))).json() as LayoutExport
      const layout = JSON.parse(JSON.stringify(e.layout, (k, v) => (k === 'nr' || k === 'quelle' ? undefined : v))) as { gruppen: Knoten[] }
      ohneVererbung(layout.gruppen, false)
      return layout
    }
    expect(await aus('C')).toEqual(await aus('A'))
  })
})
