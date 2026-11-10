/**
 * Integrationstest (echtes PostgreSQL, Migration 0081): Aktionen — Mengenaktion „X zum Preis von Y",
 * Ende nach X Aktionstagen, fachliche Querprüfung, Teil-Updates, Mandantentrennung — und der Beleg mit der
 * Rabattzeile einer Mengenaktion (negative Position mit dem Steuersatz des Artikels).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'aktionen-menge-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: 1 | 2) {
  return {
    firmenname: `Aktionen ${nr} GmbH`,
    uid:        `ATU9999998${nr}`,
    kassenId:   `AK-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-AK-${nr}`, benutzerkennung: `BID-AK-${nr}`, pin: `PIN-AK-${nr}` },
    umgebung: 'test',
    admin: { name: `AK Admin ${nr}`, email: `admin${nr}@aktionen.at`, passwort: PASSWORT },
  }
}

interface Regel {
  id: string; name: string; aktiv: boolean; wochentage: number[]; datumTage: string[]; zeitfenster: { von: string; bis: string }[]
  gueltigVon: string | null; gueltigBis: string | null; rabattProzent: number; artikelPreise: unknown[]
  kategorieIds: string[]; artikelIds: string[]
  mengeKauf: number | null; mengeZahle: number | null; mengeModus: string | null; wiederholungen: number | null
}

describe('Aktionen: Mengenaktion, Wiederholungen, Beleg (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = '', kasseA = ''
  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: { authorization: string }, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })

  const basis = {
    name: 'Test', wochentage: [1], zeitfenster: [{ von: '08:00', bis: '20:00' }], rabattProzent: 0,
    mengeKauf: 3, mengeZahle: 2, mengeModus: 'artikel',
  }
  const anlegen = async (extra: Record<string, unknown> = {}, h = authA()) => {
    const r = await inject('POST', '/api/preisregeln', h, { ...basis, ...extra })
    expect(r.statusCode, r.body).toBe(201)
    return r.json() as Regel
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2] as const) {
      const s = await srv.fastify.inject({ method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: setupInput(nr) })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const l = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@aktionen.at`, passwort: PASSWORT } })
      if (l.statusCode !== 200) throw new Error(`Login ${nr} (${l.statusCode}): ${l.body}`)
      if (nr === 1) { tokenA = l.json().token; kasseA = l.json().kassen[0].id } else tokenB = l.json().token
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Mengenaktion wird gespeichert und geliefert; Preisaktionen behalten ihre Felder leer', async () => {
    const m = await anlegen({ name: '3 für 2' })
    expect(m).toMatchObject({ mengeKauf: 3, mengeZahle: 2, mengeModus: 'artikel', rabattProzent: 0, artikelPreise: [], wiederholungen: null })
    const p = await anlegen({ name: 'Happy Hour', mengeKauf: null, mengeZahle: null, mengeModus: null, rabattProzent: 20 })
    expect(p).toMatchObject({ mengeKauf: null, mengeZahle: null, mengeModus: null, rabattProzent: 20 })
    const liste = (await inject('GET', '/api/preisregeln', authA())).json() as Regel[]
    expect(liste.find(r => r.id === m.id)).toMatchObject({ mengeKauf: 3, mengeModus: 'artikel' })
  })

  it('lehnt unzulässige Kombinationen ab (mit verständlicher Meldung)', async () => {
    const post = (extra: Record<string, unknown>) => inject('POST', '/api/preisregeln', authA(), { ...basis, ...extra })
    const meldung = async (extra: Record<string, unknown>) => JSON.stringify((await post(extra)).json())
    expect((await post({ mengeKauf: 3, mengeZahle: 3 })).statusCode).toBe(400)
    expect(await meldung({ mengeKauf: 3, mengeZahle: 3 })).toContain('kleiner')
    expect((await post({ mengeKauf: 1, mengeZahle: 1 })).statusCode).toBe(400)          // kaufe mindestens 2
    expect((await post({ mengeZahle: null })).statusCode).toBe(400)                       // nur teilweise angegeben
    expect(await meldung({ rabattProzent: 20 })).toContain('eigene Aktion')               // Menge + Prozent
    expect((await post({ mengeKauf: null, mengeZahle: null, mengeModus: null })).statusCode).toBe(400)  // weder Preis noch Menge
    expect((await post({ mengeModus: 'beliebig' })).statusCode).toBe(400)
    expect(await meldung({ wiederholungen: 4 })).toContain('Startdatum')
    expect(await meldung({ wiederholungen: 4, gueltigVon: '2026-07-06', wochentage: [], datumTage: ['2026-07-06'] })).toContain('Wochentagen')
    expect(await meldung({ gueltigVon: '2026-07-10', gueltigBis: '2026-07-01' })).toContain('vor')
  })

  it('„nach X Aktionstagen": der Server berechnet das Enddatum und hält es bei Änderungen aktuell', async () => {
    // 2026-07-06 = Montag
    const a = await anlegen({ gueltigVon: '2026-07-06', wiederholungen: 4 })
    expect(a).toMatchObject({ wiederholungen: 4, gueltigBis: '2026-07-27' })

    const mehr = await inject('PATCH', `/api/preisregeln/${a.id}`, authA(), { wiederholungen: 6 })
    expect((mehr.json() as Regel).gueltigBis).toBe('2026-08-10')

    const start = await inject('PATCH', `/api/preisregeln/${a.id}`, authA(), { gueltigVon: '2026-08-03' })
    expect((start.json() as Regel).gueltigBis).toBe('2026-09-07')                          // 6 Montage ab 3.8.

    const tage = await inject('PATCH', `/api/preisregeln/${a.id}`, authA(), { wochentage: [1, 3] })
    expect((tage.json() as Regel).gueltigBis).toBe('2026-08-19')                           // Mo+Mi: 6 Termine

    // Wiederholungen abschalten → das Enddatum bleibt stehen und ist wieder frei änderbar
    const frei = await inject('PATCH', `/api/preisregeln/${a.id}`, authA(), { wiederholungen: null, gueltigBis: '2026-12-31' })
    expect(frei.json()).toMatchObject({ wiederholungen: null, gueltigBis: '2026-12-31' })
  })

  it('einmalig: nur Datumstage, kein Wochentag', async () => {
    const e = await anlegen({ wochentage: [], datumTage: ['2026-12-24'], name: 'Heiligabend' })
    expect(e).toMatchObject({ wochentage: [], datumTage: ['2026-12-24'], wiederholungen: null })
  })

  it('Teil-Update ändert NUR die gesendeten Felder (früher setzte das Schema fehlende auf Standardwerte)', async () => {
    const a = await anlegen({ name: 'Bleibt', wochentage: [2, 4], gueltigVon: '2026-07-01', gueltigBis: '2026-07-31', kategorieIds: [], artikelIds: [] })
    const r = await inject('PATCH', `/api/preisregeln/${a.id}`, authA(), { aktiv: false })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({
      aktiv: false, name: 'Bleibt', wochentage: [2, 4], gueltigVon: '2026-07-01', gueltigBis: '2026-07-31',
      mengeKauf: 3, mengeZahle: 2, mengeModus: 'artikel', zeitfenster: [{ von: '08:00', bis: '20:00' }],
    })
  })

  it('Teil-Update darf keine unzulässige Kombination erzeugen (Prozent-Rabatt auf eine Mengenaktion)', async () => {
    const a = await anlegen({ name: 'Menge bleibt Menge' })
    const r = await inject('PATCH', `/api/preisregeln/${a.id}`, authA(), { rabattProzent: 15 })
    expect(r.statusCode).toBe(400)
    expect(JSON.stringify(r.json())).toContain('eigene Aktion')
    expect(((await inject('GET', '/api/preisregeln', authA())).json() as Regel[]).find(x => x.id === a.id)).toMatchObject({ rabattProzent: 0, mengeKauf: 3 })
    // Umstellen auf Preisaktion in EINEM Schritt ist erlaubt
    const um = await inject('PATCH', `/api/preisregeln/${a.id}`, authA(), { mengeKauf: null, mengeZahle: null, mengeModus: null, rabattProzent: 15 })
    expect(um.statusCode, um.body).toBe(200)
    expect(um.json()).toMatchObject({ rabattProzent: 15, mengeKauf: null })
  })

  it('Mandantentrennung: Betrieb B kann Aktionen von A weder sehen noch ändern', async () => {
    const a = await anlegen({ name: 'Nur A' })
    expect(((await inject('GET', '/api/preisregeln', authB())).json() as Regel[]).some(r => r.id === a.id)).toBe(false)
    expect((await inject('PATCH', `/api/preisregeln/${a.id}`, authB(), { aktiv: false })).statusCode).toBe(404)
    expect((await inject('DELETE', `/api/preisregeln/${a.id}`, authB())).statusCode).toBe(404)
  })

  it('Beleg: Rabattzeile einer Mengenaktion (negative Position) → Summe und Steueraufteilung stimmen', async () => {
    const artikel = async (bezeichnung: string, mwstSatz: string, preis: number) =>
      (await inject('POST', '/api/artikel', authA(), { bezeichnung, preisBruttoCent: preis, mwstSatz })).json().id as string
    const pizza = await artikel('Pizza', 'ermaessigt1', 800)      // 10 %
    const cola  = await artikel('Cola', 'normal', 300)            // 20 %

    const res = await inject('POST', '/api/belege/barzahlung', authA(), {
      kasseId: kasseA,
      positionen: [
        { artikelId: pizza, menge: 3, einzelpreisBreuttoCent: 800 },
        { artikelId: cola,  menge: 1, einzelpreisBreuttoCent: 300 },
        // die Kasse hängt die Rabattzeile mit dem Steuersatz des Artikels an
        { bezeichnung: '3 für 2 (3 für 2): Pizza', preisBruttoCent: -800, mwstSatz: 'ermaessigt1', menge: 1 },
      ],
      zahlung: { barCent: 1900, karteCent: 0, sonstigeCent: 0 },
    })
    expect(res.statusCode, res.body).toBe(201)
    const beleg = res.json() as BelegResponse
    expect(beleg.gesamtbetragCent).toBe(1900)                     // 3 × 8,00 − 8,00 + 3,00
    expect(beleg.betraege.ermaessigt1).toBe(1600)                 // Pizza zahlt 2 von 3
    expect(beleg.betraege.normal).toBe(300)
    expect(beleg.positionen).toHaveLength(3)
    const rabatt = beleg.positionen.find(p => p.bezeichnung.includes('3 für 2'))
    expect(rabatt).toMatchObject({ einzelpreisBreutto: -800, mwstSatz: 'ermaessigt1', menge: 1 })
    expect(beleg.signaturwert).toBeTruthy()
  })

  it('Beleg: Rabattzeile über die ganze Auswahl mit gemischten Steuersätzen', async () => {
    const artikel = async (bezeichnung: string, mwstSatz: string, preis: number) =>
      (await inject('POST', '/api/artikel', authA(), { bezeichnung, preisBruttoCent: preis, mwstSatz })).json().id as string
    const a = await artikel('Eis Vanille', 'ermaessigt1', 250)
    const b = await artikel('Eis Schoko', 'ermaessigt1', 250)
    const c = await artikel('Eis Mango', 'ermaessigt1', 300)
    const res = await inject('POST', '/api/belege/barzahlung', authA(), {
      kasseId: kasseA,
      positionen: [
        { artikelId: a, menge: 1, einzelpreisBreuttoCent: 250 },
        { artikelId: b, menge: 1, einzelpreisBreuttoCent: 250 },
        { artikelId: c, menge: 1, einzelpreisBreuttoCent: 300 },
        { bezeichnung: '3 für 2 (3 für 2): Eis Vanille', preisBruttoCent: -250, mwstSatz: 'ermaessigt1', menge: 1 },
      ],
      zahlung: { barCent: 550, karteCent: 0, sonstigeCent: 0 },
    })
    expect(res.statusCode, res.body).toBe(201)
    expect((res.json() as BelegResponse).gesamtbetragCent).toBe(550)
    expect((res.json() as BelegResponse).betraege.ermaessigt1).toBe(550)
  })
})
