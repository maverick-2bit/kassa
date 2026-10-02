/**
 * Integrationstest: Layout-Import (POST /api/artikel/layout-import) gegen echtes PostgreSQL.
 *
 * Vorbestand: das reale Asello-Layout (53 Gruppen, 494 Artikel, 27 Favoriten) als FLACHE
 * Warengruppen wie nach dem früheren Artikel-Import. Geprüft: Baum/Farben/Slots/Favoriten,
 * dryRun schreibt nichts, zweiter Lauf ändert nichts, Mandant A kann Mandant B nie anfassen,
 * nur Admin, Eingabe-Validierung; dazu Untergruppen-Regeln der Kategorie-Routen.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { artikel, kassen, kasseFavoriten, kategorien } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { flacherKassaZustand, ladeAselloLayout } from '../helpers/layout-kassa.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'LI-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = (nr: number) => ({
  firmenname: `Layout ${nr} GmbH`, uid: `ATU9999993${nr}`, kassenId: `LI-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-LI-${nr}`, benutzerkennung: `BID-LI-${nr}`, pin: `PIN-LI-${nr}` },
  umgebung: 'test',
  admin: { name: `LI Admin ${nr}`, email: `admin${nr}@layout-import.at`, passwort: 'layout-import-passwort-123' },
})

describe('Layout-Import (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = ''
  let mandantA = '', mandantB = ''
  let kasseA = ''
  const layout = ladeAselloLayout()
  const rohLayout = () => JSON.parse(JSON.stringify(layout))
  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })

  const importiere = (token: { authorization: string }, body: unknown, query = 'dryRun=false') =>
    srv.fastify.inject({ method: 'POST', url: `/api/artikel/layout-import?${query}`, headers: token, payload: body as object })

  /** Kompletter Datenstand eines Mandanten (inkl. updatedAt — „keine Änderung" heißt auch: keine Schreibzugriffe) */
  async function schnappschuss(mandantId: string) {
    const [g, a, k, f] = await Promise.all([
      idb.db.select().from(kategorien).where(eq(kategorien.mandantId, mandantId)),
      idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantId)),
      idb.db.select().from(kassen).where(eq(kassen.mandantId, mandantId)),
      idb.db.select().from(kasseFavoriten).where(eq(kasseFavoriten.mandantId, mandantId)),
    ])
    const sortiere = <T extends { id: string }>(l: T[]) => [...l].sort((x, y) => x.id.localeCompare(y.id))
    return JSON.stringify({ g: sortiere(g), a: sortiere(a), k: sortiere(k), f: sortiere(f) }, (_s, w) => (typeof w === 'bigint' ? w.toString() : w))
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2]) {
      const s = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@layout-import.at`, passwort: 'layout-import-passwort-123' },
      })).json()
      if (nr === 1) { tokenA = login.token; mandantA = login.user.mandantId ?? srv.fastify.jwt.decode<{ mandantId: string }>(login.token)!.mandantId; kasseA = login.kassen[0].id }
      else          { tokenB = login.token; mandantB = login.user.mandantId ?? srv.fastify.jwt.decode<{ mandantId: string }>(login.token)!.mandantId }
    }

    // Vorbestand Mandant A: flache Gruppen + Artikel des Layouts, dazu Kassen-eigene Favoriten
    const { zustand } = flacherKassaZustand(layout)
    // Die frei erfundenen Test-IDs sind global eindeutig — für B nehmen wir getrennte Zeilen
    await idb.db.insert(kategorien).values(zustand.gruppen.map(g => ({
      id: g.id, mandantId: mandantA, name: g.name, farbe: g.farbe, reihenfolge: g.reihenfolge,
      station: g.station, terminalSichtbar: g.terminalSichtbar,
    })))
    await idb.db.insert(artikel).values(zustand.artikel.map((a, i) => ({
      id: a.id, mandantId: mandantA, bezeichnung: a.bezeichnung, preisBruttoCent: 111, mwstSatz: 'normal',
      artikelnummer: String(i + 1).padStart(4, '0'), kategorieId: a.kategorieId,
      // ein „alter" Favorit, der am Ende KEINER mehr sein darf
      istFavorit: i === 0, favoritenReihenfolge: i === 0 ? 5 : 0,
    })))
    await idb.db.insert(kasseFavoriten).values([
      { mandantId: mandantA, kasseId: kasseA, position: 1, artikelId: zustand.artikel[3]!.id },
      { mandantId: mandantA, kasseId: kasseA, position: 2, artikelId: null },
    ])

    // Mandant B: bewusst gleiche Namen („Speisen", „Brez´n"), muss unberührt bleiben
    const gB = await idb.db.insert(kategorien).values({ mandantId: mandantB, name: 'Speisen', farbe: 'rot', reihenfolge: 0 }).returning()
    await idb.db.insert(artikel).values({
      mandantId: mandantB, bezeichnung: 'Brez´n', preisBruttoCent: 222, mwstSatz: 'ermaessigt1',
      artikelnummer: '0001', kategorieId: gB[0]!.id, istFavorit: true, favoritenReihenfolge: 9,
    })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('nur Admin: Kellner bekommt 403, ohne Token 401', async () => {
    const kellner = { authorization: `Bearer ${srv.signTestToken({ rolle: 'kellner', mandantId: mandantA })}` }
    expect((await importiere(kellner, rohLayout())).statusCode).toBe(403)
    expect((await importiere({} as { authorization: string }, rohLayout())).statusCode).toBe(401)
  })

  it('validiert die Eingabe (kaputte Farbe, zu tiefer Baum, leeres Layout)', async () => {
    const kaputt = rohLayout(); kaputt.gruppen[0].farbe = 'rot'
    expect((await importiere(authA(), kaputt, 'dryRun=true')).statusCode).toBe(400)
    const tief = { gruppen: [{ name: 'a', farbe: '#111111', untergruppen: [{ name: 'b', farbe: '#111111', untergruppen: [{ name: 'c', farbe: '#111111', untergruppen: [{ name: 'd', farbe: '#111111', untergruppen: [{ name: 'e', farbe: '#111111' }] }] }] }] }] }
    expect((await importiere(authA(), tief, 'dryRun=true')).statusCode).toBe(400)
    expect((await importiere(authA(), { gruppen: [] }, 'dryRun=true')).statusCode).toBe(400)
    expect((await importiere(authA(), rohLayout(), 'dryRun=vielleicht')).statusCode).toBe(400)
  })

  let vorher = '', vorherB = ''

  it('dryRun liefert den Bericht und schreibt nichts (auch ohne dryRun-Parameter nicht)', async () => {
    vorher = await schnappschuss(mandantA)
    vorherB = await schnappschuss(mandantB)
    const res = await importiere(authA(), rohLayout(), 'dryRun=true')
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.dryRun).toBe(true)
    expect(b.zaehler.gruppen).toMatchObject({ imLayout: 53 })
    expect(b.zaehler.artikel).toMatchObject({ imLayout: 494, zugeordnet: 494, neu: 0, mehrdeutig: 0 })
    expect(b.zaehler.favoriten).toMatchObject({ gesetzt: 27, kassenFavoritenGeloescht: 2 })
    expect(b.zusammenfassung.length).toBeGreaterThan(3)
    expect(await schnappschuss(mandantA)).toBe(vorher)
    // Standard ist dryRun
    const ohne = await srv.fastify.inject({ method: 'POST', url: '/api/artikel/layout-import', headers: authA(), payload: rohLayout() })
    expect(ohne.json().dryRun).toBe(true)
    expect(await schnappschuss(mandantA)).toBe(vorher)
  })

  it('Anwenden: Baum, Hex-Farben, Slots, Favoriten, Raster-Spalten; Mandant B unberührt', async () => {
    const res = await importiere(authA(), rohLayout())
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.dryRun).toBe(false)
    expect(b.zaehler.artikel).toMatchObject({ zugeordnet: 494, neu: 0, mehrdeutig: 0 })
    expect(b.zaehler.kassen.rasterAufSpaltenGesetzt).toBe(1)

    const gruppen = await idb.db.select().from(kategorien).where(eq(kategorien.mandantId, mandantA))
    const art = await idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantA))
    const name = (id: string | null) => gruppen.find(g => g.id === id)?.name ?? null
    // Hauptgruppen wie im Layout, Atriumbar/Alkoholfrei/Limonaden 3 Ebenen tief
    const tops = gruppen.filter(g => g.parentId === null).map(g => g.name).sort()
    expect(tops).toEqual(layout.gruppen.map(g => g.name).sort())
    const limo = gruppen.find(g => g.name === 'Limonaden')!
    expect(name(limo.parentId)).toBe('Alkoholfrei')
    expect(name(gruppen.find(g => g.id === limo.parentId)!.parentId)).toBe('Atriumbar')
    // Farben: gesetzte Hex-Farbe bzw. Grau-Standard
    expect(gruppen.find(g => g.name === 'Atriumbar')!.farbe).toBe('#e76815')
    expect(gruppen.find(g => g.name === 'Sponsoren')!.farbe).toBe('#637685')
    // 53 Gruppen, nichts doppelt angelegt (Vorbestand deckt alle Knoten mit Artikeln ab)
    expect(gruppen.length).toBe(53)
    // Artikel: Slot, Reihenfolge, eigene Farbe; Preis/Nummer unverändert
    const soda = art.find(a => a.bezeichnung === '0,3l Limo')!
    expect(soda).toMatchObject({ rasterPosition: 1, reihenfolge: 1, farbe: '#463123', preisBruttoCent: 111 })
    expect(name(soda.kategorieId)).toBe('Alkoholfrei')
    expect(art.every(a => a.rasterPosition !== null && a.rasterPosition === a.reihenfolge)).toBe(true)
    expect(art.filter(a => a.farbe === null).length).toBe(layout.gruppen.flatMap(function alle(g: typeof layout.gruppen[number]): typeof g.artikel { return [...g.artikel, ...g.untergruppen.flatMap(alle)] }).filter(a => !a.farbe).length)
    // Favoriten: genau 27 in fester Reihenfolge; alter Favorit weg; Kassen-Liste gelöscht
    const favs = art.filter(a => a.istFavorit).sort((x, y) => x.favoritenReihenfolge - y.favoritenReihenfolge)
    expect(favs).toHaveLength(27)
    expect(favs.map(f => f.favoritenReihenfolge)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1))
    expect(favs[0]!.bezeichnung).toBe('0,3l Soda')
    expect(await idb.db.select().from(kasseFavoriten).where(eq(kasseFavoriten.mandantId, mandantA))).toHaveLength(0)
    const [k] = await idb.db.select().from(kassen).where(eq(kassen.mandantId, mandantA))
    expect(k!.artikelProZeile).toBe(3)
    // Mandant B: byte-identisch
    expect(await schnappschuss(mandantB)).toBe(vorherB)
    expect(vorher).not.toBe(await schnappschuss(mandantA))
  })

  it('zweiter Lauf ändert nichts mehr (idempotent, auch updatedAt)', async () => {
    const nachErstem = await schnappschuss(mandantA)
    const res = await importiere(authA(), rohLayout())
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.zaehler.gruppen).toMatchObject({ neu: 0, geaendert: 0, umgehaengt: 0, gefunden: 53 })
    expect(b.zaehler.artikel).toMatchObject({ neu: 0, geaendert: 0, zugeordnet: 494, mehrdeutig: 0 })
    expect(b.zaehler.favoriten).toMatchObject({ gesetzt: 27, entfernt: 0, kassenFavoritenGeloescht: 0 })
    expect(b.zaehler.kassen.rasterAufSpaltenGesetzt).toBe(0)
    expect(await schnappschuss(mandantA)).toBe(nachErstem)
  })

  it('Mandant B importiert nur in den eigenen Bestand — A und fremde Artikel bleiben unberührt', async () => {
    const aVorher = await schnappschuss(mandantA)
    const winzig = { gruppen: [{ name: 'Speisen', farbe: '#112233', artikel: [{ name: 'Brez´n', preisCent: 1, mwst: 0.2, slot: 3 }] }] }
    // mandantId im Body wird ignoriert (Schema kennt es nicht) — B kann A nicht ansprechen
    const res = await importiere(authB(), { ...winzig, mandantId: mandantA })
    expect(res.statusCode).toBe(200)
    expect(res.json().zaehler.artikel).toMatchObject({ zugeordnet: 1, neu: 0 })
    expect(await schnappschuss(mandantA)).toBe(aVorher)
    const [bart] = await idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantB))
    expect(bart).toMatchObject({ rasterPosition: 3, preisBruttoCent: 222 })
    const [bgr] = await idb.db.select().from(kategorien).where(eq(kategorien.mandantId, mandantB))
    expect(bgr).toMatchObject({ farbe: '#112233' })
  })

  it('fehlende Artikel werden angelegt (mit Steuersatz, geerbter Gruppe) — abschaltbar; negative Preise nie', async () => {
    const neu = {
      gruppen: [{ name: 'Neuheiten', farbe: '#abcdef', artikel: [
        { name: 'Neu 1', preisCent: 250, mwst: 0.13, slot: 2 },
        { name: 'Pfand zurück', preisCent: -50, mwst: 0.2, slot: 3 },
      ] }],
    }
    const aus = await importiere(authA(), neu, 'dryRun=false&fehlendeAnlegen=false')
    expect(aus.json().zaehler.artikel).toMatchObject({ neu: 0, nichtGefundenNichtAngelegt: 2 })
    const an = await importiere(authA(), neu)
    expect(an.json().zaehler.artikel).toMatchObject({ neu: 1, nichtGefundenNichtAngelegt: 1 })
    const [n1] = (await idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantA))).filter(a => a.bezeichnung === 'Neu 1')
    expect(n1).toMatchObject({ preisBruttoCent: 250, mwstSatz: 'ermaessigt2', rasterPosition: 2, aktiv: true })
    expect(n1!.artikelnummer).toMatch(/^\d{4}$/)
    // zweiter Lauf: kein weiterer Artikel
    const wieder = await importiere(authA(), neu)
    expect(wieder.json().zaehler.artikel).toMatchObject({ neu: 0, zugeordnet: 1 })
  })
})

// ---------------------------------------------------------------------------
describe('Kategorie-Routen: Untergruppen + Hex-Farben (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = ''
  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })

  const anlegen = (headers: { authorization: string }, payload: object) =>
    srv.fastify.inject({ method: 'POST', url: '/api/kategorien', headers, payload })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [3, 4]) {
      const s = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: { ...setupInput(nr), kassenId: `LK-00${nr}`, uid: `ATU9999994${nr}`, firmenname: `LK ${nr}` } })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@layout-import.at`, passwort: 'layout-import-passwort-123' },
      })).json()
      if (nr === 3) tokenA = login.token; else tokenB = login.token
    }
  })
  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('Hex-Farbe wird akzeptiert und kleingeschrieben; Unsinn abgelehnt (Kategorie + Artikel)', async () => {
    const ok = await anlegen(authA(), { name: 'Hex', farbe: '#E76815' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ farbe: '#e76815', parentId: null })
    expect((await anlegen(authA(), { name: 'X', farbe: '#e76' })).statusCode).toBe(400)
    expect((await anlegen(authA(), { name: 'X', farbe: 'lachs' })).statusCode).toBe(400)
    const art = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: authA(),
      payload: { bezeichnung: 'Hex-Artikel', preisBruttoCent: 100, mwstSatz: 'normal', farbe: '#00FF00', rasterPosition: 4 },
    })
    expect(art.statusCode).toBe(201)
    expect(art.json()).toMatchObject({ farbe: '#00ff00', rasterPosition: 4 })
  })

  it('parentId: gleicher Mandant, kein Zyklus, maximale Tiefe 4, Löschschutz', async () => {
    const a = (await anlegen(authA(), { name: 'Ebene 1', farbe: 'blau' })).json()
    const b = (await anlegen(authA(), { name: 'Ebene 2', farbe: 'blau', parentId: a.id })).json()
    const c = (await anlegen(authA(), { name: 'Ebene 3', farbe: 'blau', parentId: b.id })).json()
    const d = await anlegen(authA(), { name: 'Ebene 4', farbe: 'blau', parentId: c.id })
    expect(d.statusCode).toBe(201)
    expect(d.json().parentId).toBe(c.id)
    // Ebene 5 → zu tief
    expect((await anlegen(authA(), { name: 'Ebene 5', farbe: 'blau', parentId: d.json().id })).statusCode).toBe(400)
    // Zyklus: a unter seine eigene Enkelin c; a unter sich selbst
    const put = (id: string, payload: object, h = authA()) => srv.fastify.inject({ method: 'PUT', url: `/api/kategorien/${id}`, headers: h, payload })
    expect((await put(a.id, { parentId: c.id })).statusCode).toBe(400)
    expect((await put(a.id, { parentId: a.id })).statusCode).toBe(400)
    // Teilbaum-Tiefe zählt: neue Gruppe mit Kind unter Ebene 4 wäre zu tief
    const x = (await anlegen(authA(), { name: 'Solo', farbe: 'blau' })).json()
    await anlegen(authA(), { name: 'Solo-Kind', farbe: 'blau', parentId: x.id })
    expect((await put(x.id, { parentId: c.id })).statusCode).toBe(400)
    // Mandant B kann nicht unter A's Gruppe hängen (404 wie unbekannt → 400)
    expect((await anlegen(authB(), { name: 'Fremd', farbe: 'blau', parentId: a.id })).statusCode).toBe(400)
    // Gruppe mit aktiver Untergruppe nicht deaktivieren
    const del = await srv.fastify.inject({ method: 'DELETE', url: `/api/kategorien/${a.id}`, headers: authA() })
    expect(del.statusCode).toBe(409)
    // Blatt darf deaktiviert werden, danach auch der Elternteil
    expect((await srv.fastify.inject({ method: 'DELETE', url: `/api/kategorien/${d.json().id}`, headers: authA() })).statusCode).toBe(200)
    // verschieben ins Nichts: parentId null macht die Gruppe zur Hauptgruppe
    const frei = await put(c.id, { parentId: null })
    expect(frei.statusCode).toBe(200)
    expect(frei.json().parentId).toBeNull()
    // Liste enthält parentId
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/kategorien', headers: authA() })).json() as { id: string; parentId: string | null }[]
    expect(liste.find(k => k.id === b.id)!.parentId).toBe(a.id)
  })
})
