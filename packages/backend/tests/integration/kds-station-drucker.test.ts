/**
 * Integrationstest: Papierdruck der KDS-Bons je Station auf einen gewählten Bonierdrucker.
 *
 * Vorher druckten Erledigt-Bon, Teilbon und Nachdrucken IMMER an alle aktiven Nicht-Backup-
 * Bonierdrucker — hat ein Betrieb Bon-, Rechnungs- und Küchendrucker angelegt, kam der KDS-
 * Bon auch dort an, wo er nichts zu suchen hat. Jetzt: Station → Drucker (KDS-Zuordnung).
 * Echte TCP-Listener stehen für die Drucker.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kdsBons } from '../../src/db/schema.js'

const ADMIN_EMAIL = 'admin@kds-drucker.at', ADMIN_PASSWORT = 'kds-drucker-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KD-PW' }),
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

describe('KDS-Papierdruck je Station (Integration, echtes PostgreSQL + TCP-Listener)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = '', bonId = ''
  let a: Awaited<ReturnType<typeof druckerAttrappe>>, b: Awaited<ReturnType<typeof druckerAttrappe>>
  let druckerA = '', druckerB = '', backupId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = async (url: string, payload: unknown) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  const nachdrucken = async () => {
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/kds/bon/${bonId}/nachdrucken`, headers: auth() })
    expect(res.statusCode).toBe(200)
    await kurzWarten()
    return res.json() as { gedruckt: number; fehler: number }
  }
  const zuordnen = (station: string, bonierdruckerId: string | null) =>
    srv.fastify.inject({ method: 'PUT', url: '/api/kds/station-drucker', headers: auth(), payload: { station, bonierdruckerId } })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    a = await druckerAttrappe()
    b = await druckerAttrappe()

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'KdsDrucker GmbH', uid: 'ATU99999963', kassenId: 'KD-001',
        finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
        admin: { name: 'KD Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    druckerA = (await post('/api/bonierdrucker', { name: 'Bondrucker',  ip: '127.0.0.1', port: a.port })).id
    druckerB = (await post('/api/bonierdrucker', { name: 'Küche .202',  ip: '127.0.0.1', port: b.port })).id
    backupId = (await post('/api/bonierdrucker', { name: 'Zweitdrucker', ip: '127.0.0.1', port: 9, istBackup: true })).id

    // KDS aktiv (Browser-KDS, keine IP), Station schank → ein KDS-Bon entsteht
    expect((await srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasseId}/kds`, headers: auth(), payload: { kdsAktiv: true } })).statusCode).toBe(200)
    const kat = (await post('/api/kategorien', { name: 'Getränke', farbe: 'blau', reihenfolge: 0, station: 'schank' })).id
    const cola = (await post('/api/artikel', { bezeichnung: 'Cola', preisBruttoCent: 400, mwstSatz: 'normal', kategorieId: kat })).id
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
      payload: { kasseId, tisch: 'T1', kellner: 'Anna', positionen: [{ artikelId: cola, menge: 1 }] },
    })
    expect(res.statusCode, res.body).toBe(200)
    const [bon] = await idb.db.select().from(kdsBons)
    bonId = bon!.id
  })

  afterAll(async () => {
    a?.server.close(); b?.server.close()
    await srv?.close(); await idb?.zerstoeren()
  })

  it('ohne Zuordnung: wie bisher an ALLE aktiven Nicht-Backup-Drucker', async () => {
    const r = await nachdrucken()
    expect(r.gedruckt).toBe(2)
    expect(a.empfangen()).toBe(1)
    expect(b.empfangen()).toBe(1)
  })

  it('Station → Drucker: es druckt NUR der gewählte (hier der Küchendrucker)', async () => {
    expect((await zuordnen('schank', druckerB)).statusCode).toBe(204)
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/kds/station-drucker', headers: auth() })).json()
    expect(liste.eintraege).toEqual([{ station: 'schank', bonierdruckerId: druckerB }])

    const r = await nachdrucken()
    expect(r.gedruckt).toBe(1)
    expect(a.empfangen()).toBe(1)          // unverändert
    expect(b.empfangen()).toBe(2)
  })

  it('Zuordnung ändern ersetzt sie (kein Anhängen)', async () => {
    expect((await zuordnen('schank', druckerA)).statusCode).toBe(204)
    const r = await nachdrucken()
    expect(r.gedruckt).toBe(1)
    expect(a.empfangen()).toBe(2)
    expect(b.empfangen()).toBe(2)
  })

  it('unbekannter Drucker → 404, Zweitdrucker (Backup) → 400, ungültige Station → 400', async () => {
    expect((await zuordnen('schank', '00000000-0000-4000-8000-000000000001')).statusCode).toBe(404)
    expect((await zuordnen('schank', backupId)).statusCode).toBe(400)
    expect((await zuordnen('gibtesnicht', druckerA)).statusCode).toBe(400)
  })

  it('zugeordneter Drucker deaktiviert → es wird nirgends gedruckt (kein Ausweichen auf andere Geräte)', async () => {
    const aus = await srv.fastify.inject({ method: 'PATCH', url: `/api/bonierdrucker/${druckerA}`, headers: auth(), payload: { aktiv: false } })
    expect(aus.statusCode).toBe(200)
    const r = await nachdrucken()
    expect(r.gedruckt).toBe(0)
    expect(a.empfangen()).toBe(2)
    expect(b.empfangen()).toBe(2)
  })

  it('Zuordnung aufheben (null): wieder alle aktiven (jetzt nur noch der Küchendrucker)', async () => {
    expect((await zuordnen('schank', null)).statusCode).toBe(204)
    const r = await nachdrucken()
    expect(r.gedruckt).toBe(1)
    expect(b.empfangen()).toBe(3)
  })

  describe('fester Fallback-Drucker', () => {
    let defekt = ''
    const fallback = (bonierdruckerId: string | null) =>
      srv.fastify.inject({ method: 'PUT', url: '/api/kds/fallback-drucker', headers: auth(), payload: { bonierdruckerId } })

    beforeAll(async () => {
      // Drucker, der nicht erreichbar ist (Port 1 → sofort "Connection refused")
      defekt = (await post('/api/bonierdrucker', { name: 'Defekt', ip: '127.0.0.1', port: 1 })).id
      // Der Zweitdrucker (Backup) soll die Fälle unten nicht verfälschen
      expect((await srv.fastify.inject({ method: 'PATCH', url: `/api/bonierdrucker/${backupId}`, headers: auth(), payload: { aktiv: false } })).statusCode).toBe(200)
    })

    it('GET liefert den Stand; unbekannter Drucker → 404; null hebt auf', async () => {
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/kds/fallback-drucker', headers: auth() })).json())
        .toEqual({ bonierdruckerId: null })
      expect((await fallback('00000000-0000-4000-8000-000000000001')).statusCode).toBe(404)
      expect((await fallback(druckerB)).statusCode).toBe(204)
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/kds/fallback-drucker', headers: auth() })).json())
        .toEqual({ bonierdruckerId: druckerB })
      expect((await fallback(null)).statusCode).toBe(204)
    })

    it('KDS-Druck: ohne Fallback geht der Bon verloren, mit Fallback übernimmt der Fallback-Drucker', async () => {
      expect((await zuordnen('schank', defekt)).statusCode).toBe(204)

      const ohne = await nachdrucken()
      expect(ohne).toEqual({ gedruckt: 0, fehler: 1 })

      expect((await fallback(druckerB)).statusCode).toBe(204)
      const vorher = b.empfangen()
      const mit = await nachdrucken()
      expect(mit).toEqual({ gedruckt: 1, fehler: 0 })
      expect(b.empfangen()).toBe(vorher + 1)
    })

    it('Bonieren (Artikel ohne KDS-Station): scheitert der Bonierdrucker, geht der Bon an den Fallback — als zugestellt gemeldet', async () => {
      const kat = (await post('/api/kategorien', { name: 'Direkt', farbe: 'blau', reihenfolge: 5, bonierdruckerId: defekt })).id
      const art = (await post('/api/artikel', { bezeichnung: 'Direktartikel', preisBruttoCent: 300, mwstSatz: 'normal', kategorieId: kat })).id
      const vorher = b.empfangen()

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
        payload: { kasseId, tisch: 'T2', kellner: 'Anna', positionen: [{ artikelId: art, menge: 1 }] },
      })
      await kurzWarten()
      expect(res.statusCode, res.body).toBe(200)           // zugestellt → kein "Bon NICHT angekommen"
      const d = res.json().drucker[0]
      expect(d).toMatchObject({ erfolgreich: true })
      expect(d.name).toContain('→')
      expect(d.fehler).toMatch(/umgeleitet/)
      expect(b.empfangen()).toBe(vorher + 1)
    })

    it('ohne festen Fallback bleibt es beim Fehler (207, Bon NICHT angekommen)', async () => {
      expect((await fallback(null)).statusCode).toBe(204)
      const kat = (await post('/api/kategorien', { name: 'Direkt2', farbe: 'blau', reihenfolge: 6, bonierdruckerId: defekt })).id
      const art = (await post('/api/artikel', { bezeichnung: 'Direktartikel2', preisBruttoCent: 300, mwstSatz: 'normal', kategorieId: kat })).id
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
        payload: { kasseId, tisch: 'T3', kellner: 'Anna', positionen: [{ artikelId: art, menge: 1 }] },
      })
      expect(res.statusCode, res.body).toBe(207)
      expect(res.json().drucker[0]).toMatchObject({ erfolgreich: false })
    })
  })
})
