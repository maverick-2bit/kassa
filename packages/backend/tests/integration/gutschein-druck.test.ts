/**
 * Integrationstest: Gutschein-Druck am Bondrucker (ESC/POS via TCP).
 *
 * Ein Fake-Drucker (net.createServer) empfängt die Bytes. Geprüft: kompletter
 * Pfad Route → Layout → TCP-Versand (Bytes enthalten Code + GUTSCHEIN + Schnitt),
 * Restwert-Zeile bei Teileinlösung, druckLog-Eintrag, 404 fremder Gutschein,
 * 409 ohne konfigurierten Drucker.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { desc, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { druckLog, kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@gutschein-druck.at'
const ADMIN_PASSWORT = 'gutschein-druck-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'GD-PW' }),
  } as unknown as FinanzOnlineClient
}

describe('Gutschein-Druck am Bondrucker (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
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
        firmenname: 'Gutschein-Druck GmbH',
        uid:        'ATU99999908',
        kassenId:   'GD-001',
        finanzOnline: { teilnehmerId: 'TID-GD', benutzerkennung: 'BID-GD', pin: 'PIN-GD' },
        umgebung: 'test',
        admin: { name: 'GD Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    fakeDrucker = net.createServer((sock) => {
      sock.on('data', (chunk) => empfangen.push(chunk))
    })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    fakePort = (fakeDrucker.address() as net.AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((res) => fakeDrucker.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  async function erstelleGs(betragCent: number): Promise<{ id: string; code: string }> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine', headers: auth(),
      payload: { betragCent },
    })
    expect(res.statusCode).toBe(201)
    return res.json()
  }

  it('ohne konfigurierten Kassen-Bondrucker → 409', async () => {
    const gs = await erstelleGs(5000)
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${gs.id}/drucken`, headers: auth(),
      payload: { kasseId },
    })
    expect(res.statusCode).toBe(409)
  })

  it('druckt den Gutschein: Bytes enthalten GUTSCHEIN + Code + Schnitt; druckLog ok', async () => {
    // Kassen-Bondrucker auf den Fake-Drucker zeigen lassen (Digital-Modus darf
    // den Gutschein-Druck NICHT blockieren — ignoreBelegModus wie bei Etiketten)
    await idb.db.update(kassen)
      .set({ druckerAktiv: true, druckerIp: '127.0.0.1', druckerPort: fakePort, belegModus: 'digital' })
      .where(eq(kassen.id, kasseId))

    const gs = await erstelleGs(5000)
    empfangen = []
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${gs.id}/drucken`, headers: auth(),
      payload: { kasseId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ erfolgreich: true })

    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const bytes = Buffer.concat(empfangen)
    const text  = bytes.toString('latin1')
    expect(text).toContain('GUTSCHEIN')
    expect(text).toContain(gs.code)
    expect(text).toContain('50,00 EUR')
    expect(text).toContain('Zum Einloesen scannen')
    // Schnitt-Befehl am Ende (GS V)
    expect(bytes.includes(Buffer.from([0x1d, 0x56]))).toBe(true)

    const [log] = await idb.db.select().from(druckLog).orderBy(desc(druckLog.erstelltAt)).limit(1)
    expect(log).toMatchObject({ druckerTyp: 'gutschein', erfolg: true })
  })

  it('teileingelöster Gutschein druckt die Restwert-Zeile', async () => {
    const gs = await erstelleGs(10000)
    const einloesen = await srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${gs.id}/einloesen`, headers: auth(),
      payload: { einloesungCent: 7450 },
    })
    expect(einloesen.statusCode).toBe(200)

    empfangen = []
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${gs.id}/drucken`, headers: auth(),
      payload: { kasseId },
    })
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const text = Buffer.concat(empfangen).toString('latin1')
    expect(text).toContain('Restwert: 25,50 EUR')
  })

  it('fremder/unbekannter Gutschein → 404', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine/00000000-0000-4000-8000-000000000000/drucken', headers: auth(),
      payload: { kasseId },
    })
    expect(res.statusCode).toBe(404)
  })
})
