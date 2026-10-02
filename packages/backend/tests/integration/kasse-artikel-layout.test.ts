/**
 * Integrationstest: Artikel-Anordnung je Kasse + Warengruppe (Kachel-Raster) und Standard-Raster.
 *
 *  - GET  /api/kassen/:kasseId/artikel-layouts                 alle Anordnungen der Kasse (jede Rolle)
 *  - PUT  /api/kassen/:kasseId/artikel-layouts/:kategorieId    ersetzt die Anordnung (nur Admin)
 *  - DELETE …/:kategorieId                                     zurück auf Standard (nur Admin)
 *  - PUT  /api/kategorien/:kategorieId/artikel-raster          Standard-Raster (raster_position + reihenfolge)
 *
 * Geprüft: Ersetzen statt Anhängen, Kassen und Warengruppen unabhängig, Validierung (400), Mandanten-
 * Isolation (fremde IDs 404, Mandant B unberührt), nur Admin schreibt, Lesewege filtern veraltete und
 * fremde Zeilen, Cascade beim Löschen von Kasse/Artikel/Warengruppe, Atomarität (Trigger-Fehlerinjektion),
 * gleichzeitiges Speichern.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { artikel, kasseArtikelLayout, kassen, kategorien } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KAL-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const UNBEKANNT = '00000000-0000-4000-8000-000000000000'
const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0060_kasse_artikel_layout.sql')

type Eintrag = { artikelId: string; position: number | null; ausgeblendet: boolean }
const platziert = (artikelId: string, position: number): Eintrag => ({ artikelId, position, ausgeblendet: false })
const versteckt = (artikelId: string): Eintrag => ({ artikelId, position: null, ausgeblendet: true })

describe('Artikel-Anordnung je Kasse (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  // Mandant A
  let tokenA = '', mandantA = '', kasseA1 = '', kasseA2 = ''
  // Mandant B
  let tokenB = '', mandantB = '', kasseB = ''
  let tokenKellner = ''

  const mit = (token: string) => ({ authorization: `Bearer ${token}` })
  const api = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) =>
    srv.fastify.inject({
      method, url, headers: mit(token),
      ...(payload !== undefined && { payload: payload as object }),
    })
  const holeLayouts = async (kasseId: string, token = tokenA) => {
    const res = await api('GET', `/api/kassen/${kasseId}/artikel-layouts`, token)
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as { kategorieId: string; eintraege: Eintrag[] }[]
  }
  const layoutVon = async (kasseId: string, kategorieId: string) =>
    (await holeLayouts(kasseId)).find(l => l.kategorieId === kategorieId)?.eintraege
  const speichere = (kasseId: string, kategorieId: string, eintraege: Eintrag[], token = tokenA) =>
    api('PUT', `/api/kassen/${kasseId}/artikel-layouts/${kategorieId}`, token, { eintraege })

  let zaehler = 0
  /** Frische Warengruppe mit n Artikeln — jeder Test arbeitet auf eigenen Daten */
  const gruppeMitArtikeln = async (token: string, n: number, extra: (i: number) => object = () => ({})) => {
    const nr = ++zaehler
    const kategorie = (await api('POST', '/api/kategorien', token, { name: `Gruppe ${nr}`, farbe: 'blau' })).json()
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const res = await api('POST', '/api/artikel', token, {
        bezeichnung: `Artikel ${nr}.${i + 1}`, preisBruttoCent: 400, mwstSatz: 'normal',
        kategorieId: kategorie.id, ...extra(i),
      })
      expect(res.statusCode, res.body).toBe(201)
      ids.push(res.json().id)
    }
    return { kategorieId: kategorie.id as string, ids }
  }

  async function setup(nr: number, email: string) {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: `Anordnung ${nr} GmbH`, uid: `ATU9999942${nr}`, kassenId: `KAL-00${nr}`,
        finanzOnline: { teilnehmerId: `TID-KAL${nr}`, benutzerkennung: `BID-KAL${nr}`, pin: `PIN-KAL${nr}` },
        umgebung: 'test',
        admin: { name: `Admin ${nr}`, email, passwort: 'kasse-artikel-layout-123' },
      },
    })
    if (res.statusCode !== 201) throw new Error(`Setup ${nr} (${res.statusCode}): ${res.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email, passwort: 'kasse-artikel-layout-123' },
    })).json()
    return { token: login.token as string, mandantId: login.mandant.id as string, kasseId: login.kassen[0].id as string }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    ;({ token: tokenA, mandantId: mandantA, kasseId: kasseA1 } = await setup(1, 'admin1@kasse-artikel-layout.at'))
    ;({ token: tokenB, mandantId: mandantB, kasseId: kasseB } = await setup(2, 'admin2@kasse-artikel-layout.at'))

    // zweite Kasse von Mandant A
    const zweite = await api('POST', '/api/kassen', tokenA, { kassenId: 'KAL-001-B', bezeichnung: 'Bar', umgebung: 'test' })
    expect(zweite.statusCode, zweite.body).toBe(201)
    kasseA2 = zweite.json().kasseId

    // PIN-Kellner (kein Admin) an Kasse A1 — liest die Anordnung wie die Kellner-App
    const anlage = await api('POST', '/api/users', tokenA, {
      name: 'Kellner Karl', rolle: 'kellner', berechtigungen: ['tische', 'kasse'], kassenIds: [kasseA1], pin: '4711',
    })
    expect(anlage.statusCode, anlage.body).toBe(201)
    const pin = await srv.fastify.inject({ method: 'POST', url: '/api/auth/pin-login', payload: { kasseId: kasseA1, pin: '4711' } })
    expect(pin.statusCode, pin.body).toBe(200)
    tokenKellner = pin.json().token
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  // -------------------------------------------------------------------------
  it('startet ohne Anordnung: GET liefert eine leere Liste', async () => {
    expect(await holeLayouts(kasseA1)).toEqual([])
  })

  it('speichert platzierte und ausgeblendete Artikel; GET liefert sie nach Position, Ausgeblendete zuletzt', async () => {
    const { kategorieId, ids: [cola, fanta, soda] } = await gruppeMitArtikeln(tokenA, 3) as { kategorieId: string; ids: [string, string, string] }
    const res = await speichere(kasseA1, kategorieId, [versteckt(soda), platziert(fanta, 5), platziert(cola, 2)])
    expect(res.statusCode, res.body).toBe(204)
    expect(await layoutVon(kasseA1, kategorieId)).toEqual([platziert(cola, 2), platziert(fanta, 5), versteckt(soda)])
  })

  it('PUT ersetzt die Anordnung komplett (kein Anhängen) und kennt Lücken in den Positionen', async () => {
    const { kategorieId, ids: [a, b, c] } = await gruppeMitArtikeln(tokenA, 3) as { kategorieId: string; ids: [string, string, string] }
    await speichere(kasseA1, kategorieId, [platziert(a, 1), platziert(b, 2), platziert(c, 3)])
    expect((await speichere(kasseA1, kategorieId, [platziert(c, 1), platziert(a, 7)])).statusCode).toBe(204)
    expect(await layoutVon(kasseA1, kategorieId)).toEqual([platziert(c, 1), platziert(a, 7)])
  })

  it('Positionen lassen sich tauschen, ohne an der eindeutigen Position zu scheitern (alle Zeilen werden ersetzt)', async () => {
    const { kategorieId, ids: [a, b] } = await gruppeMitArtikeln(tokenA, 2) as { kategorieId: string; ids: [string, string] }
    await speichere(kasseA1, kategorieId, [platziert(a, 1), platziert(b, 2)])
    expect((await speichere(kasseA1, kategorieId, [platziert(a, 2), platziert(b, 1)])).statusCode).toBe(204)
    expect(await layoutVon(kasseA1, kategorieId)).toEqual([platziert(b, 1), platziert(a, 2)])
  })

  it('leere Liste = zurück auf Standard (Zeilen weg)', async () => {
    const { kategorieId, ids: [a] } = await gruppeMitArtikeln(tokenA, 1) as { kategorieId: string; ids: [string] }
    await speichere(kasseA1, kategorieId, [platziert(a, 1)])
    expect((await speichere(kasseA1, kategorieId, [])).statusCode).toBe(204)
    expect(await layoutVon(kasseA1, kategorieId)).toBeUndefined()
  })

  it('Kassen und Warengruppen sind unabhängig: dieselben Positionen je Kasse, andere Gruppen bleiben unberührt', async () => {
    const g1 = await gruppeMitArtikeln(tokenA, 2)
    const g2 = await gruppeMitArtikeln(tokenA, 2)
    await speichere(kasseA1, g1.kategorieId, [platziert(g1.ids[0]!, 1), platziert(g1.ids[1]!, 2)])
    await speichere(kasseA1, g2.kategorieId, [platziert(g2.ids[0]!, 3)])
    // zweite Kasse: dieselben Positionen sind erlaubt (Eindeutigkeit gilt je Kasse + Warengruppe)
    expect((await speichere(kasseA2, g1.kategorieId, [platziert(g1.ids[1]!, 1), platziert(g1.ids[0]!, 2)])).statusCode).toBe(204)
    // Ändern auf Kasse A2 lässt A1 unberührt, Ändern von g1 lässt g2 unberührt
    expect(await layoutVon(kasseA1, g1.kategorieId)).toEqual([platziert(g1.ids[0]!, 1), platziert(g1.ids[1]!, 2)])
    expect(await layoutVon(kasseA2, g1.kategorieId)).toEqual([platziert(g1.ids[1]!, 1), platziert(g1.ids[0]!, 2)])
    expect(await layoutVon(kasseA1, g2.kategorieId)).toEqual([platziert(g2.ids[0]!, 3)])
    expect(await layoutVon(kasseA2, g2.kategorieId)).toBeUndefined()
    // Ersetzen von g1 auf A1 fasst g2 nicht an
    await speichere(kasseA1, g1.kategorieId, [versteckt(g1.ids[0]!)])
    expect(await layoutVon(kasseA1, g2.kategorieId)).toEqual([platziert(g2.ids[0]!, 3)])
  })

  // -------------------------------------------------------------------------
  describe('Validierung', () => {
    let kategorieId = '', a = '', b = ''
    beforeAll(async () => {
      const g = await gruppeMitArtikeln(tokenA, 2)
      kategorieId = g.kategorieId; a = g.ids[0]!; b = g.ids[1]!
      await speichere(kasseA1, kategorieId, [platziert(a, 1), platziert(b, 2)])
    })
    const bleibtUnveraendert = async () =>
      expect(await layoutVon(kasseA1, kategorieId)).toEqual([platziert(a, 1), platziert(b, 2)])

    it('doppelte Position, doppelter Artikel, Position 0/501/Bruchzahl, ausgeblendet mit Position, platziert ohne Position → 400', async () => {
      const schlecht: [string, unknown][] = [
        ['doppelte Position', [platziert(a, 1), platziert(b, 1)]],
        ['doppelter Artikel', [platziert(a, 1), versteckt(a)]],
        ['Position 0', [platziert(a, 0)]],
        ['Position 501', [platziert(a, 501)]],
        ['Bruchzahl', [platziert(a, 1.5)]],
        ['ausgeblendet mit Position', [{ artikelId: a, position: 3, ausgeblendet: true }]],
        ['platziert ohne Position', [{ artikelId: a, position: null, ausgeblendet: false }]],
        ['keine uuid', [{ artikelId: 'kein-uuid', position: 1, ausgeblendet: false }]],
      ]
      for (const [name, eintraege] of schlecht) {
        const res = await api('PUT', `/api/kassen/${kasseA1}/artikel-layouts/${kategorieId}`, tokenA, { eintraege })
        expect(res.statusCode, `${name}: ${res.body}`).toBe(400)
      }
      await bleibtUnveraendert()
    })

    it('Body ohne eintraege, falscher Typ → 400; Position 500 ist noch erlaubt', async () => {
      expect((await api('PUT', `/api/kassen/${kasseA1}/artikel-layouts/${kategorieId}`, tokenA, {})).statusCode).toBe(400)
      expect((await api('PUT', `/api/kassen/${kasseA1}/artikel-layouts/${kategorieId}`, tokenA, { eintraege: 'x' })).statusCode).toBe(400)
      await bleibtUnveraendert()
      expect((await speichere(kasseA1, kategorieId, [platziert(a, 500)])).statusCode).toBe(204)
      await speichere(kasseA1, kategorieId, [platziert(a, 1), platziert(b, 2)])
    })

    it('ungültige IDs im Pfad → 400 „Ungültige ID"', async () => {
      for (const url of [
        `/api/kassen/kein-uuid/artikel-layouts`,
        `/api/kassen/kein-uuid/artikel-layouts/${kategorieId}`,
        `/api/kassen/${kasseA1}/artikel-layouts/kein-uuid`,
      ]) {
        const methoden = url.endsWith('artikel-layouts') ? (['GET'] as const) : (['PUT', 'DELETE'] as const)
        for (const methode of methoden) {
          const res = await api(methode, url, tokenA, methode === 'PUT' ? { eintraege: [] } : undefined)
          expect(res.statusCode, `${methode} ${url}: ${res.body}`).toBe(400)
          expect(res.json().fehler).toBe('Ungültige ID')
        }
      }
      expect((await api('PUT', `/api/kategorien/kein-uuid/artikel-raster`, tokenA, { eintraege: [] })).statusCode).toBe(400)
    })

    it('Artikel einer ANDEREN Warengruppe des eigenen Mandanten → 400, nichts wird geändert', async () => {
      const andere = await gruppeMitArtikeln(tokenA, 1)
      const res = await speichere(kasseA1, kategorieId, [platziert(a, 1), platziert(andere.ids[0]!, 2)])
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().fehler).toMatch(/Warengruppe/)
      await bleibtUnveraendert()
    })

    it('unbekannter Artikel → 404, nichts wird geändert', async () => {
      const res = await speichere(kasseA1, kategorieId, [platziert(a, 1), platziert(UNBEKANNT, 2)])
      expect(res.statusCode, res.body).toBe(404)
      await bleibtUnveraendert()
    })

    it('unbekannte Kasse und unbekannte Warengruppe → 404', async () => {
      expect((await speichere(UNBEKANNT, kategorieId, [])).statusCode).toBe(404)
      expect((await speichere(kasseA1, UNBEKANNT, [])).statusCode).toBe(404)
      expect((await api('GET', `/api/kassen/${UNBEKANNT}/artikel-layouts`, tokenA)).statusCode).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  describe('Mandanten-Isolation', () => {
    let gruppeAId = '', artikelA = '', gruppeBId = '', artikelB = ''
    beforeAll(async () => {
      const ga = await gruppeMitArtikeln(tokenA, 1); gruppeAId = ga.kategorieId; artikelA = ga.ids[0]!
      const gb = await gruppeMitArtikeln(tokenB, 2); gruppeBId = gb.kategorieId; artikelB = gb.ids[0]!
      await speichere(kasseA1, gruppeAId, [platziert(artikelA, 4)])
      await speichere(kasseB, gruppeBId, [platziert(artikelB, 1), versteckt(gb.ids[1]!)], tokenB)
    })

    it('Mandant B sieht die Anordnung von A nicht und kann sie weder lesen, ändern noch löschen (404)', async () => {
      expect((await api('GET', `/api/kassen/${kasseA1}/artikel-layouts`, tokenB)).statusCode).toBe(404)
      expect((await speichere(kasseA1, gruppeAId, [], tokenB)).statusCode).toBe(404)
      expect((await api('DELETE', `/api/kassen/${kasseA1}/artikel-layouts/${gruppeAId}`, tokenB)).statusCode).toBe(404)
      expect(await layoutVon(kasseA1, gruppeAId)).toEqual([platziert(artikelA, 4)])
    })

    it('eigene Kasse + fremde Warengruppe → 404; fremder Artikel in eigener Gruppe → 404 (nicht 400)', async () => {
      expect((await speichere(kasseA1, gruppeBId, [], tokenA)).statusCode).toBe(404)
      expect((await api('DELETE', `/api/kassen/${kasseA1}/artikel-layouts/${gruppeBId}`, tokenA)).statusCode).toBe(404)
      const res = await speichere(kasseA1, gruppeAId, [platziert(artikelA, 1), platziert(artikelB, 2)])
      expect(res.statusCode, res.body).toBe(404)
      expect(await layoutVon(kasseA1, gruppeAId)).toEqual([platziert(artikelA, 4)])
    })

    it('Mandant B bleibt unberührt und sieht nur die eigene Anordnung', async () => {
      const b = await holeLayouts(kasseB, tokenB)
      expect(b.map(l => l.kategorieId)).toEqual([gruppeBId])
      expect(b[0]!.eintraege).toHaveLength(2)
      expect(JSON.stringify(b)).not.toContain(artikelA)
    })

    it('Altbestand mit fremden/veralteten Zeilen (direkt eingefügt) wird beim Lesen herausgefiltert', async () => {
      const g = await gruppeMitArtikeln(tokenA, 2)
      const andere = await gruppeMitArtikeln(tokenA, 1)
      const [fremd] = await idb.db.select({ id: artikel.id }).from(artikel).where(eq(artikel.id, artikelB))
      expect(fremd).toBeTruthy()
      await idb.db.insert(kasseArtikelLayout).values([
        { mandantId: mandantA, kasseId: kasseA1, kategorieId: g.kategorieId, artikelId: g.ids[0]!, position: 1, ausgeblendet: false },
        // veraltet: der Artikel liegt in einer anderen Warengruppe
        { mandantId: mandantA, kasseId: kasseA1, kategorieId: g.kategorieId, artikelId: andere.ids[0]!, position: 2, ausgeblendet: false },
        // fremd: Artikel eines anderen Mandanten
        { mandantId: mandantA, kasseId: kasseA1, kategorieId: g.kategorieId, artikelId: artikelB, position: 3, ausgeblendet: false },
        // Zeile mit fremder mandant_id
        { mandantId: mandantB, kasseId: kasseA1, kategorieId: g.kategorieId, artikelId: g.ids[1]!, position: 4, ausgeblendet: false },
      ])
      const gelesen = await layoutVon(kasseA1, g.kategorieId)
      expect(gelesen).toEqual([platziert(g.ids[0]!, 1)])
      // Die Oberfläche schickt die geladene Liste zurück — das darf nie an Altlast scheitern …
      const zurueck = await speichere(kasseA1, g.kategorieId, gelesen!)
      expect(zurueck.statusCode, zurueck.body).toBe(204)
      // … und räumt die veralteten Zeilen dabei weg
      const rest = await idb.db.select().from(kasseArtikelLayout)
        .where(and(eq(kasseArtikelLayout.kasseId, kasseA1), eq(kasseArtikelLayout.kategorieId, g.kategorieId)))
      expect(rest).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  describe('Rechte', () => {
    let kategorieId = '', a = ''
    beforeAll(async () => {
      const g = await gruppeMitArtikeln(tokenA, 1)
      kategorieId = g.kategorieId; a = g.ids[0]!
      await speichere(kasseA1, kategorieId, [platziert(a, 2)])
    })

    it('ein PIN-Kellner darf lesen (Kellner-App-Pfad)', async () => {
      const res = await api('GET', `/api/kassen/${kasseA1}/artikel-layouts`, tokenKellner)
      expect(res.statusCode, res.body).toBe(200)
      expect((res.json() as { kategorieId: string }[]).some(l => l.kategorieId === kategorieId)).toBe(true)
    })

    it('ein Nicht-Admin schreibt, ersetzt und löscht nichts (403); das Standard-Raster ebenso', async () => {
      expect((await speichere(kasseA1, kategorieId, [], tokenKellner)).statusCode).toBe(403)
      expect((await api('DELETE', `/api/kassen/${kasseA1}/artikel-layouts/${kategorieId}`, tokenKellner)).statusCode).toBe(403)
      expect((await api('PUT', `/api/kategorien/${kategorieId}/artikel-raster`, tokenKellner, { eintraege: [{ artikelId: a, position: 1 }] })).statusCode).toBe(403)
      expect(await layoutVon(kasseA1, kategorieId)).toEqual([platziert(a, 2)])
    })

    it('ohne Anmeldung 401', async () => {
      expect((await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseA1}/artikel-layouts` })).statusCode).toBe(401)
      expect((await srv.fastify.inject({ method: 'PUT', url: `/api/kassen/${kasseA1}/artikel-layouts/${kategorieId}`, payload: { eintraege: [] } })).statusCode).toBe(401)
      expect((await srv.fastify.inject({ method: 'PUT', url: `/api/kategorien/${kategorieId}/artikel-raster`, payload: { eintraege: [] } })).statusCode).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  describe('Zurücksetzen (DELETE)', () => {
    it('entfernt nur die Anordnung dieser Kasse + Warengruppe; erneutes Löschen ist harmlos (204)', async () => {
      const g1 = await gruppeMitArtikeln(tokenA, 1)
      const g2 = await gruppeMitArtikeln(tokenA, 1)
      await speichere(kasseA1, g1.kategorieId, [platziert(g1.ids[0]!, 1)])
      await speichere(kasseA2, g1.kategorieId, [platziert(g1.ids[0]!, 1)])
      await speichere(kasseA1, g2.kategorieId, [platziert(g2.ids[0]!, 1)])

      expect((await api('DELETE', `/api/kassen/${kasseA1}/artikel-layouts/${g1.kategorieId}`, tokenA)).statusCode).toBe(204)
      expect(await layoutVon(kasseA1, g1.kategorieId)).toBeUndefined()
      expect(await layoutVon(kasseA2, g1.kategorieId)).toEqual([platziert(g1.ids[0]!, 1)])
      expect(await layoutVon(kasseA1, g2.kategorieId)).toEqual([platziert(g2.ids[0]!, 1)])
      expect((await api('DELETE', `/api/kassen/${kasseA1}/artikel-layouts/${g1.kategorieId}`, tokenA)).statusCode).toBe(204)
    })
  })

  // -------------------------------------------------------------------------
  describe('Veraltete Zeilen und Cascade', () => {
    it('ein in eine andere Warengruppe verschobener Artikel verschwindet aus dem Lesen; das Ersetzen räumt auf', async () => {
      const g = await gruppeMitArtikeln(tokenA, 3)
      const ziel = await gruppeMitArtikeln(tokenA, 0)
      await speichere(kasseA1, g.kategorieId, [platziert(g.ids[0]!, 1), platziert(g.ids[1]!, 2), versteckt(g.ids[2]!)])
      const verschiebe = await api('PUT', `/api/artikel/${g.ids[0]}`, tokenA, { kategorieId: ziel.kategorieId })
      expect(verschiebe.statusCode, verschiebe.body).toBe(200)
      expect(await layoutVon(kasseA1, g.kategorieId)).toEqual([platziert(g.ids[1]!, 2), versteckt(g.ids[2]!)])
      // der freie Slot 1 darf neu vergeben werden, obwohl die veraltete Zeile (Slot 1) noch in der Tabelle liegt
      expect((await speichere(kasseA1, g.kategorieId, [platziert(g.ids[2]!, 1), platziert(g.ids[1]!, 2)])).statusCode).toBe(204)
      expect(await idb.db.select().from(kasseArtikelLayout).where(eq(kasseArtikelLayout.artikelId, g.ids[0]!))).toHaveLength(0)
    })

    it('Cascade: Zeilen verschwinden mit dem Artikel, mit der Warengruppe und mit der Kasse', async () => {
      const zeilenZaehler = async (bedingung: SQL) =>
        (await idb.db.select().from(kasseArtikelLayout).where(bedingung)).length

      // Artikel gelöscht
      const g = await gruppeMitArtikeln(tokenA, 2)
      await speichere(kasseA1, g.kategorieId, [platziert(g.ids[0]!, 1), versteckt(g.ids[1]!)])
      await idb.db.delete(artikel).where(eq(artikel.id, g.ids[0]!))
      expect(await zeilenZaehler(eq(kasseArtikelLayout.kategorieId, g.kategorieId))).toBe(1)
      expect(await layoutVon(kasseA1, g.kategorieId)).toEqual([versteckt(g.ids[1]!)])

      // Warengruppe gelöscht (Artikel zuvor entfernt, sonst FK artikel.kategorie_id)
      await idb.db.delete(artikel).where(eq(artikel.kategorieId, g.kategorieId))
      expect(await zeilenZaehler(eq(kasseArtikelLayout.kategorieId, g.kategorieId))).toBe(0)
      const g2 = await gruppeMitArtikeln(tokenA, 1)
      await speichere(kasseA1, g2.kategorieId, [platziert(g2.ids[0]!, 1)])
      await idb.db.update(artikel).set({ kategorieId: null }).where(eq(artikel.id, g2.ids[0]!))
      await idb.db.delete(kategorien).where(eq(kategorien.id, g2.kategorieId))
      expect(await zeilenZaehler(eq(kasseArtikelLayout.kategorieId, g2.kategorieId))).toBe(0)

      // Kasse gelöscht (nackte Kasse ohne Belege)
      const [nackte] = await idb.db.insert(kassen).values({
        mandantId: mandantA, kassenId: 'KAL-NACKT', seeZertifikatDer: 'x', seePrivateKeyEnc: 'x', seeZertifikatSn: 'x', seeGueltigBis: new Date(),
      }).returning({ id: kassen.id })
      const g3 = await gruppeMitArtikeln(tokenA, 1)
      expect((await speichere(nackte!.id, g3.kategorieId, [platziert(g3.ids[0]!, 1)])).statusCode).toBe(204)
      expect(await zeilenZaehler(eq(kasseArtikelLayout.kasseId, nackte!.id))).toBe(1)
      await idb.db.delete(kassen).where(eq(kassen.id, nackte!.id))
      expect(await zeilenZaehler(eq(kasseArtikelLayout.kasseId, nackte!.id))).toBe(0)
      // die Anordnung der anderen Kassen bleibt
      expect(await zeilenZaehler(eq(kasseArtikelLayout.kasseId, kasseA1))).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  describe('Datenbank', () => {
    it('CHECK + eindeutige Indizes halten auch bei Direktzugriff: ausgeblendet ⇔ ohne Position, Position je Kasse + Gruppe einmalig', async () => {
      const g = await gruppeMitArtikeln(tokenA, 2)
      const zeile = (artikelId: string, position: number | null, ausgeblendet: boolean) =>
        idb.db.insert(kasseArtikelLayout).values({ mandantId: mandantA, kasseId: kasseA1, kategorieId: g.kategorieId, artikelId, position, ausgeblendet })
      await expect(zeile(g.ids[0]!, null, false)).rejects.toThrow()      // platziert ohne Position
      await expect(zeile(g.ids[0]!, 3, true)).rejects.toThrow()          // ausgeblendet mit Position
      await expect(zeile(g.ids[0]!, 0, false)).rejects.toThrow()         // Position < 1
      await zeile(g.ids[0]!, 1, false)
      await expect(zeile(g.ids[1]!, 1, false)).rejects.toThrow()         // Position doppelt
      await expect(zeile(g.ids[0]!, 2, false)).rejects.toThrow()         // Artikel doppelt
      await zeile(g.ids[1]!, null, true)                                 // ausgeblendete dürfen null mehrfach teilen
      await idb.db.delete(kasseArtikelLayout).where(eq(kasseArtikelLayout.kategorieId, g.kategorieId))
    })

    it('Migration 0060 lässt sich wiederholen (idempotent) und lässt vorhandene Zeilen unberührt', async () => {
      const g = await gruppeMitArtikeln(tokenA, 1)
      await speichere(kasseA1, g.kategorieId, [platziert(g.ids[0]!, 6)])
      const teile = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')
      for (let lauf = 0; lauf < 2; lauf++) {
        for (const teil of teile) if (teil.trim()) await idb.db.execute(sql.raw(teil))
      }
      expect(await layoutVon(kasseA1, g.kategorieId)).toEqual([platziert(g.ids[0]!, 6)])
    })

    it('Atomarität: scheitert das Einfügen, bleibt die bisherige Anordnung vollständig erhalten', async () => {
      const g = await gruppeMitArtikeln(tokenA, 2)
      await speichere(kasseA1, g.kategorieId, [platziert(g.ids[0]!, 1), platziert(g.ids[1]!, 2)])
      await idb.db.execute(sql.raw(`
        CREATE FUNCTION test_layout_fehler() RETURNS trigger AS $$
        BEGIN
          IF NEW.position = 99 THEN RAISE EXCEPTION 'Testfehler: Zeile abgelehnt'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`))
      await idb.db.execute(sql.raw(
        'CREATE TRIGGER test_layout_fehler BEFORE INSERT ON kasse_artikel_layout FOR EACH ROW EXECUTE FUNCTION test_layout_fehler()'))
      try {
        const res = await speichere(kasseA1, g.kategorieId, [platziert(g.ids[1]!, 1), platziert(g.ids[0]!, 99)])
        expect(res.statusCode).toBe(500)
        expect(res.body).not.toContain('Testfehler')   // Interna gehen nie an den Client
        expect(await layoutVon(kasseA1, g.kategorieId)).toEqual([platziert(g.ids[0]!, 1), platziert(g.ids[1]!, 2)])
      } finally {
        await idb.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_layout_fehler ON kasse_artikel_layout'))
        await idb.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_layout_fehler()'))
      }
    })

    it('gleichzeitiges Speichern derselben Kasse + Warengruppe: alle antworten 204, am Ende gilt genau eine der Anordnungen', async () => {
      const g = await gruppeMitArtikeln(tokenA, 3)
      const [a, b, c] = g.ids as [string, string, string]
      const varianten: Eintrag[][] = [
        [platziert(a, 1), platziert(b, 2), platziert(c, 3)],
        [platziert(c, 1), platziert(b, 2), platziert(a, 3)],
        [platziert(b, 1), platziert(a, 2), versteckt(c)],
        [platziert(a, 3), platziert(b, 1), platziert(c, 2)],
        [platziert(c, 2), platziert(a, 1), versteckt(b)],
      ]
      const antworten = await Promise.all(varianten.map(v => speichere(kasseA1, g.kategorieId, v)))
      expect(antworten.map(r => r.statusCode), antworten.map(r => r.body).join('|')).toEqual([204, 204, 204, 204, 204])
      const ergebnis = await layoutVon(kasseA1, g.kategorieId)
      const sortiert = (l: Eintrag[]) => JSON.stringify([...l].sort((x, y) => x.artikelId.localeCompare(y.artikelId)))
      expect(varianten.map(sortiert)).toContain(sortiert(ergebnis!))
    })
  })

  // -------------------------------------------------------------------------
  describe('Standard-Raster (PUT /api/kategorien/:kategorieId/artikel-raster)', () => {
    const holeArtikel = async (token = tokenA) =>
      new Map(((await api('GET', '/api/artikel', token)).json() as { id: string; rasterPosition: number | null; reihenfolge: number; kategorieId: string | null }[])
        .map(x => [x.id, x] as const))
    const standard = (kategorieId: string, eintraege: { artikelId: string; position: number | null }[], token = tokenA) =>
      api('PUT', `/api/kategorien/${kategorieId}/artikel-raster`, token, { eintraege })

    it('setzt raster_position UND reihenfolge (= Slot, wie der Import); null löscht den Slot, die Reihenfolge bleibt', async () => {
      const g = await gruppeMitArtikeln(tokenA, 3, i => ({ rasterPosition: i + 1 }))
      const [a, b, c] = g.ids as [string, string, string]
      const res = await standard(g.kategorieId, [{ artikelId: a, position: 3 }, { artikelId: b, position: 1 }, { artikelId: c, position: null }])
      expect(res.statusCode, res.body).toBe(204)
      const nach = await holeArtikel()
      expect(nach.get(a)).toMatchObject({ rasterPosition: 3, reihenfolge: 3 })
      expect(nach.get(b)).toMatchObject({ rasterPosition: 1, reihenfolge: 1 })
      expect(nach.get(c)).toMatchObject({ rasterPosition: null, reihenfolge: 0 })
    })

    it('nicht genannte Artikel der Gruppe, andere Gruppen und die Kassen-Anordnung bleiben unverändert', async () => {
      const g = await gruppeMitArtikeln(tokenA, 2, i => ({ rasterPosition: i + 1 }))
      const andere = await gruppeMitArtikeln(tokenA, 1, () => ({ rasterPosition: 9 }))
      await speichere(kasseA1, g.kategorieId, [platziert(g.ids[0]!, 4)])
      const vorher = await holeArtikel()
      expect((await standard(g.kategorieId, [{ artikelId: g.ids[0]!, position: 2 }])).statusCode).toBe(204)
      const nach = await holeArtikel()
      expect(nach.get(g.ids[1]!)).toEqual(vorher.get(g.ids[1]!))
      expect(nach.get(andere.ids[0]!)).toEqual(vorher.get(andere.ids[0]!))
      expect(await layoutVon(kasseA1, g.kategorieId)).toEqual([platziert(g.ids[0]!, 4)])
    })

    it('Artikel einer anderen Gruppe → 400, fremder Artikel / fremde Gruppe → 404, doppelte Slots → 400 — nichts wird geändert', async () => {
      const g = await gruppeMitArtikeln(tokenA, 2, i => ({ rasterPosition: i + 1 }))
      const andere = await gruppeMitArtikeln(tokenA, 1)
      const fremd = await gruppeMitArtikeln(tokenB, 1, () => ({ rasterPosition: 5 }))
      const vorher = await holeArtikel()
      const vorherB = await holeArtikel(tokenB)

      expect((await standard(g.kategorieId, [{ artikelId: g.ids[0]!, position: 7 }, { artikelId: andere.ids[0]!, position: 8 }])).statusCode).toBe(400)
      expect((await standard(g.kategorieId, [{ artikelId: g.ids[0]!, position: 7 }, { artikelId: fremd.ids[0]!, position: 8 }])).statusCode).toBe(404)
      expect((await standard(g.kategorieId, [{ artikelId: g.ids[0]!, position: 7 }, { artikelId: UNBEKANNT, position: 8 }])).statusCode).toBe(404)
      expect((await standard(fremd.kategorieId, [{ artikelId: fremd.ids[0]!, position: 1 }])).statusCode).toBe(404)             // Gruppe von B mit Token A
      expect((await standard(g.kategorieId, [{ artikelId: g.ids[0]!, position: 7 }, { artikelId: g.ids[1]!, position: 7 }])).statusCode).toBe(400)
      expect((await standard(g.kategorieId, [{ artikelId: g.ids[0]!, position: 0 }])).statusCode).toBe(400)
      expect((await standard(g.kategorieId, [{ artikelId: g.ids[0]!, position: 1000 }])).statusCode).toBe(400)

      expect(await holeArtikel()).toEqual(vorher)
      expect(await holeArtikel(tokenB)).toEqual(vorherB)
      // Mandant B kann die Gruppe von A ebenfalls nicht anfassen
      expect((await standard(g.kategorieId, [], tokenB)).statusCode).toBe(404)
    })

    it('alles oder nichts: scheitert ein Artikel mitten im Speichern, bleibt keiner verändert', async () => {
      const g = await gruppeMitArtikeln(tokenA, 3, i => ({ rasterPosition: i + 1 }))
      const vorher = await holeArtikel()
      await idb.db.execute(sql.raw(`
        CREATE FUNCTION test_raster_fehler() RETURNS trigger AS $$
        BEGIN
          IF NEW.raster_position = 99 THEN RAISE EXCEPTION 'Testfehler: Artikel-UPDATE abgelehnt'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`))
      await idb.db.execute(sql.raw(
        'CREATE TRIGGER test_raster_fehler BEFORE UPDATE ON artikel FOR EACH ROW EXECUTE FUNCTION test_raster_fehler()'))
      try {
        const res = await standard(g.kategorieId, [
          { artikelId: g.ids[0]!, position: 3 }, { artikelId: g.ids[1]!, position: 1 }, { artikelId: g.ids[2]!, position: 99 },
        ])
        expect(res.statusCode).toBe(500)
        expect(await holeArtikel()).toEqual(vorher)
      } finally {
        await idb.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_raster_fehler ON artikel'))
        await idb.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_raster_fehler()'))
      }
    })

    it('unbekannte Warengruppe → 404', async () => {
      expect((await standard(UNBEKANNT, [])).statusCode).toBe(404)
    })
  })
})
