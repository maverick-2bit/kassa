/**
 * Integrationstest: Layout-Import mit katalogLoeschen=true („Sauberer Neustart") gegen echtes PostgreSQL.
 *
 * Vorbestand mit ECHTEN Verweisen: Seriennummer, Inventurposition (abgeschlossen + offen), Preisregeln,
 * Rezept, Optionsgruppe, Kassen-Favoriten, Kassen-Sichtbarkeit, offener Tisch-Tab, Belege mit dem Artikel.
 * Geprüft: dryRun schreibt nichts und nennt exakt, was passiert; Anwenden löscht hart, außer wo laufende
 * Vorgänge dranhängen (dann nur deaktiviert + Grund); Belege/DEP bleiben unberührt und lesbar; neuer Baum,
 * Stationen, Optionen da; Mandant B byte-identisch; ein zweiter Lauf OHNE katalogLoeschen ändert nichts.
 * Zusätzlich: alle Fremdschlüssel auf artikel/kategorien/modifikator_gruppen sind bekannt (information_schema).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { validiereDEP7, dep7AusJson, type FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse, LayoutImport } from '@kassa/shared'
import {
  artikel, artikelBestandteile, artikelModifikatorGruppen, belege, inventuren, inventurPositionen, kassekategorieSichtbarkeit,
  kassen, kasseFavoriten, kategorien, modifikatoren, modifikatorGruppen, preisregeln, seriennummern,
} from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const mockFoClient = (): FinanzOnlineClient => ({
  kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
  startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KL-PW' }),
  kasseAusserBetriebNehmen: vi.fn(),
} as unknown as FinanzOnlineClient)

const setupInput = (nr: number) => ({
  firmenname: `Loeschen ${nr} GmbH`, uid: `ATU9999966${nr}`, kassenId: `KL-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-KL-${nr}`, benutzerkennung: `BID-KL-${nr}`, pin: `PIN-KL-${nr}` }, umgebung: 'test',
  admin: { name: `KL Admin ${nr}`, email: `admin${nr}@katalog-loeschen.at`, passwort: 'katalog-loeschen-passwort-123' },
})

const layout = (): LayoutImport => ({
  spalten: 3,
  gruppen: [{
    name: 'Neue Bar', farbe: '#112233', farbeGesetzt: true, reihenfolge: 1, station: 'schank', artikel: [],
    untergruppen: [{
      name: 'Neue Getränke', farbe: '#445566', farbeGesetzt: true, reihenfolge: 1, station: null, untergruppen: [],
      artikel: [
        { name: 'Neu Cola', preisCent: 350, mwst: 0.2, slot: 1, farbe: '#aabbcc', optionen: [
          { gruppe: 'Variante', pflicht: true, mehrfach: false, optionen: [{ name: 'mit Eis', aufschlagCent: 0 }, { name: 'Ohne Soda', aufschlagCent: -200 }] },
        ] },
        { name: 'Becher retour', preisCent: -200, mwst: 0, slot: 3, farbe: null, optionen: [] },
      ],
    }],
  }],
  favoriten: [{ name: 'Neu Cola', pfad: 'Neue Bar/Neue Getränke' }],
} as unknown as LayoutImport)

describe('Sauberer Neustart: Katalog löschen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = '', mandantA = '', mandantB = '', kasseA = ''
  const authA = () => ({ authorization: `Bearer ${tokenA}` })

  let altX = '', altY = '', altZ = '', altW = '', altBestandteil = '', altGruppe = '', altGruppeY = '', optGruppe = ''
  let belegId = ''

  const importiere = (query: string, body: unknown = layout(), token = authA()) =>
    srv.fastify.inject({ method: 'POST', url: `/api/artikel/layout-import?${query}`, headers: token, payload: body as object })

  async function schnappschuss(mandantId: string) {
    const [g, a, k, f, og, mo, sn, pr, ip, bl] = await Promise.all([
      idb.db.select().from(kategorien).where(eq(kategorien.mandantId, mandantId)),
      idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantId)),
      idb.db.select().from(kassen).where(eq(kassen.mandantId, mandantId)),
      idb.db.select().from(kasseFavoriten).where(eq(kasseFavoriten.mandantId, mandantId)),
      idb.db.select().from(modifikatorGruppen).where(eq(modifikatorGruppen.mandantId, mandantId)),
      idb.db.select().from(modifikatoren).where(eq(modifikatoren.mandantId, mandantId)),
      idb.db.select().from(seriennummern).where(eq(seriennummern.mandantId, mandantId)),
      idb.db.select().from(preisregeln).where(eq(preisregeln.mandantId, mandantId)),
      idb.db.select({ id: inventurPositionen.id, a: inventurPositionen.artikelId, soll: inventurPositionen.sollMenge }).from(inventurPositionen)
        .innerJoin(inventuren, eq(inventurPositionen.inventurId, inventuren.id)).where(eq(inventuren.mandantId, mandantId)),
      idb.db.select().from(belege).where(eq(belege.mandantId, mandantId)),
    ])
    const s = <T extends { id: string }>(l: T[]) => [...l].sort((x, y) => x.id.localeCompare(y.id))
    return JSON.stringify({ g: s(g), a: s(a), k: s(k), f: s(f), og: s(og), mo: s(mo), sn: s(sn), pr: s(pr), ip: s(ip), bl: s(bl) },
      (_k, w) => (typeof w === 'bigint' ? w.toString() : w))
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2]) {
      const s = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@katalog-loeschen.at`, passwort: 'katalog-loeschen-passwort-123' },
      })).json()
      const mandantId = srv.fastify.jwt.decode<{ mandantId: string }>(login.token)!.mandantId
      if (nr === 1) { tokenA = login.token; mandantA = mandantId; kasseA = login.kassen[0].id } else { tokenB = login.token; mandantB = mandantId }
    }

    // ---- Mandant A: Altbestand mit Verweisen ----
    const [g1] = await idb.db.insert(kategorien).values({ mandantId: mandantA, name: 'Alt Getränke', farbe: 'blau', station: 'kueche' }).returning()
    const [g2] = await idb.db.insert(kategorien).values({ mandantId: mandantA, name: 'Alt Offen', farbe: 'rot', parentId: g1!.id }).returning()
    altGruppe = g1!.id; altGruppeY = g2!.id
    const mk = async (bezeichnung: string, kategorieId: string, nr: string, extra: object = {}) =>
      (await idb.db.insert(artikel).values({ mandantId: mandantA, bezeichnung, preisBruttoCent: 400, mwstSatz: 'normal', artikelnummer: nr, kategorieId, ...extra }).returning())[0]!.id
    altX = await mk('Alt X (Seriennummer, Beleg, Preisregel)', altGruppe, '0001', { seriennummernAktiv: true, istFavorit: true, favoritenReihenfolge: 1 })
    altW = await mk('Alt W (abgeschlossene Inventur)', altGruppe, '0002')
    altY = await mk('Alt Y (offene Inventur)', altGruppeY, '0003')
    altZ = await mk('Alt Z (offener Tisch)', altGruppeY, '0004')
    altBestandteil = await mk('Alt Rohstoff', altGruppe, '0005', { istBestandteil: true })
    await idb.db.insert(artikelBestandteile).values({ mandantId: mandantA, verkaufsartikelId: altX, bestandteilArtikelId: altBestandteil, menge: 1 })

    // Option am Altartikel
    const [og] = await idb.db.insert(modifikatorGruppen).values({ mandantId: mandantA, name: 'Alt Option' }).returning()
    optGruppe = og!.id
    await idb.db.insert(modifikatoren).values({ mandantId: mandantA, gruppeId: optGruppe, name: 'klein', aufschlagCent: 0, reihenfolge: 0 })
    await idb.db.insert(artikelModifikatorGruppen).values({ artikelId: altX, gruppeId: optGruppe, reihenfolge: 0 })

    // Seriennummern (harter FK ohne Cascade)
    await idb.db.insert(seriennummern).values([
      { mandantId: mandantA, artikelId: altX, seriennummer: 'SN-1' }, { mandantId: mandantA, artikelId: altX, seriennummer: 'SN-2', status: 'verkauft' },
    ])
    // Inventuren: eine abgeschlossen (Artikel W), eine offen (Artikel Y)
    const [invZu] = await idb.db.insert(inventuren).values({ mandantId: mandantA, bezeichnung: 'Alt', status: 'abgeschlossen' }).returning()
    const [invOffen] = await idb.db.insert(inventuren).values({ mandantId: mandantA, bezeichnung: 'Läuft', status: 'offen' }).returning()
    await idb.db.insert(inventurPositionen).values([
      { inventurId: invZu!.id, artikelId: altW, bezeichnung: 'Alt W', sollMenge: 3 },
      { inventurId: invOffen!.id, artikelId: altY, bezeichnung: 'Alt Y', sollMenge: 2 },
    ])
    // Preisregeln (jsonb ohne FK): eingegrenzt auf X (wird scope-los → deaktiviert), gemischt X+Y (bleibt, nur Y)
    await idb.db.insert(preisregeln).values([
      { mandantId: mandantA, name: 'Nur X', wochentage: [1], rabattProzent: 10, artikelIds: [altX], kategorieIds: [], artikelPreise: [{ artikelId: altX, preisCent: 100 }] },
      { mandantId: mandantA, name: 'X und Y', wochentage: [1], rabattProzent: 10, artikelIds: [altX, altY], kategorieIds: [altGruppe], artikelPreise: [] },
      { mandantId: mandantA, name: 'Global', wochentage: [1], rabattProzent: 5, artikelIds: [], kategorieIds: [], artikelPreise: [] },
    ])
    // Kassen-Listen
    await idb.db.insert(kasseFavoriten).values([{ mandantId: mandantA, kasseId: kasseA, position: 1, artikelId: altX }, { mandantId: mandantA, kasseId: kasseA, position: 2, artikelId: null }])
    await idb.db.insert(kassekategorieSichtbarkeit).values({ kasseId: kasseA, kategorieId: altGruppe })
    await idb.db.update(kassen).set({ startKategorieId: altGruppe }).where(eq(kassen.id, kasseA))
    // Offener Tisch-Tab mit Artikel Z
    const tab = await srv.fastify.inject({ method: 'POST', url: '/api/tisch-tabs', headers: authA(), payload: { kasseId: kasseA, tischNummer: 'T1', kellner: 'Anna' } })
    expect(tab.statusCode, tab.body).toBe(201)
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tab.json().id}/positionen`, headers: authA(),
      payload: { positionen: [{ artikelId: altZ, bezeichnung: 'Alt Z', preisBruttoCent: 400, menge: 1 }] },
    })
    expect(put.statusCode, put.body).toBe(200)
    // Beleg mit Artikel X (Snapshot im Beleg)
    const b = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: authA(),
      payload: { kasseId: kasseA, positionen: [{ artikelId: altW, menge: 1 }], zahlung: { barCent: 400, karteCent: 0, sonstigeCent: 0 } },
    })
    expect(b.statusCode, b.body).toBe(201)
    belegId = b.json().id

    // ---- Mandant B: gleiche Art Bestand, muss unberührt bleiben ----
    const [gb] = await idb.db.insert(kategorien).values({ mandantId: mandantB, name: 'B Gruppe', farbe: 'rot' }).returning()
    const [ab] = await idb.db.insert(artikel).values({ mandantId: mandantB, bezeichnung: 'B Artikel', preisBruttoCent: 100, mwstSatz: 'normal', artikelnummer: '0001', kategorieId: gb!.id, seriennummernAktiv: true }).returning()
    await idb.db.insert(seriennummern).values({ mandantId: mandantB, artikelId: ab!.id, seriennummer: 'B-1' })
    await idb.db.insert(modifikatorGruppen).values({ mandantId: mandantB, name: 'B Option' })
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  it('alle Fremdschlüssel auf artikel/kategorien/modifikator_gruppen/modifikatoren sind bekannt (Schema-Wächter)', async () => {
    const zeilen = await idb.db.execute(sql`
      SELECT c.conrelid::regclass::text AS tabelle, a.attname AS spalte, c.confrelid::regclass::text AS ziel, c.confdeltype AS regel
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid::regclass::text IN ('artikel', 'kategorien', 'modifikator_gruppen', 'modifikatoren')
      ORDER BY 1, 2`)
    const regel: Record<string, string> = { a: 'NO ACTION', c: 'CASCADE', n: 'SET NULL', r: 'RESTRICT', d: 'DEFAULT' }
    const gefunden = (zeilen as unknown as { tabelle: string; spalte: string; ziel: string; regel: string }[])
      .map(z => `${z.tabelle}.${z.spalte} -> ${z.ziel} (${regel[z.regel]})`)
    // Neue Verweise auf Artikel/Warengruppen/Optionen MÜSSEN in katalog-loeschen.service.ts bedacht werden —
    // dann diese Liste bewusst erweitern.
    const bekannt = [
      'artikel.kategorie_id -> kategorien (NO ACTION)',
      'artikel_bestandteile.bestandteil_artikel_id -> artikel (CASCADE)',
      'artikel_bestandteile.verkaufsartikel_id -> artikel (CASCADE)',
      'artikel_modifikator_gruppen.artikel_id -> artikel (CASCADE)',
      'artikel_modifikator_gruppen.gruppe_id -> modifikator_gruppen (CASCADE)',
      'inventur_positionen.artikel_id -> artikel (NO ACTION)',
      'kasse_artikel_layout.artikel_id -> artikel (CASCADE)',
      'kasse_artikel_layout.kategorie_id -> kategorien (CASCADE)',
      'kasse_favoriten.artikel_id -> artikel (CASCADE)',
      'kasse_kategorie_sichtbarkeit.kategorie_id -> kategorien (CASCADE)',
      'kassen.start_kategorie_id -> kategorien (SET NULL)',
      'kategorien.parent_id -> kategorien (SET NULL)',
      'modifikatoren.gruppe_id -> modifikator_gruppen (CASCADE)',
      'seriennummern.artikel_id -> artikel (NO ACTION)',
    ]
    expect([...new Set(gefunden)].sort()).toEqual(bekannt.sort())
  })

  let vorher = '', vorherB = ''

  it('dryRun nennt exakt, was gelöscht und was nur deaktiviert würde — und schreibt nichts', async () => {
    vorher = await schnappschuss(mandantA); vorherB = await schnappschuss(mandantB)
    const res = await importiere('dryRun=true&katalogLoeschen=true')
    expect(res.statusCode, res.body).toBe(200)
    const b = res.json()
    expect(b.dryRun).toBe(true)
    // 5 Artikel, 2 Gruppen; Y (offene Inventur) + Z (offener Tisch) bleiben → 3 Artikel gelöscht, Gruppe „Alt Offen" bleibt
    expect(b.katalogLoeschen.aktiv).toBe(true)
    expect(b.katalogLoeschen.geloescht).toMatchObject({ artikel: 3, gruppen: 1, optionsgruppen: 1, seriennummern: 2, inventurPositionen: 1, sichtbarkeiten: 1, kassenFavoriten: 2, preisregelnBereinigt: 2 })
    expect(b.katalogLoeschen.nurDeaktiviert.artikel.map((a: { grund: string }) => a.grund).sort()).toEqual(['offene Inventur', 'offener Tisch'])
    expect(b.katalogLoeschen.nurDeaktiviert.gruppen).toHaveLength(1)
    expect(b.zusammenfassung[0]).toMatch(/würde löschen/)
    expect(await schnappschuss(mandantA)).toBe(vorher)
  })

  it('Anwenden: hartes Löschen, Fallback-Deaktivierung, neuer Baum mit Stationen und Optionen', async () => {
    const res = await importiere('dryRun=false&katalogLoeschen=true')
    expect(res.statusCode, res.body).toBe(200)
    const b = res.json()
    expect(b.zaehler.artikel).toMatchObject({ zugeordnet: 0, neu: 2 })       // nichts wiederverwendet
    expect(b.zaehler.optionen).toMatchObject({ gruppenNeu: 1, zuordnungenNeu: 1 })

    const art = await idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantA))
    const gruppen = await idb.db.select().from(kategorien).where(eq(kategorien.mandantId, mandantA))
    // gelöscht: X, W, Rohstoff — behalten (deaktiviert): Y, Z
    const alte = art.filter(a => [altX, altW, altY, altZ, altBestandteil].includes(a.id))
    expect(alte.map(a => a.id).sort()).toEqual([altY, altZ].sort())
    expect(alte.every(a => !a.aktiv && !a.istFavorit)).toBe(true)
    expect(gruppen.find(g => g.id === altGruppe)).toBeUndefined()
    expect(gruppen.find(g => g.id === altGruppeY)).toMatchObject({ aktiv: false })
    // abhängige Zeilen mit weg
    expect(await idb.db.select().from(seriennummern).where(eq(seriennummern.mandantId, mandantA))).toHaveLength(0)
    expect((await idb.db.select().from(inventurPositionen)).filter(p => p.artikelId === altW)).toHaveLength(0)
    expect((await idb.db.select().from(inventurPositionen)).filter(p => p.artikelId === altY)).toHaveLength(1)
    expect(await idb.db.select().from(artikelBestandteile).where(eq(artikelBestandteile.mandantId, mandantA))).toHaveLength(0)
    expect(await idb.db.select().from(kasseFavoriten).where(eq(kasseFavoriten.mandantId, mandantA))).toHaveLength(0)
    expect(await idb.db.select().from(kassekategorieSichtbarkeit).where(eq(kassekategorieSichtbarkeit.kasseId, kasseA))).toHaveLength(0)
    expect((await idb.db.select().from(kassen).where(eq(kassen.id, kasseA)))[0]).toMatchObject({ startKategorieId: null, artikelProZeile: 3 })
    // Preisregeln bereinigt: „Nur X" scope-los → deaktiviert (nicht plötzlich global!), „X und Y" behält nur Y, „Global" unverändert
    const pr = new Map((await idb.db.select().from(preisregeln).where(eq(preisregeln.mandantId, mandantA))).map(p => [p.name, p]))
    expect(pr.get('Nur X')).toMatchObject({ aktiv: false, artikelIds: [], artikelPreise: [] })
    expect(pr.get('X und Y')).toMatchObject({ aktiv: true, artikelIds: [altY], kategorieIds: [] })
    expect(pr.get('Global')).toMatchObject({ aktiv: true, rabattProzent: 5 })
    // alte Optionsgruppe weg, neue da (Name lesbar), samt Optionen und Zuordnung
    const ogs = await idb.db.select().from(modifikatorGruppen).where(eq(modifikatorGruppen.mandantId, mandantA))
    expect(ogs.map(o => o.name)).toEqual(['Variante (mit Eis / Ohne Soda)'])
    expect(ogs[0]).toMatchObject({ typ: 'pflicht', maxAuswahl: 1 })
    const mods = await idb.db.select().from(modifikatoren).where(eq(modifikatoren.gruppeId, ogs[0]!.id))
    expect(mods.sort((x, y) => x.reihenfolge - y.reihenfolge).map(m => [m.name, m.aufschlagCent])).toEqual([['mit Eis', 0], ['Ohne Soda', -200]])
    // neuer Baum mit Station aus dem Layout (Hauptgruppe schank; Untergruppe ohne Angabe erbt nichts → null)
    const neu = gruppen.filter(g => g.aktiv)
    const bar = neu.find(g => g.name === 'Neue Bar')!, sub = neu.find(g => g.name === 'Neue Getränke')!
    expect(bar).toMatchObject({ parentId: null, farbe: '#112233', station: 'schank' })
    expect(sub).toMatchObject({ parentId: bar.id, farbe: '#445566' })
    const cola = art.find(a => a.bezeichnung === 'Neu Cola')!, becher = art.find(a => a.bezeichnung === 'Becher retour')!
    expect(cola).toMatchObject({ kategorieId: sub.id, rasterPosition: 1, farbe: '#aabbcc', station: null, istFavorit: true, favoritenReihenfolge: 1, aktiv: true })
    expect(becher).toMatchObject({ preisBruttoCent: -200, mwstSatz: 'null', rasterPosition: 3 })
    // Artikelnummern: laufen weiter ab dem höchsten verbliebenen (kein Konflikt mit den behaltenen 0003/0004)
    expect(new Set(art.map(a => a.artikelnummer)).size).toBe(art.length)
    expect(cola.artikelnummer).toBe('0005')

    // Belege unberührt und weiter lesbar; DEP gültig
    const liste = (await srv.fastify.inject({ method: 'GET', url: `/api/belege?kasseId=${kasseA}&limit=500`, headers: authA() })).json() as BelegResponse[]
    const beleg = liste.find(x => x.id === belegId)!
    expect(beleg.positionen[0]).toMatchObject({ bezeichnung: 'Alt W (abgeschlossene Inventur)', einzelpreisBreutto: 400 })
    const dep = await srv.fastify.inject({ method: 'GET', url: `/api/belege/dep7?kasseId=${kasseA}`, headers: authA() })
    expect(validiereDEP7(dep7AusJson(dep.body)).gueltig).toBe(true)
    expect(await idb.db.select().from(belege).where(and(eq(belege.mandantId, mandantA), inArray(belege.id, [belegId])))).toHaveLength(1)
    expect(await schnappschuss(mandantB)).toBe(vorherB)
  })

  it('zweiter Lauf OHNE katalogLoeschen ändert nichts mehr', async () => {
    const nach = await schnappschuss(mandantA)
    const res = await importiere('dryRun=false')
    expect(res.statusCode, res.body).toBe(200)
    const b = res.json()
    expect(b.zaehler.gruppen).toMatchObject({ neu: 0, geaendert: 0 })
    expect(b.zaehler.artikel).toMatchObject({ neu: 0, geaendert: 0, zugeordnet: 2 })
    expect(b.zaehler.optionen).toMatchObject({ gruppenNeu: 0, zuordnungenNeu: 0, gruppenWiederverwendet: 1 })
    expect(b.katalogLoeschen.aktiv).toBe(false)
    expect(await schnappschuss(mandantA)).toBe(nach)
  })

  it('wiederholtes katalogLoeschen legt bewusst alles NEU an (neue IDs, alte gelöscht)', async () => {
    const vorherIds = (await idb.db.select({ id: artikel.id }).from(artikel).where(and(eq(artikel.mandantId, mandantA), eq(artikel.aktiv, true)))).map(a => a.id)
    const res = await importiere('dryRun=false&katalogLoeschen=true')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().zaehler.artikel).toMatchObject({ neu: 2, zugeordnet: 0 })
    const jetzt = (await idb.db.select({ id: artikel.id }).from(artikel).where(and(eq(artikel.mandantId, mandantA), eq(artikel.aktiv, true)))).map(a => a.id)
    expect(jetzt).toHaveLength(2)
    expect(jetzt.some(id => vorherIds.includes(id))).toBe(false)
    expect(await schnappschuss(mandantB)).toBe(vorherB)
  })

  it('nur Admin; Mandant B löscht nur den eigenen Katalog', async () => {
    const kellner = { authorization: `Bearer ${srv.signTestToken({ rolle: 'kellner', mandantId: mandantA })}` }
    expect((await importiere('dryRun=true&katalogLoeschen=true', layout(), kellner)).statusCode).toBe(403)
    expect((await importiere('dryRun=true&katalogLoeschen=vielleicht')).statusCode).toBe(400)
    const aVorher = await schnappschuss(mandantA)
    const res = await importiere('dryRun=false&katalogLoeschen=true', { ...layout(), mandantId: mandantA }, { authorization: `Bearer ${tokenB}` })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().katalogLoeschen.geloescht).toMatchObject({ artikel: 1, gruppen: 1, optionsgruppen: 1, seriennummern: 1 })
    expect(await schnappschuss(mandantA)).toBe(aVorher)
    expect(await idb.db.select().from(artikel).where(eq(artikel.mandantId, mandantB)).then(r => r.filter(a => a.bezeichnung === 'B Artikel'))).toHaveLength(0)
  })
})
