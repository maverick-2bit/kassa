/**
 * Integrationstest: Drucker-Keep-Alive (Ping-Logik + Intervall-Steuerung + Route).
 *
 * Ein Fake-ESC/POS-Drucker (net.createServer auf 127.0.0.1) beantwortet die
 * DLE-EOT-Statusabfrage mit einem Status-Byte. Geprüft werden: Online-Erkennung,
 * Nicht-erreichbar-Erkennung, Intervall-Drosselung + force, Intervall 0 = aus,
 * sowie der Monitoring-Endpoint samt PATCH/Prüf-Route.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { bonierdrucker, drucker, mandanten } from '../../src/db/schema.js'
import { eq } from 'drizzle-orm'
import {
  pingeDrucker,
  fuehreKeepAliveDurch,
  holeDruckerKeepAliveStatus,
  _resetKeepAliveState,
} from '../../src/services/drucker-keepalive.service.js'

const ADMIN_EMAIL    = 'admin@keepalive.at'
const ADMIN_PASSWORT = 'keepalive-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KA-PW' }),
  } as unknown as FinanzOnlineClient
}

describe('Drucker-Keep-Alive (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let mandantId: string
  let fakeDrucker: net.Server
  let fakePort: number
  let empfangen: Buffer[] = []

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'KeepAlive GmbH',
        uid:        'ATU99999907',
        kassenId:   'KA-001',
        finanzOnline: { teilnehmerId: 'TID-KA', benutzerkennung: 'BID-KA', pin: 'PIN-KA' },
        umgebung: 'test',
        admin: { name: 'KA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    mandantId = login.mandant.id

    // Fake-ESC/POS-Drucker: beantwortet DLE EOT n mit einem Status-Byte
    fakeDrucker = net.createServer((sock) => {
      sock.on('data', (chunk) => {
        empfangen.push(chunk)
        if (chunk[0] === 0x10 && chunk[1] === 0x04) sock.write(Buffer.from([0x16]))
      })
    })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    fakePort = (fakeDrucker.address() as net.AddressInfo).port

    // Beleg-Drucker (erreichbar) + Bonierdrucker (toter Port) anlegen
    await idb.db.insert(drucker).values({
      mandantId, name: 'Theken-Bondrucker', ip: '127.0.0.1', port: fakePort,
    })
    await idb.db.insert(bonierdrucker).values({
      mandantId, name: 'Küchendrucker (aus)', ip: '127.0.0.1', port: 1,
    })
  })

  afterAll(async () => {
    _resetKeepAliveState()
    await new Promise<void>((res) => fakeDrucker.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('pingeDrucker: erkennt Online-Drucker (DLE-EOT-Antwort) und misst die Dauer', async () => {
    const status = await pingeDrucker('127.0.0.1', fakePort)
    expect(status.ok).toBe(true)
    expect(status.statusByte).toBe(true)
    expect(status.fehler).toBeNull()
    expect(status.dauerMs).toBeGreaterThanOrEqual(0)
    // Der Fake-Drucker hat wirklich die Statusabfrage (kein Druck-Payload) bekommen
    expect(empfangen.some(b => b[0] === 0x10 && b[1] === 0x04 && b[2] === 0x01)).toBe(true)
  })

  it('pingeDrucker: toter Port → nicht erreichbar mit Fehlertext', async () => {
    const status = await pingeDrucker('127.0.0.1', 1, 1200)
    expect(status.ok).toBe(false)
    expect(status.statusByte).toBe(false)
    expect(status.fehler).toBeTruthy()
  })

  it('fuehreKeepAliveDurch: pingt beide Drucker, dedupliziert und cached den Status', async () => {
    _resetKeepAliveState()
    const t0 = Date.now()
    const ergebnis = await fuehreKeepAliveDurch(idb.db, t0)
    const stati = ergebnis.get(mandantId)!
    expect(stati).toHaveLength(2)

    const online  = stati.find(s => s.port === fakePort)!
    const offline = stati.find(s => s.port === 1)!
    expect(online).toMatchObject({ ok: true, statusByte: true, quelle: 'beleg', name: 'Theken-Bondrucker' })
    expect(offline.ok).toBe(false)

    // Cache liefert dasselbe (sortiert nach Name)
    const cache = holeDruckerKeepAliveStatus(mandantId)
    expect(cache).toHaveLength(2)

    // Innerhalb des Intervalls (Default 60 s) läuft NICHTS erneut
    const zweiter = await fuehreKeepAliveDurch(idb.db, t0 + 5_000)
    expect(zweiter.has(mandantId)).toBe(false)

    // Nach Ablauf des Intervalls läuft es wieder
    const dritter = await fuehreKeepAliveDurch(idb.db, t0 + 61_000)
    expect(dritter.get(mandantId)).toHaveLength(2)
  })

  it('Intervall 0 schaltet ab und leert den Cache; force pingt trotzdem', async () => {
    await idb.db.update(mandanten)
      .set({ druckerKeepAliveSekunden: 0 })
      .where(eq(mandanten.id, mandantId))

    const aus = await fuehreKeepAliveDurch(idb.db, Date.now())
    expect(aus.has(mandantId)).toBe(false)
    expect(holeDruckerKeepAliveStatus(mandantId)).toHaveLength(0)

    const forced = await fuehreKeepAliveDurch(idb.db, Date.now(), { nurMandantId: mandantId, force: true })
    expect(forced.get(mandantId)).toHaveLength(2)
  })

  it('Monitoring-Route liefert Keep-Alive-Status; PATCH ändert das Intervall', async () => {
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: '/api/admin/monitoring/keep-alive', headers: auth(),
      payload: { intervallSekunden: 120 },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toEqual({ intervallSekunden: 120 })

    const mon = await srv.fastify.inject({ method: 'GET', url: '/api/admin/monitoring', headers: auth() })
    expect(mon.statusCode).toBe(200)
    const ka = mon.json().druckerKeepAlive
    expect(ka.intervallSekunden).toBe(120)
    expect(ka.drucker.length).toBe(2)

    const pruefen = await srv.fastify.inject({
      method: 'POST', url: '/api/admin/monitoring/keep-alive/pruefen', headers: auth(),
    })
    expect(pruefen.statusCode).toBe(200)
    expect(pruefen.json().drucker).toHaveLength(2)

    const invalid = await srv.fastify.inject({
      method: 'PATCH', url: '/api/admin/monitoring/keep-alive', headers: auth(),
      payload: { intervallSekunden: -5 },
    })
    expect(invalid.statusCode).toBe(400)

    // Obergrenze 600 s (10 min) — längere Pausen ließen Drucker wieder einschlafen
    const zuLang = await srv.fastify.inject({
      method: 'PATCH', url: '/api/admin/monitoring/keep-alive', headers: auth(),
      payload: { intervallSekunden: 601 },
    })
    expect(zuLang.statusCode).toBe(400)

    const maxOk = await srv.fastify.inject({
      method: 'PATCH', url: '/api/admin/monitoring/keep-alive', headers: auth(),
      payload: { intervallSekunden: 600 },
    })
    expect(maxOk.statusCode).toBe(200)
  })
})
