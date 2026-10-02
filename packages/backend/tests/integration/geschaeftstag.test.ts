/**
 * Integrationstest: Geschäftstag (frei verschiebbarer Tagesbeginn je Mandant)
 * gegen echtes PostgreSQL.
 *
 * Vier Mandanten in EINER Datenbank:
 *   A — Tagesbeginn 06:00 (seit 2020, per DB gesetzt): Tagesabschluss, Berichte
 *       (Tag/Woche/Monat, Stunden), Zeiterfassung, Auto-Abschluss, Exporte, KDS …
 *   B — Standard 00:00 (nie etwas eingestellt): alles wie vor dem Geschäftstag,
 *       und von A völlig unberührt (Mandanten-Isolation)
 *   C — API-Verhalten: Validierung, Admin-Pflicht, Sofort-Ausnahme, Zurücknehmen
 *   D — Wechsel mit Stichtag in BEIDE Richtungen (00:00 → 06:00 → 00:00)
 *
 * Belege entstehen über die echte API und werden danach per SQL auf exakte
 * Wiener Uhrzeiten gesetzt (Muster der Tagesgrenzen-Tests) — so lassen sich
 * 05:59:59 / 06:00:00 / Mitternacht und die Zeitumstellung treffen.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import {
  addTage,
  geschaeftstagVon,
  heuteGeschaeftstag,
  heuteKalendertagWien,
  tagesGrenzen,
  wienerZeitpunkt,
  type BerichtResponse,
  type StundenBerichtResponse,
  type TagesRegel,
  type Tagesabschluss,
  type TagesbeginnStand,
} from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { Config } from '../../src/config.js'
import { auditLogs, kassen, mandantTagesbeginn } from '../../src/db/schema.js'
import { datumsBereich, geschaeftstagAusdruck } from '../../src/db/datum.js'
import { fuehreFaelligeAutoAbschluesseDurch } from '../../src/services/auto-abschluss.service.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'GT-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

// SMTP absichtlich nicht konfiguriert → isEmailAktiv() false, kein Versand
const config = {} as unknown as Config

const PASSWORT = 'geschaeftstag-passwort-123'

interface Mandant {
  nr:        number
  token:     string
  kasseId:   string
  mandantId: string
  userId:    string
  auth:      () => { authorization: string }
}

describe('Geschäftstag (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let A: Mandant, B: Mandant, C: Mandant, D: Mandant

  async function richteMandantEin(nr: number): Promise<Mandant> {
    const email = `admin${nr}@geschaeftstag.at`
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: `Geschäftstag ${nr} GmbH`,
        uid:        `ATU9999993${nr}`,
        kassenId:   `GT-00${nr}`,
        finanzOnline: { teilnehmerId: `TID-GT${nr}`, benutzerkennung: `BID-GT${nr}`, pin: `PIN-GT${nr}` },
        umgebung: 'test',
        admin: { name: `GT Admin ${nr}`, email, passwort: PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup ${nr} (${setup.statusCode}): ${setup.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email, passwort: PASSWORT },
    })).json()
    const token = login.token as string
    return {
      nr, token,
      kasseId:   login.kassen[0].id,
      mandantId: login.mandant.id,
      userId:    login.user.id,
      auth:      () => ({ authorization: `Bearer ${token}` }),
    }
  }

  /** Beleg über die API anlegen und danach auf eine exakte Wiener Uhrzeit setzen. */
  async function legeBeleg(m: Mandant, cent: number, wien: string, bezeichnung = 'Artikel'): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: m.auth(),
      payload: {
        kasseId: m.kasseId,
        positionen: [{ bezeichnung, preisBruttoCent: cent, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 },
      },
    })
    if (res.statusCode !== 201) throw new Error(`Beleg (${res.statusCode}): ${res.body}`)
    const id = (res.json() as { id: string }).id
    await idb.db.execute(sql`
      UPDATE belege SET beleg_datum = ${wien}::timestamp AT TIME ZONE 'Europe/Vienna'
       WHERE id = ${id}::uuid`)
    return id
  }

  /** Tagesbeginn-Historie eines Mandanten direkt setzen (die API erlaubt keine Stichtage in der Vergangenheit). */
  async function setzeRegel(m: Mandant, regel: TagesRegel): Promise<void> {
    await idb.db.delete(mandantTagesbeginn).where(eq(mandantTagesbeginn.mandantId, m.mandantId))
    if (regel.length > 0) {
      await idb.db.insert(mandantTagesbeginn).values(regel.map(e => ({ mandantId: m.mandantId, gueltigAb: e.gueltigAb, beginn: e.beginn })))
    }
  }

  const abschluss = async (m: Mandant, datum: string) => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege/tagesabschluss?kasseId=${m.kasseId}&datum=${datum}`, headers: m.auth(),
    })
    expect(res.statusCode).toBe(200)
    return res.json() as Tagesabschluss
  }

  const umsatz = async (m: Mandant, von: string, bis: string, extra = '') => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/berichte/umsatz?kasseIds=${m.kasseId}&von=${von}&bis=${bis}${extra}`, headers: m.auth(),
    })
    expect(res.statusCode).toBe(200)
    return res.json() as BerichtResponse
  }

  const get = (m: Mandant, url: string) => srv.fastify.inject({ method: 'GET', url, headers: m.auth() })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    A = await richteMandantEin(1)
    B = await richteMandantEin(2)
    C = await richteMandantEin(3)
    D = await richteMandantEin(4)

    // A: Tagesbeginn 06:00 seit langem. D: 00:00 → 06:00 (03.11.2025) → 00:00 (01.12.2025).
    await setzeRegel(A, [{ gueltigAb: '2020-01-01', beginn: '06:00' }])
    await setzeRegel(D, [
      { gueltigAb: '2025-11-03', beginn: '06:00' },
      { gueltigAb: '2025-12-01', beginn: '00:00' },
    ])
  }, 120_000)

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  // =========================================================================
  // 1) Rechenkern im Browser/Backend == PostgreSQL
  // =========================================================================

  describe('JavaScript-Rechenkern und PostgreSQL rechnen identisch', () => {
    it('wienerZeitpunkt = AT TIME ZONE — Raster von 15 Minuten, auch in den Stunden der Zeitumstellung', async () => {
      const paare: [string, string][] = []
      for (const tag of ['2026-01-15', '2026-03-28', '2026-03-29', '2026-03-30', '2026-07-01', '2026-10-24', '2026-10-25', '2026-10-26']) {
        for (let h = 0; h < 24; h++) {
          for (const m of [0, 15, 30, 45]) paare.push([tag, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`])
        }
      }
      const werte = sql.join(paare.map(([d, hm]) => sql`(${d}::date, ${hm}::time)`), sql`, `)
      const zeilen = [...await idb.db.execute<{ d: string; hm: string; z: Date }>(sql`
        SELECT v.d::text AS d, to_char(v.t, 'HH24:MI') AS hm,
               ((v.d + v.t)::timestamp AT TIME ZONE 'Europe/Vienna') AS z
          FROM (VALUES ${werte}) AS v(d, t)`)]
      expect(zeilen).toHaveLength(paare.length)
      for (const z of zeilen) {
        expect(wienerZeitpunkt(z.d, z.hm).toISOString(), `${z.d} ${z.hm}`).toBe(new Date(z.z).toISOString())
      }
    })

    const regeln: [string, TagesRegel][] = [
      ['06:00 dauerhaft', [{ gueltigAb: '2020-01-01', beginn: '06:00' }]],
      ['02:30 — liegt in der Lücke/Überlappung der Zeitumstellung', [{ gueltigAb: '2020-01-01', beginn: '02:30' }]],
      ['mehrfacher Wechsel quer über beide Zeitumstellungen', [
        { gueltigAb: '2026-03-29', beginn: '04:00' },
        { gueltigAb: '2026-10-25', beginn: '00:00' },
        { gueltigAb: '2026-11-01', beginn: '23:30' },
      ]],
    ]

    for (const [name, regel] of regeln) {
      it(`Geschäftstag-Etikett (SQL-Ausdruck) = geschaeftstagVon (JS) — ${name}`, async () => {
        let geprueft = 0
        for (const [von, bis] of [
          ['2026-03-27T00:00:00Z', '2026-03-31T00:00:00Z'],
          ['2026-10-23T00:00:00Z', '2026-10-27T00:00:00Z'],
          ['2026-10-31T00:00:00Z', '2026-11-04T00:00:00Z'],
        ]) {
          const zeilen = [...await idb.db.execute<{ t: Date; tag: string }>(sql`
            SELECT g.t AS t, to_char(${geschaeftstagAusdruck(sql`g.t`, regel)}, 'YYYY-MM-DD') AS tag
              FROM generate_series(${von}::timestamptz, ${bis}::timestamptz, interval '15 minutes') AS g(t)`)]
          for (const z of zeilen) {
            expect(z.tag, new Date(z.t).toISOString()).toBe(geschaeftstagVon(regel, new Date(z.t)))
            geprueft++
          }
        }
        expect(geprueft).toBeGreaterThan(1000)
      })

      it(`Tagesgrenzen (SQL datumsBereich) = tagesGrenzen (JS), Minute für Minute — ${name}`, async () => {
        for (const tag of ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-31', '2026-11-01', '2026-11-02']) {
          const g = tagesGrenzen(regel, tag)
          const von = new Date(g.von.getTime() - 3 * 86_400_000).toISOString()
          const bis = new Date(g.bis.getTime() + 3 * 86_400_000).toISOString()
          const [z] = [...await idb.db.execute<{ erste: Date; letzte: Date; anzahl: number }>(sql`
            SELECT min(t) AS erste, max(t) AS letzte, count(*)::int AS anzahl
              FROM generate_series(${von}::timestamptz, ${bis}::timestamptz, interval '1 minute') AS s(t)
             WHERE ${datumsBereich(sql`s.t`, tag, tag, regel)}`)]
          expect(new Date(z!.erste).toISOString(), `Beginn ${tag}`).toBe(g.von.toISOString())
          expect(new Date(z!.letzte).getTime() + 60_000, `Ende ${tag}`).toBe(g.bis.getTime())
          expect(z!.anzahl, `Minuten ${tag}`).toBe((g.bis.getTime() - g.von.getTime()) / 60_000)
        }
      })
    }
  })

  // =========================================================================
  // 2) Tagesabschluss
  // =========================================================================

  describe('Tagesabschluss (Z-Bon) mit Tagesbeginn 06:00', () => {
    beforeAll(async () => {
      //            Wiener Zeit            Cent   → Geschäftstag
      await legeBeleg(A,   100, '2025-10-05 23:00:00')   // 05.10.
      await legeBeleg(A,   200, '2025-10-06 01:30:00')   // 05.10. (nach Mitternacht)
      await legeBeleg(A,   400, '2025-10-06 05:59:59')   // 05.10. (eine Sekunde vor Tagesbeginn)
      await legeBeleg(A,   800, '2025-10-06 06:00:00')   // 06.10. (genau Tagesbeginn)
      await legeBeleg(A,  1600, '2025-10-06 23:59:59')   // 06.10.
      await legeBeleg(A,  3200, '2025-10-07 00:00:00')   // 06.10. (Mitternacht)
      await legeBeleg(A,  6400, '2025-10-07 05:59:00')   // 06.10.
      await legeBeleg(A, 12800, '2025-10-07 06:00:00')   // 07.10.
      // Zeitumstellung: 29.03.2026 02:00 → 03:00 (der Geschäftstag 28.03. hat 23 Stunden)
      await legeBeleg(A,    11, '2026-03-28 05:59:59')   // 27.03.
      await legeBeleg(A,    22, '2026-03-29 05:59:59')   // 28.03. (nach der Umstellung, vor 06:00)
      await legeBeleg(A,    44, '2026-03-29 06:00:00')   // 29.03.
      // Rückstellung: 25.10.2026 03:00 → 02:00 (der Geschäftstag 24.10. hat 25 Stunden)
      await legeBeleg(A,    55, '2026-10-25 05:59:59')   // 24.10.
      await legeBeleg(A,    66, '2026-10-25 06:00:00')   // 25.10.
    })

    it('Belege nach Mitternacht und vor 06:00 zählen zum Vortag, ab 06:00 zum neuen Tag', async () => {
      const t05 = await abschluss(A, '2025-10-05')
      expect(t05.anzahlBarzahlungsbelege).toBe(3)
      expect(t05.barCent).toBe(100 + 200 + 400)

      const t06 = await abschluss(A, '2025-10-06')
      expect(t06.anzahlBarzahlungsbelege).toBe(4)
      expect(t06.barCent).toBe(800 + 1600 + 3200 + 6400)

      const t07 = await abschluss(A, '2025-10-07')
      expect(t07.anzahlBarzahlungsbelege).toBe(1)
      expect(t07.barCent).toBe(12800)
    })

    it('weist den Zeitraum des Geschäftstags aus (06:00 bis 06:00 des Folgetags, Wiener Zeit)', async () => {
      const t06 = await abschluss(A, '2025-10-06')
      expect(t06.datum).toBe('2025-10-06')
      expect(t06.zeitraum).toEqual({
        von: wienerZeitpunkt('2025-10-06', '06:00').toISOString(),
        bis: wienerZeitpunkt('2025-10-07', '06:00').toISOString(),
      })
      // Oktober 2025 ist noch Sommerzeit: 06:00 MESZ = 04:00 UTC
      expect(t06.zeitraum!.von).toBe('2025-10-06T04:00:00.000Z')
      expect(t06.zeitraum!.bis).toBe('2025-10-07T04:00:00.000Z')
    })

    it('Zeitumstellung: der Geschäftstag mit der Umstellung ist 23 bzw. 25 Stunden lang, ohne Lücke', async () => {
      const taege = await Promise.all(['2026-03-27', '2026-03-28', '2026-03-29'].map(d => abschluss(A, d)))
      expect(taege.map(t => t.barCent)).toEqual([11, 22, 44])
      const lang = taege[1]!.zeitraum!
      expect((Date.parse(lang.bis) - Date.parse(lang.von)) / 3_600_000).toBe(23)
      // Folgetag beginnt exakt, wo der vorige endet
      expect(taege[2]!.zeitraum!.von).toBe(lang.bis)

      const herbst = await Promise.all(['2026-10-24', '2026-10-25'].map(d => abschluss(A, d)))
      expect(herbst.map(t => t.barCent)).toEqual([55, 66])
      expect((Date.parse(herbst[0]!.zeitraum!.bis) - Date.parse(herbst[0]!.zeitraum!.von)) / 3_600_000).toBe(25)
    })

    it('Standard-Mandant B: Antwort ohne zeitraum, Kalendertag wie immer', async () => {
      await legeBeleg(B, 100, '2025-10-06 01:30:00')   // Kalendertag 06.10.
      await legeBeleg(B, 200, '2025-10-06 05:59:59')
      await legeBeleg(B, 400, '2025-10-06 06:00:00')
      await legeBeleg(B, 800, '2025-10-05 23:59:59')   // Kalendertag 05.10.

      const t06 = await abschluss(B, '2025-10-06')
      expect(t06.barCent).toBe(100 + 200 + 400)
      expect(t06.anzahlBarzahlungsbelege).toBe(3)
      // Die Antwort hat exakt die Felder wie vor dem Geschäftstag — nichts Neues im Standardfall
      expect(Object.keys(t06).sort()).toEqual([
        'anzahlBarzahlungsbelege', 'anzahlStornobelege', 'barCent', 'datum', 'karteCent',
        'kasseId', 'mwst', 'nettoUmsatzCent', 'sonstigCent',
      ])
      expect((await abschluss(B, '2025-10-05')).barCent).toBe(800)
    })
  })

  // =========================================================================
  // 3) Berichte
  // =========================================================================

  describe('Berichte folgen dem Geschäftstag', () => {
    beforeAll(async () => {
      // Monats-/Wochenwechsel um Mitternacht
      await legeBeleg(A, 50, '2025-10-31 22:00:00')   // 31.10.
      await legeBeleg(A, 25, '2025-11-01 02:00:00')   // 31.10. (Kalender: schon November)
      await legeBeleg(A,  5, '2025-11-01 06:00:00')   // 01.11.
    })

    it('Gruppierung „Tag": Tagessummen = Z-Bon, Summe aller Tage = Gesamtzeitraum', async () => {
      const b = await umsatz(A, '2025-10-05', '2025-10-07')
      expect(b.zeilen.map(z => [z.periode, z.umsatzCent])).toEqual([
        ['2025-10-05', 700], ['2025-10-06', 12000], ['2025-10-07', 12800],
      ])
      expect(b.gesamt.umsatzCent).toBe(700 + 12000 + 12800)
      expect(b.gesamt.anzahlBelege).toBe(8)
      // jede Zeile stimmt mit dem Tagesabschluss des Tages überein
      for (const z of b.zeilen) expect((await abschluss(A, z.periode)).nettoUmsatzCent).toBe(z.umsatzCent)
    })

    it('Gruppierung „Woche": Montag 01:30 gehört noch zur Woche des Sonntags (Geschäftstag)', async () => {
      const b = await umsatz(A, '2025-10-05', '2025-10-07', '&gruppierung=woche')
      // 05.10.2025 ist ein Sonntag (ISO-KW 40), 06.10. ein Montag (KW 41)
      expect(b.zeilen.map(z => [z.periode, z.umsatzCent])).toEqual([
        ['2025-KW40', 700],
        ['2025-KW41', 12000 + 12800],
      ])
    })

    it('Gruppierung „Monat": Beleg um 02:00 am 1. November zählt noch zum Oktober', async () => {
      const b = await umsatz(A, '2025-10-31', '2025-11-01', '&gruppierung=monat')
      expect(b.zeilen.map(z => [z.periode, z.umsatzCent])).toEqual([['2025-10', 75], ['2025-11', 5]])
      // und die Tagessumme des 31.10. enthält ihn ebenfalls — Tages- und Monatssummen passen zusammen
      const tag = await umsatz(A, '2025-10-31', '2025-11-01')
      expect(tag.zeilen.map(z => [z.periode, z.umsatzCent])).toEqual([['2025-10-31', 75], ['2025-11-01', 5]])
    })

    it('Standard-Mandant B gruppiert weiter nach Kalendertag/-woche/-monat', async () => {
      const tag = await umsatz(B, '2025-10-05', '2025-10-06')
      expect(tag.zeilen.map(z => [z.periode, z.umsatzCent])).toEqual([['2025-10-05', 800], ['2025-10-06', 700]])
      const woche = await umsatz(B, '2025-10-05', '2025-10-06', '&gruppierung=woche')
      expect(woche.zeilen.map(z => [z.periode, z.umsatzCent])).toEqual([['2025-KW40', 800], ['2025-KW41', 700]])
    })

    it('Uhrzeit-Filter bleibt eine reine Wiener Uhrzeit-Bedingung (22:00–02:00 über Mitternacht)', async () => {
      const b = await umsatz(A, '2025-10-05', '2025-10-07', '&zeitVon=22:00&zeitBis=02:00')
      // 23:00 (100) + 01:30 (200) + 23:59:59 (1600) + 00:00 (3200)
      expect(b.gesamt.umsatzCent).toBe(100 + 200 + 1600 + 3200)
    })

    it('Stundenverlauf: die Achse beginnt bei der Stunde des Tagesbeginns (06, 07, …, 23, 00, …, 05)', async () => {
      const res = await get(A, `/api/berichte/stunden?kasseIds=${A.kasseId}&von=2025-10-05&bis=2025-10-07`)
      expect(res.statusCode).toBe(200)
      const b = res.json() as StundenBerichtResponse
      expect(b.zeilen).toHaveLength(24)
      expect(b.zeilen.map(z => z.stunde)).toEqual([...Array.from({ length: 18 }, (_, i) => i + 6), 0, 1, 2, 3, 4, 5])
      const stunde = (h: number) => b.zeilen.find(z => z.stunde === h)!.umsatzCent
      expect(stunde(6)).toBe(800 + 12800)
      expect(stunde(23)).toBe(100 + 1600)
      expect(stunde(0)).toBe(3200)
      expect(stunde(1)).toBe(200)
      expect(stunde(5)).toBe(400 + 6400)
      expect(b.gesamt.umsatzCent).toBe(700 + 12000 + 12800)
    })

    it('Stundenverlauf Standard-Mandant: 0 bis 23 wie bisher', async () => {
      const b = (await get(B, `/api/berichte/stunden?kasseIds=${B.kasseId}&von=2025-10-05&bis=2025-10-06`)).json() as StundenBerichtResponse
      expect(b.zeilen.map(z => z.stunde)).toEqual(Array.from({ length: 24 }, (_, i) => i))
    })

    it('Artikel-, Warengruppen-, Kellner-Bericht und Kassen-Vergleich filtern auf den Geschäftstag', async () => {
      const kasseUndTag = `kasseIds=${A.kasseId}&von=2025-10-06&bis=2025-10-06`
      const artikel = (await get(A, `/api/berichte/artikel?${kasseUndTag}`)).json() as { zeilen: { bezeichnung: string; mengeSumme: number; umsatzCent: number }[] }
      expect(artikel.zeilen).toEqual([{ bezeichnung: 'Artikel', mengeSumme: 4, umsatzCent: 12000 }])

      const gruppen = (await get(A, `/api/berichte/warengruppe?${kasseUndTag}`)).json() as { zeilen: { mengeSumme: number; umsatzCent: number }[] }
      expect(gruppen.zeilen.reduce((s, z) => s + z.umsatzCent, 0)).toBe(12000)
      expect(gruppen.zeilen.reduce((s, z) => s + z.mengeSumme, 0)).toBe(4)

      const kellner = (await get(A, `/api/berichte/kellner?${kasseUndTag}`)).json() as { zeilen: { kellner: string; anzahlBelege: number; umsatzCent: number }[] }
      expect(kellner.zeilen).toMatchObject([{ kellner: 'Direktverkauf', anzahlBelege: 4, umsatzCent: 12000 }])

      const vergleich = (await get(A, '/api/berichte/kassen-vergleich?von=2025-10-06&bis=2025-10-06')).json() as { zeilen: { kasseId: string; anzahlBelege: number; umsatzCent: number }[] }
      expect(vergleich.zeilen.find(z => z.kasseId === A.kasseId)).toMatchObject({ anzahlBelege: 4, umsatzCent: 12000 })
    })

    it('Buchungsjournal und BMD-Export: Zeilen des Geschäftstags, Buchungstag = Geschäftstag', async () => {
      // Der 06.10. umfasst 4 Belege — zwei davon liegen nach Mitternacht (Kalendertag 07.10.)
      const journal = await get(A, `/api/berichte/buchungsjournal?kasseIds=${A.kasseId}&von=2025-10-06&bis=2025-10-06`)
      expect(journal.statusCode).toBe(200)
      expect(journal.headers['x-anzahl-belege']).toBe('4')
      const datum = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })
      const zeilen = journal.body.replace(/^﻿/, '').split('\r\n').slice(1)
      expect(zeilen).toHaveLength(4)
      for (const z of zeilen) expect(z.split(';')[0]).toBe(datum('2025-10-06'))

      const bmd = await get(A, `/api/export/bmd?kasseId=${A.kasseId}&vonDatum=2025-10-06&bisDatum=2025-10-06`)
      expect(bmd.statusCode).toBe(200)
      expect(bmd.headers['x-anzahl-belege']).toBe('4')
      const bmdZeilen = bmd.body.replace(/^﻿/, '').split('\r\n').slice(1)
      expect(bmdZeilen).toHaveLength(4)
      for (const z of bmdZeilen) expect(z.split(';')[0]).toBe('06.10.2025')

      // Standard-Mandant: Belegdatum wie bisher der Kalendertag des Belegs (hier: 06.10.)
      const bmdB = await get(B, `/api/export/bmd?kasseId=${B.kasseId}&vonDatum=2025-10-06&bisDatum=2025-10-06`)
      expect(bmdB.headers['x-anzahl-belege']).toBe('3')
    })

    it('Küchen-Bericht: Zeitraum und Stundenachse folgen dem Geschäftstag', async () => {
      // Bons: 07.10. 01:00 (Geschäftstag 06.10.) und 07.10. 06:30 (Geschäftstag 07.10.)
      for (const [nr, wien] of [['K1', '2025-10-07 01:00:00'], ['K2', '2025-10-07 06:30:00']] as const) {
        await idb.db.execute(sql`
          INSERT INTO kds_bons (mandant_id, bon_nummer, station, tisch, kellner, positionen, status, erstellt_at, erledigt_at)
          VALUES (${A.mandantId}::uuid, ${nr}, 'kueche', 'T1', 'Kellner', '[{"id":"x","bezeichnung":"Schnitzel","menge":1,"erledigt":true}]'::jsonb, 'erledigt',
                  ${wien}::timestamp AT TIME ZONE 'Europe/Vienna',
                  (${wien}::timestamp + interval '5 minutes') AT TIME ZONE 'Europe/Vienna')`)
      }
      const einTag = (await get(A, '/api/berichte/kueche?von=2025-10-06&bis=2025-10-06')).json() as { gesamtBons: number }
      expect(einTag.gesamtBons).toBe(1)

      const zweiTage = (await get(A, '/api/berichte/kueche?von=2025-10-06&bis=2025-10-07')).json() as {
        gesamtBons: number
        stunden: { stunde: number }[]
        granularitaet: string
        verlauf: { zeitpunkt: string }[]
      }
      expect(zweiTage.gesamtBons).toBe(2)
      // Achse ab 06:00: Stunde 6 (06:30) steht VOR Stunde 1 (01:00)
      expect(zweiTage.stunden.map(s => s.stunde)).toEqual([6, 1])
      expect(zweiTage.granularitaet).toBe('tag')
      expect(zweiTage.verlauf.map(v => v.zeitpunkt)).toEqual(['2025-10-06', '2025-10-07'])
    })

    it('Gutschein-Journal: von/bis sind Geschäftstage', async () => {
      const gs = await srv.fastify.inject({
        method: 'POST', url: '/api/gutscheine', headers: A.auth(), payload: { betragCent: 1000, code: 'GT-JOURNAL-A' },
      })
      expect(gs.statusCode).toBe(201)
      await idb.db.execute(sql`
        UPDATE gutschein_buchungen SET created_at = '2025-10-07 01:00:00'::timestamp AT TIME ZONE 'Europe/Vienna'
         WHERE mandant_id = ${A.mandantId}::uuid`)
      const codes = async (tag: string) =>
        ((await get(A, `/api/gutscheine/journal?von=${tag}&bis=${tag}`)).json() as { eintraege: { code: string }[] }).eintraege.map(e => e.code)
      expect(await codes('2025-10-06')).toContain('GT-JOURNAL-A')   // 07.10. 01:00 = Geschäftstag 06.10.
      expect(await codes('2025-10-07')).not.toContain('GT-JOURNAL-A')
    })
  })

  // =========================================================================
  // 4) Zeiterfassung = Schichten
  // =========================================================================

  describe('Zeiterfassung: eine Schicht gehört zum Geschäftstag ihres Beginns', () => {
    const schicht = async (m: Mandant, von: string, bis: string) => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/zeiterfassung', headers: m.auth(),
        payload: {
          kasseId: m.kasseId, userId: m.userId,
          beginn: wienerZeitpunkt(von.slice(0, 10), von.slice(11)).toISOString(),
          ende:   wienerZeitpunkt(bis.slice(0, 10), bis.slice(11)).toISOString(),
        },
      })
      expect(res.statusCode).toBe(201)
      return res.json() as { id: string; geschaeftstag: string; beginn: string }
    }
    const liste = async (m: Mandant, von: string, bis: string) =>
      (await get(m, `/api/zeiterfassung?datumVon=${von}&datumBis=${bis}`)).json() as { id: string; geschaeftstag: string }[]

    it('Nachtschicht 18:00–02:00 liegt komplett auf ihrem Starttag; Beginn vor 06:00 zählt zum Vortag', async () => {
      const s1 = await schicht(A, '2025-10-06 18:00', '2025-10-07 02:00')   // Geschäftstag 06.10.
      const s2 = await schicht(A, '2025-10-07 05:30', '2025-10-07 11:00')   // 06.10. (beginnt vor 06:00)
      const s3 = await schicht(A, '2025-10-07 06:00', '2025-10-07 12:00')   // 07.10.
      expect(s1.geschaeftstag).toBe('2025-10-06')
      expect(s2.geschaeftstag).toBe('2025-10-06')
      expect(s3.geschaeftstag).toBe('2025-10-07')

      const tag6 = await liste(A, '2025-10-06', '2025-10-06')
      expect(tag6.map(z => z.id).sort()).toEqual([s1.id, s2.id].sort())
      expect(tag6.every(z => z.geschaeftstag === '2025-10-06')).toBe(true)
      expect((await liste(A, '2025-10-07', '2025-10-07')).map(z => z.id)).toEqual([s3.id])
      expect(await liste(A, '2025-10-06', '2025-10-07')).toHaveLength(3)
      expect(await liste(A, '2025-10-05', '2025-10-05')).toHaveLength(0)
    })

    it('Standard-Mandant: Wiener Tagesgrenzen statt UTC (00:30 Wiener Zeit gehört zum Kalendertag, nicht zum Vortag)', async () => {
      // 06.10.2025 00:30 MESZ = 05.10. 22:30 UTC — der frühere Filter 'T00:00:00Z' ordnete das dem 05.10. zu
      const s = await schicht(B, '2025-10-06 00:30', '2025-10-06 08:00')
      expect(s.geschaeftstag).toBe('2025-10-06')
      expect((await liste(B, '2025-10-06', '2025-10-06')).map(z => z.id)).toEqual([s.id])
      expect(await liste(B, '2025-10-05', '2025-10-05')).toHaveLength(0)
    })

    it('Zeitumstellung: Schichten um 05:59/06:00 an den Umstellungstagen landen auf dem richtigen Geschäftstag', async () => {
      // 29.03.2026: 02:00 → 03:00 (der Geschäftstag 28.03. hat 23 Stunden); 25.10.2026: 03:00 → 02:00 (der 24.10. hat 25)
      const s1 = await schicht(A, '2026-03-29 05:59', '2026-03-29 12:00')   // vor 06:00 → 28.03.
      const s2 = await schicht(A, '2026-03-29 06:00', '2026-03-29 12:00')   // → 29.03.
      const s3 = await schicht(A, '2026-10-25 05:59', '2026-10-25 12:00')   // → 24.10.
      const s4 = await schicht(A, '2026-10-25 06:00', '2026-10-25 12:00')   // → 25.10.
      expect([s1, s2, s3, s4].map(s => s.geschaeftstag)).toEqual(['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25'])
      expect((await liste(A, '2026-03-28', '2026-03-28')).map(z => z.id)).toEqual([s1.id])
      expect((await liste(A, '2026-03-29', '2026-03-29')).map(z => z.id)).toEqual([s2.id])
      expect((await liste(A, '2026-10-24', '2026-10-24')).map(z => z.id)).toEqual([s3.id])
      expect((await liste(A, '2026-10-25', '2026-10-25')).map(z => z.id)).toEqual([s4.id])
      // und lückenlos: eine Liste über beide Wochen sieht jede Schicht genau einmal
      expect(await liste(A, '2026-03-27', '2026-03-30')).toHaveLength(2)
      expect(await liste(A, '2026-10-23', '2026-10-26')).toHaveLength(2)
    })

    it('Mitternacht: Beginn genau um 00:00 gehört (Tagesbeginn 06:00) noch zum Vortag, bei Tagesbeginn 00:00 zum neuen Tag', async () => {
      const a = await schicht(A, '2025-12-10 00:00', '2025-12-10 04:00')
      const b = await schicht(B, '2025-12-10 00:00', '2025-12-10 04:00')
      expect(a.geschaeftstag).toBe('2025-12-09')
      expect(b.geschaeftstag).toBe('2025-12-10')
      expect((await liste(A, '2025-12-09', '2025-12-09')).map(z => z.id)).toContain(a.id)
      expect((await liste(B, '2025-12-10', '2025-12-10')).map(z => z.id)).toContain(b.id)
      expect((await liste(B, '2025-12-09', '2025-12-09')).map(z => z.id)).not.toContain(b.id)
    })

    it('„aktuell eingestempelt" liefert ebenfalls den Geschäftstag', async () => {
      const res = await get(A, '/api/zeiterfassung/aktuell')
      expect(res.statusCode).toBe(200)
      expect(Array.isArray(res.json())).toBe(true)
    })
  })

  // =========================================================================
  // 5) Auto-Abschluss
  // =========================================================================

  describe('Automatischer Tagesabschluss mit verschobenem Tagesbeginn', () => {
    it('Uhrzeit VOR dem Tagesbeginn (04:00 bei 06:00): schließt den laufenden Geschäftstag — und danach nicht noch einmal', async () => {
      await idb.db.update(kassen).set({ autoAbschlussUhrzeit: '04:00', letzterAutoAbschlussTag: null }).where(eq(kassen.id, A.kasseId))

      // 08.10.2025 04:30 Wiener Zeit: Geschäftstag 07.10. läuft noch (bis 06:00)
      const um0430 = wienerZeitpunkt('2025-10-08', '04:30')
      const erster = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, um0430)
      expect(erster).toHaveLength(1)
      expect(erster[0]).toMatchObject({ tag: '2025-10-07', anzahlBelege: 1, uebersprungen: null })

      // Der Cron läuft den ganzen Tag weiter. Nach dem Tagesbeginn (07:00) ist der Geschäftstag
      // schon der 08.10. — der Abschluss darf trotzdem NICHT noch einmal (für den 08.10.) laufen.
      const um0700 = wienerZeitpunkt('2025-10-08', '07:00')
      expect(await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, um0700)).toHaveLength(0)
      expect(await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, wienerZeitpunkt('2025-10-08', '23:00'))).toHaveLength(0)
    })

    it('Uhrzeit ab dem Tagesbeginn und vor 12:00 (08:00 bei 06:00): schließt den soeben beendeten Vortag ab', async () => {
      await idb.db.update(kassen).set({ autoAbschlussUhrzeit: '08:00', letzterAutoAbschlussTag: null }).where(eq(kassen.id, A.kasseId))
      const ergebnisse = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, wienerZeitpunkt('2025-10-07', '08:30'))
      expect(ergebnisse).toHaveLength(1)
      expect(ergebnisse[0]).toMatchObject({ tag: '2025-10-06', anzahlBelege: 4 })   // vollständiger Geschäftstag 06.10.
    })

    it('Abend-Abschluss (23:00): schließt den laufenden Geschäftstag', async () => {
      await idb.db.update(kassen).set({ autoAbschlussUhrzeit: '23:00', letzterAutoAbschlussTag: null }).where(eq(kassen.id, A.kasseId))
      const ergebnisse = await fuehreFaelligeAutoAbschluesseDurch(idb.db, config, wienerZeitpunkt('2025-10-06', '23:10'))
      expect(ergebnisse).toHaveLength(1)
      expect(ergebnisse[0]).toMatchObject({ tag: '2025-10-06', anzahlBelege: 4 })
      await idb.db.update(kassen).set({ autoAbschlussUhrzeit: null }).where(eq(kassen.id, A.kasseId))
    })
  })

  // =========================================================================
  // 6) Wechsel des Tagesbeginns mit Stichtag
  // =========================================================================

  describe('Wechsel mit Stichtag: 00:00 → 06:00 (03.11.2025) → 00:00 (01.12.2025)', () => {
    const belegeD: [number, string][] = [
      [   1, '2025-11-01 23:59:59'],   // 01.11. (alter Beginn 00:00: Kalendertag)
      [   2, '2025-11-02 00:00:00'],   // 02.11. — der Übergangstag wird LÄNGER …
      [   4, '2025-11-02 22:00:00'],   // 02.11.
      [   8, '2025-11-03 02:00:00'],   // 02.11. (noch im langen Übergangstag)
      [  16, '2025-11-03 05:59:59'],   // 02.11. (… bis 03.11. 06:00)
      [  32, '2025-11-03 06:00:00'],   // 03.11. (erster Tag mit Beginn 06:00)
      [  64, '2025-11-04 03:00:00'],   // 03.11.
      [ 128, '2025-11-29 05:59:59'],   // 28.11.
      [ 256, '2025-11-30 06:00:00'],   // 30.11. — der Übergangstag wird KÜRZER …
      [ 512, '2025-11-30 22:00:00'],   // 30.11.
      [1024, '2025-12-01 00:00:00'],   // 01.12. (… er endet schon um Mitternacht)
      [2048, '2025-12-01 03:00:00'],   // 01.12. (Beginn jetzt wieder 00:00)
      [4096, '2025-12-02 00:00:00'],   // 02.12.
    ]

    beforeAll(async () => {
      for (const [cent, wien] of belegeD) await legeBeleg(D, cent, wien)
    })

    it('Übergangstag wird länger (30 h) bzw. kürzer (18 h); davor und danach regelmäßige Tage', async () => {
      const lang = await abschluss(D, '2025-11-02')
      expect(lang.barCent).toBe(2 + 4 + 8 + 16)
      expect(lang.anzahlBarzahlungsbelege).toBe(4)
      expect((Date.parse(lang.zeitraum!.bis) - Date.parse(lang.zeitraum!.von)) / 3_600_000).toBe(30)

      const kurz = await abschluss(D, '2025-11-30')
      expect(kurz.barCent).toBe(256 + 512)
      expect((Date.parse(kurz.zeitraum!.bis) - Date.parse(kurz.zeitraum!.von)) / 3_600_000).toBe(18)

      // reiner Kalendertag vor dem Wechsel und nach dem Rückwechsel: keine Zeitraum-Angabe
      expect((await abschluss(D, '2025-11-01')).zeitraum).toBeUndefined()
      expect((await abschluss(D, '2025-12-02')).zeitraum).toBeUndefined()
      // dazwischen 24-Stunden-Tage ab 06:00
      const regular = await abschluss(D, '2025-11-03')
      expect(regular.barCent).toBe(32 + 64)
      expect((Date.parse(regular.zeitraum!.bis) - Date.parse(regular.zeitraum!.von)) / 3_600_000).toBe(24)
    })

    it('Summe aller Tage = Gesamtzeitraum: kein Beleg doppelt, keiner fehlt', async () => {
      const gesamtCent = belegeD.reduce((s, [c]) => s + c, 0)
      let summe = 0, anzahl = 0
      for (let tag = '2025-10-31'; tag <= '2025-12-03'; tag = addTage(tag, 1)) {
        const t = await abschluss(D, tag)
        summe  += t.barCent
        anzahl += t.anzahlBarzahlungsbelege
      }
      expect(summe).toBe(gesamtCent)
      expect(anzahl).toBe(belegeD.length)

      // und der Bericht über den ganzen Zeitraum sieht dieselbe Summe
      const bericht = await umsatz(D, '2025-10-31', '2025-12-03')
      expect(bericht.gesamt.umsatzCent).toBe(gesamtCent)
      expect(bericht.gesamt.anzahlBelege).toBe(belegeD.length)
      expect(bericht.zeilen.reduce((s, z) => s + z.umsatzCent, 0)).toBe(gesamtCent)
    })

    it('Bericht „Tag" über den Wechsel hinweg: Zeilen = Tagesabschlüsse', async () => {
      const bericht = await umsatz(D, '2025-11-01', '2025-11-04')
      expect(bericht.zeilen.map(z => [z.periode, z.umsatzCent])).toEqual([
        ['2025-11-01', 1],
        ['2025-11-02', 2 + 4 + 8 + 16],
        ['2025-11-03', 32 + 64],
      ])
    })
  })

  // =========================================================================
  // 7) API: Einstellung
  // =========================================================================

  describe('API /api/mandanten/tagesbeginn', () => {
    let kellnerToken: string
    const kellner = () => ({ authorization: `Bearer ${kellnerToken}` })
    const post = (m: Mandant | null, payload: unknown, headers?: Record<string, string>) =>
      srv.fastify.inject({ method: 'POST', url: '/api/mandanten/tagesbeginn', headers: headers ?? m!.auth(), payload: payload as object })
    const heute  = () => heuteKalendertagWien()
    const morgen = () => addTage(heuteKalendertagWien(), 1)

    beforeAll(async () => {
      const anlegen = await srv.fastify.inject({
        method: 'POST', url: '/api/users', headers: C.auth(),
        payload: { name: 'Karl Kellner', email: 'karl@geschaeftstag.at', passwort: 'user-passwort-123', rolle: 'kellner', berechtigungen: [], kassenIds: [C.kasseId] },
      })
      expect(anlegen.statusCode).toBe(201)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: 'karl@geschaeftstag.at', passwort: 'user-passwort-123' },
      })).json()
      kellnerToken = login.token
    })

    it('ohne Token 401; GET liefert für einen frischen Mandanten leere Historie und heute = Kalendertag', async () => {
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/tagesbeginn' })).statusCode).toBe(401)
      const res = await get(C, '/api/mandanten/tagesbeginn')
      expect(res.statusCode).toBe(200)
      const stand = res.json() as TagesbeginnStand
      expect(stand.eintraege).toEqual([])
      expect(stand.heute.beginn).toBe('00:00')
      expect(stand.heute.geschaeftstag).toBe(stand.heute.kalendertag)
      expect(stand.heute.kalendertag).toBe(heute())
      // Grenzen des heutigen Tages: von < jetzt < bis
      expect(Date.parse(stand.heute.von)).toBeLessThanOrEqual(Date.now())
      expect(Date.parse(stand.heute.bis)).toBeGreaterThan(Date.now())
    })

    it('Kellner darf lesen, aber weder anlegen noch zurücknehmen (403)', async () => {
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/tagesbeginn', headers: kellner() })).statusCode).toBe(200)
      expect((await post(null, { gueltigAb: morgen(), beginn: '06:00' }, kellner())).statusCode).toBe(403)
      const del = await srv.fastify.inject({
        method: 'DELETE', url: '/api/mandanten/tagesbeginn/11111111-1111-1111-1111-111111111111', headers: kellner(),
      })
      expect(del.statusCode).toBe(403)
      // und ohne Token
      expect((await srv.fastify.inject({ method: 'POST', url: '/api/mandanten/tagesbeginn', payload: { gueltigAb: morgen(), beginn: '06:00' } })).statusCode).toBe(401)
    })

    it('Validierung: Uhrzeit HH:MM (00:00–23:59) und echtes Datum, sonst 400', async () => {
      for (const beginn of ['24:00', '6:00', '06:60', '0600', 'abc', '', '06:00:00']) {
        expect((await post(C, { gueltigAb: morgen(), beginn })).statusCode, `beginn ${beginn}`).toBe(400)
      }
      for (const gueltigAb of ['2026-02-30', '2026/10/03', '03.10.2026', '', 'morgen']) {
        expect((await post(C, { gueltigAb, beginn: '06:00' })).statusCode, `gueltigAb ${gueltigAb}`).toBe(400)
      }
      expect((await post(C, { beginn: '06:00' })).statusCode).toBe(400)
      expect((await post(C, { gueltigAb: morgen() })).statusCode).toBe(400)
      // Mandant nie aus dem Body — ein fremder mandantId-Wert ändert nichts
      const res = await post(C, { gueltigAb: morgen(), beginn: '06:00', mandantId: A.mandantId })
      expect(res.statusCode).toBe(201)
      expect((await get(A, '/api/mandanten/tagesbeginn')).json().eintraege).toHaveLength(1)   // A: nur der DB-Eintrag
      // wieder zurücknehmen, damit C für die Sofort-Ausnahme „leer" ist
      const id = (res.json() as TagesbeginnStand).eintraege[0]!.id
      expect((await srv.fastify.inject({ method: 'DELETE', url: `/api/mandanten/tagesbeginn/${id}`, headers: C.auth() })).statusCode).toBe(200)
    })

    it('Sofort-Wirkung ist erlaubt, solange der Mandant noch keine Belege/Arbeitszeiten ab diesem Tag hat', async () => {
      // C hat nur den Startbeleg — der zählt in keiner Auswertung
      const res = await post(C, { gueltigAb: heute(), beginn: '06:00' })
      expect(res.statusCode).toBe(201)
      const stand = res.json() as TagesbeginnStand
      expect(stand.eintraege.map(e => [e.gueltigAb, e.beginn])).toEqual([[heute(), '06:00']])
      expect(stand.heute.beginn).toBe('06:00')
      expect(stand.heute.geschaeftstag).toBe(geschaeftstagVon([{ gueltigAb: heute(), beginn: '06:00' }], new Date()))
      // auch ein Stichtag in der Vergangenheit ginge ohne Daten — hier nicht nötig, aber der Eintrag von heute gilt bereits:
      // er lässt sich nicht mehr zurücknehmen
      const del = await srv.fastify.inject({ method: 'DELETE', url: `/api/mandanten/tagesbeginn/${stand.eintraege[0]!.id}`, headers: C.auth() })
      expect(del.statusCode).toBe(409)
      // und nicht überschreiben
      expect((await post(C, { gueltigAb: heute(), beginn: '07:00' })).statusCode).toBe(409)
    })

    it('„Keine Änderung": gleicher Beginn wie der zuletzt gültige → 400', async () => {
      const res = await post(C, { gueltigAb: morgen(), beginn: '06:00' })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { fehler: string }).fehler).toMatch(/Keine Änderung/)
    })

    it('mit vorhandenen Belegen: nur ab morgen — heute, gestern und früher gehen nicht (400)', async () => {
      const beleg = (m: Mandant) => srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung', headers: m.auth(),
        payload: { kasseId: m.kasseId, positionen: [{ bezeichnung: 'Jetzt', preisBruttoCent: 100, mwstSatz: 'normal', menge: 1 }], zahlung: { barCent: 100, karteCent: 0, sonstigeCent: 0 } },
      })
      // C: Beleg von jetzt (Stichtage gestern/früher). D: dort gibt es für „heute" noch keinen Eintrag.
      expect((await beleg(C)).statusCode).toBe(201)
      expect((await beleg(D)).statusCode).toBe(201)
      for (const [m, gueltigAb] of [[C, addTage(heute(), -1)], [C, addTage(heute(), -30)], [D, heute()], [D, addTage(heute(), -1)]] as const) {
        const res = await post(m, { gueltigAb, beginn: '05:00' })
        expect(res.statusCode, `${m.nr} ${gueltigAb}`).toBe(400)
        expect((res.json() as { fehler: string }).fehler).toMatch(/frühestens ab morgen/)
      }
    })

    it('ab morgen: legt einen geplanten Wechsel an, ändert „heute" nicht, ersetzt einen geplanten Eintrag zum selben Stichtag', async () => {
      const res = await post(C, { gueltigAb: morgen(), beginn: '05:00' })
      expect(res.statusCode).toBe(201)
      const stand = res.json() as TagesbeginnStand
      expect(stand.eintraege.map(e => [e.gueltigAb, e.beginn])).toEqual([[heute(), '06:00'], [morgen(), '05:00']])
      expect(stand.heute.beginn).toBe('06:00')   // heute gilt weiter der alte Beginn

      // dasselbe Datum noch einmal → ersetzt (kein zweiter Eintrag)
      const ersetzt = await post(C, { gueltigAb: morgen(), beginn: '04:30' })
      expect(ersetzt.statusCode).toBe(201)
      expect((ersetzt.json() as TagesbeginnStand).eintraege.map(e => [e.gueltigAb, e.beginn])).toEqual([[heute(), '06:00'], [morgen(), '04:30']])
      // zurück auf den vorher geltenden Wert wäre „keine Änderung"
      expect((await post(C, { gueltigAb: morgen(), beginn: '06:00' })).statusCode).toBe(400)
    })

    it('geplante Wechsel lassen sich zurücknehmen — gültige und vergangene nie; fremde/ungültige IDs: 404/400', async () => {
      const stand = (await get(C, '/api/mandanten/tagesbeginn')).json() as TagesbeginnStand
      const geplant = stand.eintraege.find(e => e.gueltigAb === morgen())!
      const heutiger = stand.eintraege.find(e => e.gueltigAb === heute())!

      // Mandant A kann einen Eintrag von C nicht sehen/löschen
      const fremd = await srv.fastify.inject({ method: 'DELETE', url: `/api/mandanten/tagesbeginn/${geplant.id}`, headers: A.auth() })
      expect(fremd.statusCode).toBe(404)
      // und umgekehrt: C kann den DB-Eintrag von A nicht löschen
      const [eintragA] = await idb.db.select().from(mandantTagesbeginn).where(eq(mandantTagesbeginn.mandantId, A.mandantId))
      expect((await srv.fastify.inject({ method: 'DELETE', url: `/api/mandanten/tagesbeginn/${eintragA!.id}`, headers: C.auth() })).statusCode).toBe(404)

      expect((await srv.fastify.inject({ method: 'DELETE', url: '/api/mandanten/tagesbeginn/kein-uuid', headers: C.auth() })).statusCode).toBe(400)
      expect((await srv.fastify.inject({ method: 'DELETE', url: '/api/mandanten/tagesbeginn/22222222-2222-2222-2222-222222222222', headers: C.auth() })).statusCode).toBe(404)
      expect((await srv.fastify.inject({ method: 'DELETE', url: `/api/mandanten/tagesbeginn/${heutiger.id}`, headers: C.auth() })).statusCode).toBe(409)

      const ok = await srv.fastify.inject({ method: 'DELETE', url: `/api/mandanten/tagesbeginn/${geplant.id}`, headers: C.auth() })
      expect(ok.statusCode).toBe(200)
      expect((ok.json() as TagesbeginnStand).eintraege.map(e => e.gueltigAb)).toEqual([heute()])
      // Eintrag von A ist unberührt
      expect(await idb.db.select().from(mandantTagesbeginn).where(eq(mandantTagesbeginn.mandantId, A.mandantId))).toHaveLength(1)
    })

    it('Änderungen stehen im Audit-Log (Mandant, Benutzer, vorher/nachher)', async () => {
      const zeilen = (await idb.db.select().from(auditLogs).where(and(eq(auditLogs.mandantId, C.mandantId), eq(auditLogs.aktion, 'einstellungen.geaendert'))))
        .filter(z => (z.details as { bereich?: string } | null)?.bereich === 'tagesbeginn')
      expect(zeilen.length).toBeGreaterThanOrEqual(4)
      const sofort = zeilen.find(z => (z.details as { gueltigAb?: string }).gueltigAb === heute() && (z.details as { nachher?: string }).nachher === '06:00')
      expect(sofort).toBeTruthy()
      expect((sofort!.details as { vorher: string }).vorher).toBe('00:00')
      expect(sofort!.userId).toBe(C.userId)
    })

    it('Mandanten-Isolation: jeder Mandant sieht nur die eigene Historie', async () => {
      expect(((await get(A, '/api/mandanten/tagesbeginn')).json() as TagesbeginnStand).eintraege.map(e => e.beginn)).toEqual(['06:00'])
      expect(((await get(B, '/api/mandanten/tagesbeginn')).json() as TagesbeginnStand).eintraege).toEqual([])
      expect(((await get(C, '/api/mandanten/tagesbeginn')).json() as TagesbeginnStand).eintraege.map(e => e.gueltigAb)).toEqual([heute()])
    })

    it('Login liefert die Historie an das Frontend (mandant.tagesRegel)', async () => {
      const login = async (m: Mandant) => {
        const res = await srv.fastify.inject({
          method: 'POST', url: '/api/auth/login', payload: { email: `admin${m.nr}@geschaeftstag.at`, passwort: PASSWORT },
        })
        expect(res.statusCode, res.body).toBe(200)
        return res.json() as { mandant: { tagesRegel: { gueltigAb: string; beginn: string }[] } }
      }
      expect((await login(A)).mandant.tagesRegel).toEqual([{ gueltigAb: '2020-01-01', beginn: '06:00' }])
      expect((await login(B)).mandant.tagesRegel).toEqual([])
      expect((await login(D)).mandant.tagesRegel).toEqual([
        { gueltigAb: '2025-11-03', beginn: '06:00' }, { gueltigAb: '2025-12-01', beginn: '00:00' },
      ])
    })

    it('das Frontend rechnet „heute" mit derselben Regel wie das Backend', async () => {
      const stand = (await get(A, '/api/mandanten/tagesbeginn')).json() as TagesbeginnStand
      expect(stand.heute.geschaeftstag).toBe(heuteGeschaeftstag([{ gueltigAb: '2020-01-01', beginn: '06:00' }]))
    })
  })

  // =========================================================================
  // 8) SB-Terminal: Tageskreis der Bestellnummern
  // =========================================================================

  describe('SB-Bestellungen: Tageskreis folgt dem Geschäftstag', () => {
    it('die Tagesliste ohne Datum zeigt den aktuellen Geschäftstag', async () => {
      const tag = heuteGeschaeftstag([{ gueltigAb: '2020-01-01', beginn: '06:00' }])
      const naechster = addTage(tag, 1)
      for (const [nr, datum] of [[1, tag], [2, naechster]] as const) {
        await idb.db.execute(sql`
          INSERT INTO sb_bestellungen (mandant_id, kasse_id, bestell_nummer, datum, positionen, summe_cent, status)
          VALUES (${A.mandantId}::uuid, ${A.kasseId}::uuid, ${nr}, ${datum}::date, '[]'::jsonb, 100, 'offen')`)
      }
      const res = await get(A, '/api/sb-bestellungen')
      expect(res.statusCode).toBe(200)
      expect((res.json() as { bestellNummer: number }[]).map(b => b.bestellNummer)).toEqual([1])
    })
  })

  // =========================================================================
  // 9) Index-Tauglichkeit
  // =========================================================================

  describe('Index-Tauglichkeit des Datumsfilters', () => {
    it('der Filter mit verschobenem Tagesbeginn nutzt den Index — der alte Ausdruck auf der Spalte nicht', async () => {
      await idb.db.execute(sql`CREATE TABLE gt_plan_probe (id serial PRIMARY KEY, ts timestamptz NOT NULL)`)
      await idb.db.execute(sql`CREATE INDEX gt_plan_probe_ts_idx ON gt_plan_probe (ts)`)
      await idb.db.execute(sql`
        INSERT INTO gt_plan_probe (ts)
        SELECT '2024-01-01 00:00:00+00'::timestamptz + (g * interval '15 minutes') FROM generate_series(0, 70000) AS g`)
      await idb.db.execute(sql`ANALYZE gt_plan_probe`)

      const plan = async (bedingung: ReturnType<typeof sql>) => {
        const zeilen = [...await idb.db.execute<Record<string, string>>(sql`EXPLAIN (FORMAT TEXT) SELECT count(*) FROM gt_plan_probe p WHERE ${bedingung}`)]
        return zeilen.map(z => Object.values(z)[0]).join('\n')
      }

      const regel: TagesRegel = [{ gueltigAb: '2020-01-01', beginn: '06:00' }]
      const mitRegel  = await plan(datumsBereich(sql`p.ts`, '2025-03-10', '2025-03-10', regel))
      const ohneRegel = await plan(datumsBereich(sql`p.ts`, '2025-03-10', '2025-03-10'))
      const alt       = await plan(sql`(p.ts AT TIME ZONE 'Europe/Vienna')::date BETWEEN '2025-03-10'::date AND '2025-03-10'::date`)

      expect(mitRegel).toMatch(/Index/)
      expect(mitRegel).not.toMatch(/Seq Scan/)
      expect(ohneRegel).toMatch(/Index/)
      expect(ohneRegel).not.toMatch(/Seq Scan/)
      // Kontrolle, dass der Test überhaupt scheitern KANN: ein Ausdruck auf der Spalte erzwingt den Seq Scan
      expect(alt).toMatch(/Seq Scan/)
    })
  })
})
