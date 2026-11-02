/**
 * Integrationstest: Verkauf mit Altbestand, der Stammdaten eines anderen Mandanten
 * verknüpft — Ergänzung zu beleg-artikel-mandant.test.ts (dort stecken die fremden
 * IDs in der ANFRAGE, hier in den DATEN von B).
 *
 * Die Stammdaten-Routen lassen so etwas nicht mehr zu (schreibeRezept prüft den
 * Mandanten, Seriennummern werden am eigenen Artikel erfasst) — Altbestand, Importe
 * und Übergaben können es aber enthalten. Der Verkauf darf es weder abbuchen noch
 * anzeigen, und das Speichern des Artikels darf daran nicht scheitern.
 *
 * Aufbau: Zwei Verteidigungslinien schützen die Rezepte (Zeile des Mandanten +
 * Artikel des Mandanten). Damit jede einzeln wegfallen darf und der Test es merkt,
 * trifft jede Fremdzeile NUR eine Linie:
 *  - Zeile von B, Bestandteil von A  → nur die Artikelprüfung (Abbuchen/Lesen) hält sie auf;
 *  - Zeile von A, beide Artikel von B → nur die Zeilenprüfung hält sie auf.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, count, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel, artikelBestandteile, belege, kassen, seriennummern } from '../../src/db/schema.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BAA-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: number) {
  return {
    firmenname: `Altbestand ${nr} GmbH`,
    uid:        `ATU9999994${nr}`,
    kassenId:   `BAA-00${nr}`,
    finanzOnline: {
      teilnehmerId:    `TID-BAA-${nr}`,
      benutzerkennung: `BID-BAA-${nr}`,
      pin:             `PIN-BAA-${nr}`,
    },
    umgebung: 'test',
    admin: {
      name:     `Admin ${nr}`,
      email:    `admin${nr}@altbestand.at`,
      passwort: 'altbestand-passwort-123',
    },
  }
}

type Auth = () => { authorization: string }

describe('Verkauf mit fremd verknüpftem Altbestand (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = ''
  let kasseB = ''
  let mandantA = '', mandantB = ''

  let rohA = ''     // Rohstoff von A, Bestand 100
  let rohB = ''     // eigener Rohstoff, Bestand 50
  let rohB2 = ''    // zweiter eigener Rohstoff, Bestand 7
  let menueB = ''   // eigener Verkaufsartikel, Rezept: 1× rohB (+ zwei Fremdzeilen, siehe beforeAll)
  let laptopB = ''  // eigener Seriennummern-Artikel

  const authA: Auth = () => ({ authorization: `Bearer ${tokenA}` })
  const authB: Auth = () => ({ authorization: `Bearer ${tokenB}` })

  async function anlegen(auth: Auth, url: string, payload: object): Promise<Record<string, unknown>> {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload })
    if (res.statusCode !== 201) throw new Error(`${url} (${res.statusCode}): ${res.body}`)
    return res.json() as Record<string, unknown>
  }

  const barzahlungB = (positionen: unknown[], barCent: number) => srv.fastify.inject({
    method: 'POST', url: '/api/belege/barzahlung', headers: authB(),
    payload: { kasseId: kasseB, positionen, zahlung: { barCent, karteCent: 0, sonstigeCent: 0 } },
  })

  /** RKSV-Kette der Kasse: jede Signierung verändert mindestens einen dieser Werte. */
  async function kette(kasseId: string) {
    const [k] = await idb.db
      .select({
        letzteBelegNummer: kassen.letzteBelegNummer,
        letzterBelegCode:  kassen.letzterBelegCode,
        umsatzzaehlerCent: kassen.umsatzzaehlerCent,
      })
      .from(kassen).where(eq(kassen.id, kasseId))
    const [b] = await idb.db.select({ anzahl: count() }).from(belege).where(eq(belege.kasseId, kasseId))
    return { ...k, belege: b?.anzahl ?? 0 }
  }

  async function bestand(artikelId: string): Promise<number | null> {
    const [a] = await idb.db.select({ menge: artikel.lagerstandMenge }).from(artikel).where(eq(artikel.id, artikelId))
    return a?.menge ?? null
  }

  /** Die drei Rohstoffe — je Test vorher/nachher verglichen. */
  const stand = async () => ({ rohA: await bestand(rohA), rohB: await bestand(rohB), rohB2: await bestand(rohB2) })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    for (const nr of [1, 2] as const) {
      const setupRes = await srv.fastify.inject({
        method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: setupInput(nr),
      })
      if (setupRes.statusCode !== 201) throw new Error(`Setup ${nr} (${setupRes.statusCode}): ${setupRes.body}`)
      const loginRes = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@altbestand.at`, passwort: 'altbestand-passwort-123' },
      })
      if (loginRes.statusCode !== 200) throw new Error(`Login ${nr} (${loginRes.statusCode}): ${loginRes.body}`)
      const login = loginRes.json()
      if (nr === 1) tokenA = login.token
      else        { tokenB = login.token; kasseB = login.kassen[0].id }
    }

    rohA = (await anlegen(authA, '/api/artikel', {
      bezeichnung: 'Rohstoff A', preisBruttoCent: 0, mwstSatz: 'normal',
      istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 100,
    })).id as string
    rohB = (await anlegen(authB, '/api/artikel', {
      bezeichnung: 'Rohstoff B', preisBruttoCent: 0, mwstSatz: 'normal',
      istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 50,
    })).id as string
    rohB2 = (await anlegen(authB, '/api/artikel', {
      bezeichnung: 'Rohstoff B2', preisBruttoCent: 0, mwstSatz: 'normal',
      istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 7,
    })).id as string
    menueB = (await anlegen(authB, '/api/artikel', {
      bezeichnung: 'Menü B', preisBruttoCent: 1000, mwstSatz: 'normal',
      bestandteile: [{ bestandteilArtikelId: rohB, menge: 1 }],
    })).id as string
    laptopB = (await anlegen(authB, '/api/artikel', {
      bezeichnung: 'Laptop B', preisBruttoCent: 80000, mwstSatz: 'normal', seriennummernAktiv: true,
    })).id as string
    await anlegen(authB, '/api/seriennummern', { artikelId: laptopB, seriennummern: ['SN-B-1'] })

    const [a] = await idb.db.select({ m: artikel.mandantId }).from(artikel).where(eq(artikel.id, rohA))
    const [b] = await idb.db.select({ m: kassen.mandantId }).from(kassen).where(eq(kassen.id, kasseB))
    mandantA = a!.m
    mandantB = b!.m

    // Altbestand direkt in der DB — die Stammdaten-Routen würden ihn ablehnen.
    await idb.db.insert(artikelBestandteile).values([
      // Zeile von B, Bestandteil gehört A → nur die Artikelprüfung hält sie auf
      { mandantId: mandantB, verkaufsartikelId: menueB, bestandteilArtikelId: rohA,  menge: 3 },
      // Zeile von A, beide Artikel gehören B → nur die Zeilenprüfung hält sie auf
      { mandantId: mandantA, verkaufsartikelId: menueB, bestandteilArtikelId: rohB2, menge: 4 },
    ])
    // Seriennummer mit dem Mandanten A am Artikel von B
    await idb.db.insert(seriennummern).values({ mandantId: mandantA, artikelId: laptopB, seriennummer: 'SN-X-1' })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Anzeige: das Rezept zeigt nur eigene Bestandteile, die Verfügbarkeit rechnet die fremden nicht ein', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: authB() })
    expect(res.statusCode).toBe(200)
    const menue = (res.json() as { id: string; bestandteile: { bestandteilArtikelId: string }[]; verfuegbareMenge: number | null }[])
      .find(a => a.id === menueB)!
    expect(menue.bestandteile.map(b => b.bestandteilArtikelId)).toEqual([rohB])
    // Mit der Fremdzeile von B (rohA: 100 / 3 = 33) bzw. der Zeile von A (rohB2: 7 / 4 = 1) wäre es weniger als 50.
    expect(menue.verfuegbareMenge).toBe(50)
  })

  it('Direktverkauf: bucht nur den eigenen Bestandteil ab, nicht die fremden', async () => {
    const vorher = await stand()

    const res = await barzahlungB([{ artikelId: menueB, menge: 2 }], 2000)

    expect(res.statusCode).toBe(201)
    expect(await stand()).toEqual({ rohA: vorher.rohA, rohB: vorher.rohB! - 2, rohB2: vorher.rohB2 })
  })

  it('Tisch: Buchen und Entfernen der Positionen bewegt nur den eigenen Bestandteil', async () => {
    const tab = await anlegen(authB, '/api/tisch-tabs', { kasseId: kasseB, tischNummer: 'ALT-1', kellner: 'Kellner B' })
    const vorher = await stand()

    const buchen = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tab.id}/positionen`, headers: authB(),
      payload: { positionen: [{ artikelId: menueB, bezeichnung: 'Menü B', preisBruttoCent: 1000, menge: 2 }] },
    })
    expect(buchen.statusCode).toBe(200)
    expect(await stand()).toEqual({ rohA: vorher.rohA, rohB: vorher.rohB! - 2, rohB2: vorher.rohB2 })

    const entfernen = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tab.id}/positionen`, headers: authB(), payload: { positionen: [] },
    })
    expect(entfernen.statusCode).toBe(200)
    expect(await stand()).toEqual(vorher)
  })

  it('Bonieren: bucht nur den eigenen Bestandteil ab, nicht die fremden', async () => {
    // Station am Artikel (sonst bonierbar nichts) + Browser-KDS an der Kasse von B
    await idb.db.update(artikel).set({ station: 'kueche' }).where(eq(artikel.id, menueB))
    await idb.db.update(kassen).set({ kdsAktiv: true, kdsStationen: {} }).where(eq(kassen.id, kasseB))
    try {
      const vorher = await stand()

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: authB(),
        payload: { kasseId: kasseB, kellner: 'Kellner B', positionen: [{ artikelId: menueB, menge: 1 }] },
      })

      expect(res.statusCode).toBe(200)
      expect(await stand()).toEqual({ rohA: vorher.rohA, rohB: vorher.rohB! - 1, rohB2: vorher.rohB2 })
    } finally {
      await idb.db.update(kassen).set({ kdsAktiv: false }).where(eq(kassen.id, kasseB))
      await idb.db.update(artikel).set({ station: null }).where(eq(artikel.id, menueB))
    }
  })

  it('Seriennummer mit dem Mandanten A am eigenen Artikel ist nicht verfügbar → 409, Zeile bleibt, kein Beleg', async () => {
    const vorher = await kette(kasseB)

    const res = await barzahlungB([{ artikelId: laptopB, menge: 1, seriennummern: ['SN-X-1'] }], 80000)

    expect(res.statusCode).toBe(409)
    expect(await kette(kasseB)).toEqual(vorher)
    const [zeile] = await idb.db
      .select({ status: seriennummern.status, belegId: seriennummern.belegId })
      .from(seriennummern)
      .where(and(eq(seriennummern.artikelId, laptopB), eq(seriennummern.seriennummer, 'SN-X-1')))
    expect(zeile).toEqual({ status: 'verfuegbar', belegId: null })
  })

  it('eigene Seriennummer wird verkauft und dem Beleg zugeordnet', async () => {
    const res = await barzahlungB([{ artikelId: laptopB, menge: 1, seriennummern: ['SN-B-1'] }], 80000)

    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    const [zeile] = await idb.db
      .select({ status: seriennummern.status, belegId: seriennummern.belegId })
      .from(seriennummern)
      .where(and(eq(seriennummern.artikelId, laptopB), eq(seriennummern.seriennummer, 'SN-B-1')))
    expect(zeile).toEqual({ status: 'verkauft', belegId: id })
  })

  it('Speichern: die angezeigte Liste zurückgeschickt ergibt 200 und räumt den Altbestand weg', async () => {
    const liste = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: authB() })
    const menue = (liste.json() as { id: string; bestandteile: { bestandteilArtikelId: string; menge: number }[] }[])
      .find(a => a.id === menueB)!

    const res = await srv.fastify.inject({
      method: 'PUT', url: `/api/artikel/${menueB}`, headers: authB(),
      payload: { bestandteile: menue.bestandteile.map(b => ({ bestandteilArtikelId: b.bestandteilArtikelId, menge: b.menge })) },
    })

    expect(res.statusCode).toBe(200)
    const zeilen = await idb.db
      .select({ bestandteil: artikelBestandteile.bestandteilArtikelId, mandant: artikelBestandteile.mandantId })
      .from(artikelBestandteile)
      .where(eq(artikelBestandteile.verkaufsartikelId, menueB))
    expect(zeilen).toEqual([{ bestandteil: rohB, mandant: mandantB }])
  })
})
