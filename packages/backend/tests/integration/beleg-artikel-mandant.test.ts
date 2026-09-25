/**
 * Integrationstest: Verkauf nur mit Stammdaten des eigenen Mandanten —
 * Barzahlung, Tisch und Lagerpfade gegen echtes PostgreSQL mit zwei Mandanten.
 *
 * Befund 2026-09-25: POST /belege/barzahlung prüfte die Kasse gegen den
 * Mandanten, lud Artikel, Warengruppen und Seriennummern aber nur per ID. Mit
 * der EIGENEN Kasse und der artikelId eines anderen Mandanten verkaufte B den
 * fremden Artikel — Bezeichnung, Preis und MwSt-Satz von A auf dem signierten
 * RKSV-Beleg von B —, buchte Lager und Rezept-Rohstoffe von A ab und markierte
 * Seriennummern von A als verkauft. Artikel-IDs sind nicht geheim (die
 * öffentliche Gast-Speisekarte liefert sie aus). Der Tisch buchte über fremde
 * Artikel- und Options-IDs ebenso fremdes Lager ab.
 *
 * Erwartung: Ein fremder Artikel verhält sich wie ein unbekannter — 404, bevor
 * signiert wird. Kein Beleg, die Belegkette von B bleibt unverändert, an den
 * Daten von A ändert sich nichts. Der eigene Verkauf läuft weiter.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, count, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel, belege, kassen, kdsBons, modifikatoren, seriennummern } from '../../src/db/schema.js'

const FREMD_404 = 'Mindestens ein Artikel ist nicht (mehr) verfügbar'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BAM-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: number) {
  return {
    firmenname: `Belegmandant ${nr} GmbH`,
    uid:        `ATU9999993${nr}`,
    kassenId:   `BAM-00${nr}`,
    finanzOnline: {
      teilnehmerId:    `TID-BAM-${nr}`,
      benutzerkennung: `BID-BAM-${nr}`,
      pin:             `PIN-BAM-${nr}`,
    },
    umgebung: 'test',
    admin: {
      name:     `Admin ${nr}`,
      email:    `admin${nr}@belegmandant.at`,
      passwort: 'belegmandant-passwort-123',
    },
  }
}

type Auth = () => { authorization: string }

describe('Verkauf nur mit Artikeln des eigenen Mandanten (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = ''
  let kasseB = ''

  // Stammdaten von A — B kennt nur die IDs
  let katA = ''        // Warengruppe mit Stations-Vorgabe
  let schnitzelA = ''  // Lagerartikel, Bestand 10
  let laptopA = ''     // Seriennummern-Artikel, Pool: SN-A-1
  let rohA = ''        // Rohstoff, Bestand 100
  let menueA = ''      // Rezept: 2× Rohstoff
  let gruppeA = ''
  let kaeseA = ''      // Option mit eigenem Lager, Bestand 20

  // Stammdaten von B
  let bierB = ''       // Lagerartikel, Bestand 5
  let wurstB = ''      // Lagerartikel, Bestand 5 — bekommt die Warengruppe von A untergeschoben

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

  async function lager(artikelId: string): Promise<number | null> {
    const [a] = await idb.db.select({ menge: artikel.lagerstandMenge }).from(artikel).where(eq(artikel.id, artikelId))
    return a?.menge ?? null
  }

  /** Alles bei A, was ein Verkauf von B verändern könnte — je Test vorher/nachher verglichen. */
  async function datenVonA() {
    const [kaese] = await idb.db
      .select({ menge: modifikatoren.lagerstandMenge })
      .from(modifikatoren).where(eq(modifikatoren.id, kaeseA))
    const [laptopSn] = await idb.db
      .select({ status: seriennummern.status, belegId: seriennummern.belegId })
      .from(seriennummern)
      .where(and(eq(seriennummern.artikelId, laptopA), eq(seriennummern.seriennummer, 'SN-A-1')))
    return {
      schnitzel: await lager(schnitzelA),
      rohstoff:  await lager(rohA),
      kaese:     kaese?.menge,
      laptopSn,
    }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    for (const nr of [1, 2] as const) {
      const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setupRes.statusCode !== 201) throw new Error(`Setup ${nr} (${setupRes.statusCode}): ${setupRes.body}`)
      const loginRes = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@belegmandant.at`, passwort: 'belegmandant-passwort-123' },
      })
      if (loginRes.statusCode !== 200) throw new Error(`Login ${nr} (${loginRes.statusCode}): ${loginRes.body}`)
      const login = loginRes.json()
      if (nr === 1) tokenA = login.token
      else        { tokenB = login.token; kasseB = login.kassen[0].id }
    }

    // --- Mandant A ---------------------------------------------------------
    katA = (await anlegen(authA, '/api/kategorien', {
      name: 'Geheime Warengruppe A', farbe: 'grau', station: 'kueche',
    })).id as string
    schnitzelA = (await anlegen(authA, '/api/artikel', {
      bezeichnung: 'Geheimes Schnitzel A', preisBruttoCent: 1590, mwstSatz: 'ermaessigt1',
      lagerstandAktiv: true, lagerstandMenge: 10,
    })).id as string
    laptopA = (await anlegen(authA, '/api/artikel', {
      bezeichnung: 'Laptop A', preisBruttoCent: 50000, mwstSatz: 'normal', seriennummernAktiv: true,
    })).id as string
    await anlegen(authA, '/api/seriennummern', { artikelId: laptopA, seriennummern: ['SN-A-1'] })
    rohA = (await anlegen(authA, '/api/artikel', {
      bezeichnung: 'Rohstoff A', preisBruttoCent: 0, mwstSatz: 'normal',
      istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: 100,
    })).id as string
    menueA = (await anlegen(authA, '/api/artikel', {
      bezeichnung: 'Menü A', preisBruttoCent: 1500, mwstSatz: 'normal',
      bestandteile: [{ bestandteilArtikelId: rohA, menge: 2 }],
    })).id as string
    gruppeA = (await anlegen(authA, '/api/modifikator-gruppen', { name: 'Extras A' })).id as string
    const gruppe = await anlegen(authA, `/api/modifikator-gruppen/${gruppeA}/modifikatoren`, {
      name: 'Extra Käse A', aufschlagCent: 100, lagerstandMenge: 20,
    })
    kaeseA = (gruppe.modifikatoren as { id: string }[])[0]!.id

    // --- Mandant B ---------------------------------------------------------
    bierB = (await anlegen(authB, '/api/artikel', {
      bezeichnung: 'Eigenes Bier B', preisBruttoCent: 450, mwstSatz: 'normal',
      lagerstandAktiv: true, lagerstandMenge: 5,
    })).id as string
    wurstB = (await anlegen(authB, '/api/artikel', {
      bezeichnung: 'Eigene Wurst B', preisBruttoCent: 390, mwstSatz: 'normal',
      lagerstandAktiv: true, lagerstandMenge: 5,
    })).id as string
    // Fremde Warengruppe am eigenen Artikel (Altbestand / ungeprüfte Stammdaten) —
    // direkt in der DB, damit der Test nicht an der Stammdaten-Route hängt.
    await idb.db.update(artikel).set({ kategorieId: katA }).where(eq(artikel.id, wurstB))
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Barzahlung von B mit dem Artikel von A → 404, kein Beleg, Kette und Lager unverändert', async () => {
    const vorher  = await kette(kasseB)
    const aVorher = await datenVonA()

    const res = await barzahlungB([{ artikelId: schnitzelA, menge: 1 }], 1590)

    expect(res.statusCode).toBe(404)
    expect(res.json().fehler).toBe(FREMD_404)
    expect(await kette(kasseB)).toEqual(vorher)
    expect(await datenVonA()).toEqual(aVorher)
  })

  it('eigener und fremder Artikel gemischt → ganzer Beleg abgelehnt, auch das eigene Lager bleibt', async () => {
    const vorher     = await kette(kasseB)
    const aVorher    = await datenVonA()
    const bierVorher = await lager(bierB)

    const res = await barzahlungB([{ artikelId: bierB, menge: 1 }, { artikelId: schnitzelA, menge: 1 }], 450 + 1590)

    expect(res.statusCode).toBe(404)
    expect(res.json().fehler).toBe(FREMD_404)
    expect(await kette(kasseB)).toEqual(vorher)
    expect(await lager(bierB)).toBe(bierVorher)
    expect(await datenVonA()).toEqual(aVorher)
  })

  it('Seriennummer von A → 404, bleibt im Pool von A verfügbar', async () => {
    const vorher  = await kette(kasseB)
    const aVorher = await datenVonA()
    expect(aVorher.laptopSn).toEqual({ status: 'verfuegbar', belegId: null })

    const res = await barzahlungB([{ artikelId: laptopA, menge: 1, seriennummern: ['SN-A-1'] }], 50000)

    expect(res.statusCode).toBe(404)
    expect(res.json().fehler).toBe(FREMD_404)
    expect(await kette(kasseB)).toEqual(vorher)
    expect(await datenVonA()).toEqual(aVorher)
  })

  it('Rezept-Artikel von A → 404, der Rohstoff von A bleibt', async () => {
    const vorher  = await kette(kasseB)
    const aVorher = await datenVonA()

    const res = await barzahlungB([{ artikelId: menueA, menge: 1 }], 1500)

    expect(res.statusCode).toBe(404)
    expect(res.json().fehler).toBe(FREMD_404)
    expect(await kette(kasseB)).toEqual(vorher)
    expect(await datenVonA()).toEqual(aVorher)
  })

  it('eigener Artikel läuft weiter: Beleg signiert, Kette fortgeschrieben, eigenes Lager abgebucht', async () => {
    const vorher     = await kette(kasseB)
    const bierVorher = await lager(bierB)

    const res = await barzahlungB([{ artikelId: bierB, menge: 1 }], 450)

    expect(res.statusCode).toBe(201)
    const beleg = res.json() as { belegNummer: number; positionen: { bezeichnung: string }[] }
    expect(beleg.positionen.map(p => p.bezeichnung)).toEqual(['Eigenes Bier B'])
    const nachher = await kette(kasseB)
    expect(nachher.belege).toBe(vorher.belege + 1)
    expect(nachher.letzteBelegNummer).toBe(vorher.letzteBelegNummer! + 1)
    expect(beleg.belegNummer).toBe(nachher.letzteBelegNummer)
    expect(await lager(bierB)).toBe(bierVorher! - 1)
  })

  it('fremde Warengruppe am eigenen Artikel wirkt nicht: kein fremder Name im Beleg, eigenes Lager abgebucht', async () => {
    const wurstVorher = await lager(wurstB)

    const res = await barzahlungB([{ artikelId: wurstB, menge: 1 }], 390)

    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    const [row] = await idb.db.select({ positionen: belege.positionen }).from(belege).where(eq(belege.id, id))
    const [pos] = row!.positionen as { bezeichnung: string; kategorieId?: string; kategorieName?: string }[]
    expect(pos!.bezeichnung).toBe('Eigene Wurst B')
    expect(pos!.kategorieName).toBeUndefined()
    expect(pos!.kategorieId).toBeUndefined()
    // Die Stations-Vorgabe der fremden Warengruppe darf die Wurst nicht zur
    // „bonierten" Position machen, deren Lager angeblich schon abgebucht ist.
    expect(await lager(wurstB)).toBe(wurstVorher! - 1)
  })

  it('fremde Warengruppe routet den eigenen Artikel nicht an die KDS von B', async () => {
    const [k] = await idb.db.select({ mandantId: kassen.mandantId }).from(kassen).where(eq(kassen.id, kasseB))
    const bonsVonB = async () => (await idb.db
      .select({ anzahl: count() }).from(kdsBons).where(eq(kdsBons.mandantId, k!.mandantId)))[0]?.anzahl
    // Browser-KDS an der Kasse von B (Station ohne IP genügt für den Bon)
    await idb.db.update(kassen).set({ kdsAktiv: true, kdsStationen: {} }).where(eq(kassen.id, kasseB))
    try {
      const bonsVorher = await bonsVonB()

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: authB(),
        payload: { kasseId: kasseB, kellner: 'Kellner B', positionen: [{ artikelId: wurstB, menge: 1 }] },
      })

      // Die Wurst hat selbst weder Station noch Drucker — die Stations-Vorgabe
      // der Warengruppe von A zählt nicht, also gibt es nichts zu bonieren.
      expect(res.statusCode).toBe(400)
      expect(res.json().fehler).toMatch(/nichts zu bonieren/i)
      expect(await bonsVonB()).toBe(bonsVorher)
    } finally {
      await idb.db.update(kassen).set({ kdsAktiv: false }).where(eq(kassen.id, kasseB))
    }
  })

  it('Bonieren auf der Kasse von B mit dem Artikel von A → 404, Lager von A unverändert', async () => {
    const aVorher = await datenVonA()

    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/bestellung/bonieren', headers: authB(),
      payload: { kasseId: kasseB, kellner: 'Kellner B', positionen: [{ artikelId: schnitzelA, menge: 1 }] },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().fehler).toBe(FREMD_404)
    expect(await datenVonA()).toEqual(aVorher)
  })

  it('Tisch: fremde Artikel-, Rezept- und Options-IDs buchen kein Lager von A ab; Bezahlen scheitert vor dem Signieren', async () => {
    const aVorher = await datenVonA()
    const tab = await anlegen(authB, '/api/tisch-tabs', { kasseId: kasseB, tischNummer: 'ISO-1', kellner: 'Kellner B' })
    const tabId = tab.id as string
    const positionen = [
      { artikelId: schnitzelA, bezeichnung: 'Schnitzel', preisBruttoCent: 1590, menge: 2 },
      { artikelId: menueA,     bezeichnung: 'Menü',      preisBruttoCent: 1500, menge: 1 },
      {
        artikelId: bierB, bezeichnung: 'Eigenes Bier B', preisBruttoCent: 550, menge: 1,
        modifikatoren: [{ modifikatorId: kaeseA, gruppeId: gruppeA, gruppeName: 'Extras', name: 'Extra Käse', aufschlagCent: 100 }],
      },
    ]

    // Der Tisch prüft Artikel nicht beim Buchen (fremde IDs wie unbekannte) —
    // entscheidend ist, dass dabei kein fremdes Lager angefasst wird.
    const buchen = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: authB(), payload: { positionen },
    })
    expect(buchen.statusCode).toBe(200)
    expect(await datenVonA()).toEqual(aVorher)

    const vorher = await kette(kasseB)
    const bezahlen = await srv.fastify.inject({
      method: 'POST', url: `/api/tisch-tabs/${tabId}/bezahlen`, headers: authB(),
      payload: { zahlung: { barCent: 2 * 1590 + 1500 + 550, karteCent: 0, sonstigeCent: 0 } },
    })
    expect(bezahlen.statusCode).toBe(404)
    expect(bezahlen.json().fehler).toBe(FREMD_404)
    expect(await kette(kasseB)).toEqual(vorher)

    const offen = await srv.fastify.inject({ method: 'GET', url: `/api/tisch-tabs/${tabId}`, headers: authB() })
    expect(offen.json().status).toBe('offen')

    // Rückbuchung (Positionen wieder entfernen) darf fremdes Lager ebenso wenig anfassen
    const entfernen = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: authB(),
      payload: { positionen: [] },
    })
    expect(entfernen.statusCode).toBe(200)
    expect(await datenVonA()).toEqual(aVorher)
  })
})
