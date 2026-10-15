/**
 * Integrationstest: Kassen-Ausnahmen beim Bon-Routing (Einstellungen → Kassen).
 *
 * Bisher gab es Drucker und KDS-Station nur allgemein je Warengruppe/Artikel — mit 10 Kassen auf
 * unterschiedliche Drucker ging das nicht. Jetzt kann jede Kasse Warengruppen UND Einzelartikel
 * abweichend routen. Rangfolge: Artikel an der Kasse → Artikel allgemein → Warengruppe an der
 * Kasse → Warengruppe allgemein. Echte TCP-Listener stehen für die Drucker.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kasseRouting, kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL = 'admin@kasse-routing.at', ADMIN_PASSWORT = 'kasse-routing-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KR-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

/** TCP-Drucker-Attrappe: zählt, wie viele Verbindungen mit Daten ankamen. */
function druckerAttrappe(): Promise<{ server: Server; port: number; empfangen: () => number }> {
  return new Promise(resolve => {
    let n = 0
    const server = createServer(socket => {
      let hatDaten = false
      socket.on('data', () => { if (!hatDaten) { hatDaten = true; n++ } })
      socket.on('error', () => undefined)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, empfangen: () => n }))
  })
}
const kurzWarten = () => new Promise(r => setTimeout(r, 150))

describe('Kassen-Ausnahmen beim Bon-Routing (Integration, echtes PostgreSQL + TCP-Listener)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasse1 = '', kasse2 = '', kasse3 = ''
  let a: Awaited<ReturnType<typeof druckerAttrappe>>, b: Awaited<ReturnType<typeof druckerAttrappe>>
  let druckerA = '', druckerB = ''
  let getraenke = '', speisen = '', cola = '', radler = '', schnitzel = ''

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = async (url: string, payload: unknown) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  const ausnahmen = (aenderungen: unknown[]) =>
    srv.fastify.inject({ method: 'PUT', url: '/api/einrichtung/ausnahmen', headers: auth(), payload: { aenderungen } })
  const uebersicht = async () =>
    (await srv.fastify.inject({ method: 'GET', url: '/api/einrichtung', headers: auth() })).json() as {
      kassen: { id: string; kassenId: string }[]
      ausnahmen: { kasseId: string; kategorieId: string | null; artikelId: string | null; bonierdruckerId: string | null; keinDrucker: boolean; station: string | null; keineStation: boolean }[]
    }
  /** Bonieren an einer Kasse; liefert, wie viele Bons bei Drucker A bzw. B NEU ankamen. */
  const bonieren = async (kasseId: string, artikelId: string) => {
    const vorA = a.empfangen(), vorB = b.empfangen()
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
      payload: { kasseId, tisch: 'T1', kellner: 'Anna', positionen: [{ artikelId, menge: 1 }] },
    })
    await kurzWarten()
    return { res, a: a.empfangen() - vorA, b: b.empfangen() - vorB }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    a = await druckerAttrappe()
    b = await druckerAttrappe()

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'KasseRouting GmbH', uid: 'ATU99999971', kassenId: 'KR-001',
        finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
        admin: { name: 'KR Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token  = login.token
    kasse1 = login.kassen[0].id
    // Zwei weitere Kassen (eigene SEE + Startbeleg); die IDs stehen in der Kassen-Liste
    for (const nr of ['KR-002', 'KR-003']) await post('/api/kassen', { kassenId: nr, umgebung: 'test' })
  })

  afterAll(async () => {
    a?.server.close(); b?.server.close()
    await srv?.close(); await idb?.zerstoeren()
  })

  it('Vorbereitung: zwei weitere Kassen, zwei Drucker, Warengruppen und Artikel', async () => {
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/kassen', headers: auth() })).json() as { id: string; kassenId: string }[]
    kasse2 = liste.find(k => k.kassenId === 'KR-002')!.id
    kasse3 = liste.find(k => k.kassenId === 'KR-003')!.id
    expect(new Set([kasse1, kasse2, kasse3]).size).toBe(3)

    druckerA = (await post('/api/bonierdrucker', { name: 'Bar A',   ip: '127.0.0.1', port: a.port })).id
    druckerB = (await post('/api/bonierdrucker', { name: 'Küche B', ip: '127.0.0.1', port: b.port })).id

    // Getränke drucken allgemein auf A; Speisen haben allgemein weder Drucker noch Station
    getraenke = (await post('/api/kategorien', { name: 'Getränke', farbe: 'blau', reihenfolge: 0, bonierdruckerId: druckerA })).id
    speisen   = (await post('/api/kategorien', { name: 'Speisen',  farbe: 'rot',  reihenfolge: 1 })).id
    cola      = (await post('/api/artikel', { bezeichnung: 'Cola',      preisBruttoCent: 400,  mwstSatz: 'normal', kategorieId: getraenke })).id
    // Radler hat seinen EIGENEN Drucker (B) — Artikel geht der Warengruppe vor
    radler    = (await post('/api/artikel', { bezeichnung: 'Radler',    preisBruttoCent: 450,  mwstSatz: 'normal', kategorieId: getraenke, bonierdruckerId: druckerB })).id
    schnitzel = (await post('/api/artikel', { bezeichnung: 'Schnitzel', preisBruttoCent: 1450, mwstSatz: 'normal', kategorieId: speisen })).id
  })

  it('Übersicht: alle Kassen mit ihren Einstellungen, noch keine Ausnahmen', async () => {
    const u = await uebersicht()
    expect(u.kassen.map(k => k.kassenId).sort()).toEqual(['KR-001', 'KR-002', 'KR-003'])
    expect(u.ausnahmen).toEqual([])
    const k = u.kassen[0] as unknown as Record<string, unknown>
    for (const feld of ['belegModus', 'druckerId', 'kdsAktiv', 'kdsPort', 'kdsStationen', 'startseite', 'gastModus',
      'sichtbareKategorieIds', 'sichtbareBonierdruckerIds', 'status', 'umgebung', 'beiFoRegistriert']) {
      expect(k, `Feld ${feld}`).toHaveProperty(feld)
    }
  })

  it('ohne Ausnahme gilt die allgemeine Vorgabe: Warengruppe → A, Artikel mit eigenem Drucker → B (an jeder Kasse)', async () => {
    for (const k of [kasse1, kasse2, kasse3]) {
      const c = await bonieren(k, cola)
      expect(c.res.statusCode, c.res.body).toBe(200)
      expect([c.a, c.b]).toEqual([1, 0])
      const r = await bonieren(k, radler)
      expect(r.res.statusCode, r.res.body).toBe(200)
      expect([r.a, r.b]).toEqual([0, 1])
    }
  })

  it('Ausnahme Warengruppe × Kasse: Kasse 2 druckt Getränke auf B, Kasse 1 und 3 weiter auf A', async () => {
    expect((await ausnahmen([{ kasseId: kasse2, kategorieId: getraenke, drucker: druckerB }])).statusCode).toBe(204)
    const k2 = await bonieren(kasse2, cola)
    expect([k2.res.statusCode, k2.a, k2.b]).toEqual([200, 0, 1])
    const k1 = await bonieren(kasse1, cola)
    expect([k1.res.statusCode, k1.a, k1.b]).toEqual([200, 1, 0])
    const k3 = await bonieren(kasse3, cola)
    expect([k3.res.statusCode, k3.a, k3.b]).toEqual([200, 1, 0])

    const u = await uebersicht()
    expect(u.ausnahmen).toEqual([{
      kasseId: kasse2, kategorieId: getraenke, artikelId: null,
      bonierdruckerId: druckerB, keinDrucker: false, station: null, keineStation: false,
    }])
  })

  it('Ausnahme Artikel × Kasse geht der eigenen Angabe des Artikels UND der Warengruppen-Ausnahme vor', async () => {
    // Radler: allgemein B; an Kasse 2 ausdrücklich A
    expect((await ausnahmen([{ kasseId: kasse2, artikelId: radler, drucker: druckerA }])).statusCode).toBe(204)
    const k2 = await bonieren(kasse2, radler)
    expect([k2.res.statusCode, k2.a, k2.b]).toEqual([200, 1, 0])
    // an Kasse 1 unverändert: eigener Drucker des Artikels (B)
    const k1 = await bonieren(kasse1, radler)
    expect([k1.res.statusCode, k1.a, k1.b]).toEqual([200, 0, 1])
  })

  it('„keiner": Kasse 3 druckt Getränke gar nicht — ein Artikel mit eigenem Drucker aber weiterhin', async () => {
    expect((await ausnahmen([{ kasseId: kasse3, kategorieId: getraenke, drucker: 'keiner' }])).statusCode).toBe(204)
    const c = await bonieren(kasse3, cola)
    expect(c.res.statusCode).toBe(400)
    expect(c.res.json().fehler).toMatch(/nichts zu bonieren/)
    expect([c.a, c.b]).toEqual([0, 0])
    // Radler hat einen eigenen Drucker (Artikel vor Warengruppe): „keiner" an der WARENGRUPPE trifft ihn nicht
    const r = await bonieren(kasse3, radler)
    expect([r.res.statusCode, r.a, r.b]).toEqual([200, 0, 1])
    // „keiner" AM ARTIKEL trifft ihn dagegen
    expect((await ausnahmen([{ kasseId: kasse3, artikelId: radler, drucker: 'keiner' }])).statusCode).toBe(204)
    const r2 = await bonieren(kasse3, radler)
    expect(r2.res.statusCode).toBe(400)
  })

  it('KDS-Station je Kasse: Kasse 3 schickt Speisen an die Küche, Kasse 2 (ohne Station) bleibt ohne Bon', async () => {
    expect((await srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasse3}/kds`, headers: auth(), payload: { kdsAktiv: true } })).statusCode).toBe(200)
    expect((await ausnahmen([{ kasseId: kasse3, kategorieId: speisen, station: 'kueche' }])).statusCode).toBe(204)
    const k3 = await bonieren(kasse3, schnitzel)
    expect(k3.res.statusCode, k3.res.body).toBe(200)
    expect(k3.res.json().stationen).toHaveLength(1)
    expect(k3.res.json().stationen[0].station).toBe('kueche')
    const k2 = await bonieren(kasse2, schnitzel)
    expect(k2.res.statusCode).toBe(400)
  })

  it('„keine Station" an der Kasse beendet auch die Vererbung der allgemeinen Vorgabe', async () => {
    // allgemein: Speisen → Station kueche; an Kasse 3 ausdrücklich keine Station
    expect((await srv.fastify.inject({
      method: 'PUT', url: `/api/kategorien/${speisen}`, headers: auth(), payload: { station: 'kueche' },
    })).statusCode).toBe(200)
    expect((await ausnahmen([{ kasseId: kasse3, kategorieId: speisen, station: 'keine' }])).statusCode).toBe(204)
    const k3 = await bonieren(kasse3, schnitzel)
    expect(k3.res.statusCode).toBe(400)           // weder Station noch Drucker
    // Standard wiederherstellen: wieder allgemein (Küche)
    expect((await ausnahmen([{ kasseId: kasse3, kategorieId: speisen, station: null }])).statusCode).toBe(204)
    const k3neu = await bonieren(kasse3, schnitzel)
    expect(k3neu.res.statusCode, k3neu.res.body).toBe(200)
    expect(k3neu.res.json().stationen[0].station).toBe('kueche')
  })

  it('„Standard" (null) entfernt die Ausnahme — die Zeile verschwindet ganz, wenn nichts mehr gilt', async () => {
    expect((await ausnahmen([{ kasseId: kasse2, kategorieId: getraenke, drucker: null }])).statusCode).toBe(204)
    const k2 = await bonieren(kasse2, cola)
    expect([k2.res.statusCode, k2.a, k2.b]).toEqual([200, 1, 0])
    const u = await uebersicht()
    expect(u.ausnahmen.some(x => x.kasseId === kasse2 && x.kategorieId === getraenke)).toBe(false)
  })

  it('Drucker und Station einer Zelle ändern sich unabhängig voneinander', async () => {
    await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, drucker: druckerB, station: 'schank' }])
    await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, station: null }])
    const z = (await uebersicht()).ausnahmen.find(x => x.kasseId === kasse1 && x.kategorieId === speisen)
    expect(z).toMatchObject({ bonierdruckerId: druckerB, station: null, keineStation: false })
    await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, drucker: null }])
    expect((await uebersicht()).ausnahmen.some(x => x.kasseId === kasse1 && x.kategorieId === speisen)).toBe(false)
  })

  it('Mehrere Änderungen derselben Zelle in einer Anfrage gelten der Reihe nach', async () => {
    expect((await ausnahmen([
      { kasseId: kasse1, kategorieId: speisen, drucker: 'keiner' },
      { kasseId: kasse1, kategorieId: speisen, drucker: druckerA },
    ])).statusCode).toBe(204)
    const z = (await uebersicht()).ausnahmen.find(x => x.kasseId === kasse1 && x.kategorieId === speisen)
    expect(z).toMatchObject({ bonierdruckerId: druckerA, keinDrucker: false })
    await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, drucker: null }])
  })

  describe('Eingabe-Prüfung: alles oder nichts', () => {
    it('unbekannte Kasse → 404 und nichts wird gespeichert (auch nicht die gültigen Teile)', async () => {
      const vorher = (await uebersicht()).ausnahmen.length
      const res = await ausnahmen([
        { kasseId: kasse1, kategorieId: speisen, drucker: druckerA },
        { kasseId: randomUUID(), kategorieId: speisen, drucker: druckerA },
      ])
      expect(res.statusCode).toBe(404)
      expect((await uebersicht()).ausnahmen.length).toBe(vorher)
    })

    it('unbekannte Warengruppe, Artikel oder Drucker → 404', async () => {
      expect((await ausnahmen([{ kasseId: kasse1, kategorieId: randomUUID(), drucker: druckerA }])).statusCode).toBe(404)
      expect((await ausnahmen([{ kasseId: kasse1, artikelId: randomUUID(), drucker: druckerA }])).statusCode).toBe(404)
      expect((await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, drucker: randomUUID() }])).statusCode).toBe(404)
    })

    it('ein Backup-Drucker ist kein Ziel → 400', async () => {
      // (Ein Backup-Drucker bekäme jeden Bon als Kopie — er steht deshalb nur hier, nicht in den Routing-Tests)
      const backupId = (await post('/api/bonierdrucker', { name: 'Zweit', ip: '127.0.0.1', port: 9, istBackup: true })).id
      const res = await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, drucker: backupId }])
      expect(res.statusCode).toBe(400)
      expect(res.json().fehler).toMatch(/Backup/)
      expect((await srv.fastify.inject({ method: 'DELETE', url: `/api/bonierdrucker/${backupId}`, headers: auth() })).statusCode).toBe(204)
    })

    it('Warengruppe UND Artikel zugleich, keines von beiden, nichts zu ändern, leere Liste → 400', async () => {
      expect((await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, artikelId: cola, drucker: druckerA }])).statusCode).toBe(400)
      expect((await ausnahmen([{ kasseId: kasse1, drucker: druckerA }])).statusCode).toBe(400)
      expect((await ausnahmen([{ kasseId: kasse1, kategorieId: speisen }])).statusCode).toBe(400)
      expect((await ausnahmen([])).statusCode).toBe(400)
      expect((await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, station: 'gibtsnicht' }])).statusCode).toBe(400)
    })

    it('ohne Token → 401', async () => {
      const res = await srv.fastify.inject({ method: 'PUT', url: '/api/einrichtung/ausnahmen', payload: { aenderungen: [] } })
      expect(res.statusCode).toBe(401)
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/einrichtung' })).statusCode).toBe(401)
    })

    it('ein Kellner ohne Einstellungs-Recht darf die Einrichtung nicht ändern → 403 (lesen darf er)', async () => {
      expect((await srv.fastify.inject({
        method: 'POST', url: '/api/users', headers: auth(),
        payload: { name: 'Aushilfe Toni', rolle: 'kellner', berechtigungen: ['tische'], kassenIds: [kasse1], pin: '4712' },
      })).statusCode).toBe(201)
      const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/pin-login', payload: { kasseId: kasse1, pin: '4712' } })).json()
      const kellner = { authorization: `Bearer ${login.token}` }
      const schreiben = await srv.fastify.inject({
        method: 'PUT', url: '/api/einrichtung/ausnahmen', headers: kellner,
        payload: { aenderungen: [{ kasseId: kasse1, kategorieId: speisen, drucker: druckerA }] },
      })
      expect(schreiben.statusCode).toBe(403)
      const kopieren = await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasse3}/einrichtung-kopieren`, headers: kellner, payload: { vonKasseId: kasse1 },
      })
      expect(kopieren.statusCode).toBe(403)
    })
  })

  describe('Einrichtung kopieren', () => {
    it('übernimmt Warengruppen, Drucker, KDS, Startseite und alle Ausnahmen einer Kasse', async () => {
      // Kasse 2 einrichten: Rechnungsdrucker + Belegausgabe + KDS + Startseite + sichtbare Warengruppen + Ausnahme
      const pool = (await srv.fastify.inject({
        method: 'POST', url: '/api/drucker', headers: auth(), payload: { name: 'Rechnung', ip: '127.0.0.1', port: a.port },
      })).json() as { id: string }
      expect((await srv.fastify.inject({
        method: 'PATCH', url: `/api/kassen/${kasse2}/drucker`, headers: auth(), payload: { druckerId: pool.id, belegModus: 'beides' },
      })).statusCode).toBe(200)
      expect((await srv.fastify.inject({
        method: 'PATCH', url: `/api/kassen/${kasse2}/kds`, headers: auth(), payload: { kdsAktiv: true, kdsPort: 9300 },
      })).statusCode).toBe(200)
      expect((await srv.fastify.inject({
        method: 'PUT', url: `/api/kassen/${kasse2}/pos-config`, headers: auth(),
        payload: { sichtbareKategorieIds: [getraenke], sichtbareBonierdruckerIds: [druckerB], startseite: 'kasse' },
      })).statusCode).toBe(204)
      await ausnahmen([
        { kasseId: kasse2, kategorieId: getraenke, drucker: druckerB, station: 'schank' },
        { kasseId: kasse2, artikelId: cola, drucker: 'keiner' },
      ])
      // Kasse 3 hat vorher etwas anderes (wird ersetzt)
      await ausnahmen([{ kasseId: kasse3, kategorieId: speisen, drucker: druckerA }])

      const res = await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasse3}/einrichtung-kopieren`, headers: auth(), payload: { vonKasseId: kasse2 },
      })
      expect(res.statusCode, res.body).toBe(204)

      const [k3] = await idb.db.select().from(kassen).where(eq(kassen.id, kasse3))
      expect(k3).toMatchObject({ druckerId: pool.id, belegModus: 'beides', kdsAktiv: true, kdsPort: 9300, startseite: 'kasse' })
      expect(k3!.druckerAktiv).toBe(true)                       // Snapshot-Felder mitkopiert (der Druckpfad liest nur diese)
      expect(k3!.druckerIp).toBe('127.0.0.1')

      const u = (await uebersicht())
      const e3 = (await srv.fastify.inject({ method: 'GET', url: '/api/einrichtung', headers: auth() })).json().kassen.find((k: { id: string }) => k.id === kasse3)
      expect(e3.sichtbareKategorieIds).toEqual([getraenke])
      expect(e3.sichtbareBonierdruckerIds).toEqual([druckerB])
      // Kasse 2 hat drei Ausnahmen (Getränke, Cola, dazu Radler → A aus dem Test oben): alle drei kommen an,
      // die frühere von Kasse 3 (Speisen → A, „keiner" bei Getränken …) ist ersetzt
      const ausn3 = u.ausnahmen.filter(x => x.kasseId === kasse3)
      expect(ausn3).toHaveLength(3)
      expect(ausn3).toEqual(expect.arrayContaining([
        expect.objectContaining({ kategorieId: getraenke, bonierdruckerId: druckerB, station: 'schank', keinDrucker: false }),
        expect.objectContaining({ artikelId: cola, keinDrucker: true }),
        expect.objectContaining({ artikelId: radler, bonierdruckerId: druckerA }),
      ]))
      expect(ausn3.some(x => x.kategorieId === speisen)).toBe(false)
      // die Quelle bleibt unverändert
      expect(u.ausnahmen.filter(x => x.kasseId === kasse2)).toHaveLength(3)
    })

    it('dieselbe Kasse → 400, unbekannte Kasse → 404, außer Betrieb → 409', async () => {
      expect((await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasse3}/einrichtung-kopieren`, headers: auth(), payload: { vonKasseId: kasse3 },
      })).statusCode).toBe(400)
      expect((await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasse3}/einrichtung-kopieren`, headers: auth(), payload: { vonKasseId: randomUUID() },
      })).statusCode).toBe(404)
      await idb.db.update(kassen).set({ status: 'ausser_betrieb' }).where(eq(kassen.id, kasse3))
      expect((await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasse3}/einrichtung-kopieren`, headers: auth(), payload: { vonKasseId: kasse1 },
      })).statusCode).toBe(409)
      await idb.db.update(kassen).set({ status: 'aktiv' }).where(eq(kassen.id, kasse3))
    })
  })

  describe('Mandanten-Isolation', () => {
    it('ein zweiter Mandant sieht keine Kassen, Ausnahmen oder Ziele des ersten und kann sie nicht ändern', async () => {
      const setup2 = await srv.fastify.inject({
        method: 'POST', url: '/api/setup',
        payload: {
          firmenname: 'Fremd GmbH', uid: 'ATU99999972', kassenId: 'FR-001',
          finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
          admin: { name: 'Fremd Admin', email: 'admin@fremd-routing.at', passwort: 'fremd-routing-passwort-123' },
        },
      })
      expect(setup2.statusCode, setup2.body).toBe(201)
      const login2 = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: 'admin@fremd-routing.at', passwort: 'fremd-routing-passwort-123' },
      })).json()
      const fremd = { authorization: `Bearer ${login2.token}` }

      const sicht = (await srv.fastify.inject({ method: 'GET', url: '/api/einrichtung', headers: fremd })).json()
      expect(sicht.kassen.map((k: { kassenId: string }) => k.kassenId)).toEqual(['FR-001'])
      expect(sicht.ausnahmen).toEqual([])

      // fremde Kasse / Warengruppe / Artikel / Drucker → 404 (Existenz bleibt unerkennbar)
      const eigeneKasse = login2.kassen[0].id
      for (const aenderung of [
        { kasseId: kasse1,       kategorieId: speisen, drucker: null },
        { kasseId: eigeneKasse,  kategorieId: speisen, drucker: null },
        { kasseId: eigeneKasse,  artikelId: cola,      drucker: null },
        { kasseId: eigeneKasse,  kategorieId: randomUUID(), drucker: druckerA },
      ]) {
        const res = await srv.fastify.inject({
          method: 'PUT', url: '/api/einrichtung/ausnahmen', headers: fremd, payload: { aenderungen: [aenderung] },
        })
        expect(res.statusCode, JSON.stringify(aenderung)).toBe(404)
      }
      expect((await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${eigeneKasse}/einrichtung-kopieren`, headers: fremd, payload: { vonKasseId: kasse1 },
      })).statusCode).toBe(404)
      expect((await srv.fastify.inject({
        method: 'POST', url: `/api/kassen/${kasse1}/einrichtung-kopieren`, headers: fremd, payload: { vonKasseId: eigeneKasse },
      })).statusCode).toBe(404)
    })
  })

  it('Wird ein Bonierdrucker gelöscht, fällt die Zuordnung auf ihn auf „keine Angabe" zurück', async () => {
    await ausnahmen([{ kasseId: kasse1, kategorieId: speisen, drucker: druckerA }])
    expect((await idb.db.select().from(kasseRouting).where(eq(kasseRouting.kasseId, kasse1))).length).toBeGreaterThan(0)
    // Bonierdrucker löschen: Zuordnungen auf ihn fallen auf „keine Angabe" zurück (Zeile bleibt, Drucker leer)
    expect((await srv.fastify.inject({ method: 'DELETE', url: `/api/bonierdrucker/${druckerA}`, headers: auth() })).statusCode).toBe(204)
    const z = (await idb.db.select().from(kasseRouting).where(eq(kasseRouting.kasseId, kasse1))).find(r => r.kategorieId === speisen)
    expect(z?.bonierdruckerId ?? null).toBeNull()
  })
})
