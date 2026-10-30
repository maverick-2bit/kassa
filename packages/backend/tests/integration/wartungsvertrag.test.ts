import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { lieferscheine } from '../../src/db/schema.js'
import { ermittleFaelligeRechnungen, fuehreWartungslaufDurch } from '../../src/services/wartungsvertrag.service.js'

const ADMIN_EMAIL    = 'admin@wartung.at'
const ADMIN_PASSWORT = 'wartung-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'WV-PW' }),
  } as unknown as FinanzOnlineClient
}

/** Mittag in Wien — unabhängig von Sommer-/Winterzeit im selben Kalendertag */
const am = (datum: string) => new Date(`${datum}T10:00:00Z`)

describe('Wartungsverträge: Monatslauf + Sammelabrechnung (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let mandantId: string
  let kasseId: string
  let kundeId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function legeVertragAn(payload: Record<string, unknown>) {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/wartungsvertraege', headers: auth(),
      payload: { kasseId, kundeId, bezeichnung: 'Kassa-Wartung', ...payload },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as { id: string; nummer: number }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Wartung GmbH', uid: 'ATU99999922', kassenId: 'WV-001',
        finanzOnline: { teilnehmerId: 'TID-WV', benutzerkennung: 'BID-WV', pin: 'PIN-WV' },
        umgebung: 'test',
        admin: { name: 'WV Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    kasseId   = login.kassen[0].id
    mandantId = login.user?.mandantId ?? login.mandantId

    const kunde = (await srv.fastify.inject({
      method: 'POST', url: '/api/kunden', headers: auth(),
      payload: { firma: 'Wirtshaus Muster', email: 'wirt@muster.at' },
    })).json()
    kundeId = kunde.id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('legt einen Vertrag mit Positionen und eigenen Intervallen an', async () => {
    const v = await legeVertragAn({
      beginn: '2026-01-01',
      rechnungsIntervall: 'quartal',
      positionen: [
        { bezeichnung: 'Support', einzelpreisBreutto: 4900, mwstSatz: 'normal' },
        { bezeichnung: 'RKSV-Zertifikat', einzelpreisBreutto: 12000, mwstSatz: 'normal', intervall: 'jahr', ankerMonat: 1 },
      ],
    })
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/wartungsvertraege/${v.id}`, headers: auth() })
    const dto = res.json()
    expect(dto.nummer).toBe(1)
    expect(dto.kunde.bezeichnung).toContain('Wirtshaus Muster')
    expect(dto.positionen).toHaveLength(2)
    expect(dto.positionen[1]).toMatchObject({ intervall: 'jahr', ankerMonat: 1 })
    expect(dto.offeneLieferscheine).toBe(0)
  })

  it('Monatslauf: Vorschau ändert nichts, echter Lauf erzeugt je Monat einen Lieferschein, Wiederholung nichts', async () => {
    // eigener Vertrag: Start Aug 2026, Zertifikat jährlich im Oktober
    const v = await legeVertragAn({
      bezeichnung: 'Lauf-Test', beginn: '2026-08-01', rechnungsIntervall: 'monatlich',
      positionen: [
        { bezeichnung: 'Support', menge: 2, einzelpreisBreutto: 1000, mwstSatz: 'normal' },
        { bezeichnung: 'Zertifikat', einzelpreisBreutto: 5000, mwstSatz: 'normal', intervall: 'jahr', ankerMonat: 10 },
      ],
    })

    const vorschau = await srv.fastify.inject({
      method: 'POST', url: '/api/wartungsvertraege/lauf', headers: auth(), payload: { vorschau: true },
    })
    const meine = (vorschau.json().eintraege as Array<{ vertragId: string; periode: string; betragCent: number; positionen: number }>)
      .filter(e => e.vertragId === v.id)
    expect(meine.length).toBeGreaterThan(0)
    const vorLs = await idb.db.select().from(lieferscheine).where(eq(lieferscheine.wartungsvertragId, v.id))
    expect(vorLs).toHaveLength(0)

    const lauf = await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-30'), mandantId })
    const erzeugt = lauf.eintraege.filter(e => e.vertragId === v.id)
    expect(erzeugt.map(e => e.periode)).toEqual(['2026-08', '2026-09', '2026-10'])
    // Aug/Sep nur Support (2 × 10,00 €); Okt zusätzlich das jährliche Zertifikat
    expect(erzeugt.map(e => e.betragCent)).toEqual([2000, 2000, 7000])
    expect(erzeugt.map(e => e.positionen)).toEqual([1, 1, 2])
    expect(erzeugt.every(e => e.lieferscheinNummer !== undefined)).toBe(true)

    const wiederholt = await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-30'), mandantId })
    expect(wiederholt.eintraege.filter(e => e.vertragId === v.id)).toHaveLength(0)

    const ls = await idb.db.select().from(lieferscheine).where(eq(lieferscheine.wartungsvertragId, v.id))
    expect(ls).toHaveLength(3)
    expect(ls.every(l => l.angebotId === null && l.kasseId === kasseId)).toBe(true)

    // Monatswechsel: November erzeugt genau einen weiteren Lieferschein (ohne Zertifikat)
    const nov = await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-11-01'), mandantId })
    expect(nov.eintraege.filter(e => e.vertragId === v.id).map(e => [e.periode, e.betragCent])).toEqual([['2026-11', 2000]])
  })

  it('Lieferschein-API zeigt Vertragsbezug und Periode', async () => {
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/lieferscheine', headers: auth() })).json() as
      Array<{ wartungsvertragNummer?: number; periode?: string; angebotId?: string }>
    const wartung = liste.filter(l => l.wartungsvertragNummer !== undefined)
    expect(wartung.length).toBeGreaterThan(0)
    expect(wartung[0]!.periode).toMatch(/^\d{4}-\d{2}$/)
    expect(wartung[0]!.angebotId).toBeUndefined()
  })

  it('pausierte Verträge, Vertragsende und Beginn mitten im Monat', async () => {
    const pausiert = await legeVertragAn({
      bezeichnung: 'Pausiert', beginn: '2026-09-01', status: 'pausiert',
      positionen: [{ bezeichnung: 'X', einzelpreisBreutto: 100, mwstSatz: 'normal' }],
    })
    const befristet = await legeVertragAn({
      bezeichnung: 'Befristet', beginn: '2026-09-01', ende: '2026-09-30',
      positionen: [{ bezeichnung: 'Y', einzelpreisBreutto: 100, mwstSatz: 'normal' }],
    })
    const mittendrin = await legeVertragAn({
      bezeichnung: 'Mittendrin', beginn: '2026-09-15',
      positionen: [{ bezeichnung: 'Z', einzelpreisBreutto: 100, mwstSatz: 'normal' }],
    })

    const lauf = await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-11-15'), mandantId })
    const perioden = (id: string) => lauf.eintraege.filter(e => e.vertragId === id).map(e => e.periode)
    expect(perioden(pausiert.id)).toEqual([])
    expect(perioden(befristet.id)).toEqual(['2026-09'])
    expect(perioden(mittendrin.id)).toEqual(['2026-10', '2026-11'])
  })

  it('Nachholen ist auf 12 Monate begrenzt', async () => {
    const alt = await legeVertragAn({
      bezeichnung: 'Alt', beginn: '2020-01-01',
      positionen: [{ bezeichnung: 'A', einzelpreisBreutto: 100, mwstSatz: 'normal' }],
    })
    const lauf = await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-11-15'), mandantId })
    const e = lauf.eintraege.filter(x => x.vertragId === alt.id).map(x => x.periode)
    expect(e).toHaveLength(12)
    expect(e[0]).toBe('2025-12')
    expect(e[11]).toBe('2026-11')
  })

  it('Sammelabrechnung: quartalsweise wird erst mit dem letzten Monat des Blocks fällig', async () => {
    const q = await legeVertragAn({
      bezeichnung: 'Quartal', beginn: '2027-01-01', rechnungsIntervall: 'quartal',
      positionen: [{ bezeichnung: 'Q', einzelpreisBreutto: 3000, mwstSatz: 'normal' }],
    })

    // Die Route nutzt die echte Uhr; den Zeitpunkt prüfen wir deshalb am Service direkt.
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2027-02-10'), mandantId })
    expect((await ermittleFaelligeRechnungen(idb.db, mandantId, am('2027-02-10'), q.id))).toHaveLength(0)

    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2027-03-01'), mandantId })
    const [f] = await ermittleFaelligeRechnungen(idb.db, mandantId, am('2027-03-01'), q.id)
    expect(f?.perioden).toEqual(['2027-01', '2027-02', '2027-03'])
    expect(f?.betragCent).toBe(9000)

    const route = await srv.fastify.inject({ method: 'GET', url: '/api/wartungsvertraege/faellige-rechnungen', headers: auth() })
    expect(route.statusCode).toBe(200)
    expect(Array.isArray(route.json())).toBe(true)
  })

  it('Abrechnen bündelt die Wartungslieferscheine in einer Sammelrechnung und schließt sie ab', async () => {
    const m = await legeVertragAn({
      bezeichnung: 'Monatlich', beginn: '2026-01-01', rechnungsIntervall: 'monatlich',
      positionen: [{ bezeichnung: 'M', einzelpreisBreutto: 2500, mwstSatz: 'normal' }],
    })
    // Vergangene Monate fällig → Abrechnen über die Route (echte Uhr, daher mehrere Monate möglich)
    await fuehreWartungslaufDurch(idb.db, { jetzt: new Date(), mandantId })

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/wartungsvertraege/${m.id}/abrechnen`, headers: auth(),
    })
    expect(res.statusCode, res.body).toBe(201)
    const sr = res.json()
    expect(sr.lieferscheine.length).toBeGreaterThan(0)
    expect(sr.gesamtbetragCent).toBe(sr.lieferscheine.length * 2500)

    const nochmal = await srv.fastify.inject({
      method: 'POST', url: `/api/wartungsvertraege/${m.id}/abrechnen`, headers: auth(),
    })
    expect(nochmal.statusCode).toBe(409)

    const dto = (await srv.fastify.inject({ method: 'GET', url: `/api/wartungsvertraege/${m.id}`, headers: auth() })).json()
    expect(dto.offeneLieferscheine).toBe(0)
  })

  it('Beginn lässt sich nach erzeugten Lieferscheinen nicht mehr ändern; Positionen schon', async () => {
    const v = await legeVertragAn({
      bezeichnung: 'Ändern', beginn: '2026-10-01',
      positionen: [{ bezeichnung: 'A', einzelpreisBreutto: 100, mwstSatz: 'normal' }],
    })
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })

    const beginn = await srv.fastify.inject({
      method: 'PATCH', url: `/api/wartungsvertraege/${v.id}`, headers: auth(), payload: { beginn: '2026-05-01' },
    })
    expect(beginn.statusCode).toBe(409)

    const pos = await srv.fastify.inject({
      method: 'PATCH', url: `/api/wartungsvertraege/${v.id}`, headers: auth(),
      payload: { positionen: [{ bezeichnung: 'B', einzelpreisBreutto: 200, mwstSatz: 'normal' }] },
    })
    expect(pos.statusCode).toBe(200)
    expect(pos.json().positionen[0].bezeichnung).toBe('B')
  })

  it('fremde Kunden/Kassen und ungültige IDs werden abgewiesen', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/wartungsvertraege', headers: auth(),
      payload: {
        kasseId, kundeId: '33333333-3333-4333-8333-333333333333', bezeichnung: 'X', beginn: '2026-01-01',
        positionen: [{ bezeichnung: 'A', einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      },
    })
    expect(res.statusCode).toBe(404)
    const id = await srv.fastify.inject({ method: 'GET', url: '/api/wartungsvertraege/keine-uuid', headers: auth() })
    expect(id.statusCode).toBe(400)
  })
})
