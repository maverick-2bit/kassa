/**
 * Integrationstest: Ausgabe-Wege für Inventur und Wareneingang (Wunschliste 7).
 *
 * Ein Fake-Bondrucker (net.createServer) empfängt die ESC/POS-Bytes. Geprüft:
 * Inventur-Bon (nur Abweichungen) über den Kassen-Bondrucker UND über einen
 * gezielt gewählten Bibliotheks-Drucker; Wareneingangs-Bon; Guards (fremde
 * Kasse 404, unbekannter Drucker 404, deaktivierter Drucker 409) und der
 * E-Mail-Weg ohne SMTP-Konfiguration (409 statt stiller Fehlschlag).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { desc, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel, drucker, druckLog, kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@dokument-ausgabe.at'
const ADMIN_PASSWORT = 'dokument-ausgabe-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'DA-PW' }),
  } as unknown as FinanzOnlineClient
}

describe('Dokument-Ausgabe Inventur + Wareneingang (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string
  let bibliotheksDruckerId: string
  let inaktiverDruckerId: string
  let fakeDrucker: net.Server
  let empfangen: Buffer[] = []

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Ausgabe GmbH',
        uid:        'ATU99999910',
        kassenId:   'DA-001',
        finanzOnline: { teilnehmerId: 'TID-DA', benutzerkennung: 'BID-DA', pin: 'PIN-DA' },
        umgebung: 'test',
        admin: { name: 'DA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    kasseId   = login.kassen[0].id
    mandantId = login.mandant.id

    fakeDrucker = net.createServer((sock) => { sock.on('data', (c) => empfangen.push(c)) })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    const port = (fakeDrucker.address() as net.AddressInfo).port

    // Kassen-Bondrucker + zwei Bibliotheks-Drucker (einer deaktiviert)
    await idb.db.update(kassen)
      .set({ druckerAktiv: true, druckerIp: '127.0.0.1', druckerPort: port, druckerBreiteZeichen: 42 })
      .where(eq(kassen.id, kasseId))

    const [d1] = await idb.db.insert(drucker).values({
      mandantId, name: 'Büro-Bon', ip: '127.0.0.1', port,
    }).returning()
    bibliotheksDruckerId = d1!.id

    const [d2] = await idb.db.insert(drucker).values({
      mandantId, name: 'Kaputt', ip: '127.0.0.1', port, aktiv: false,
    }).returning()
    inaktiverDruckerId = d2!.id

    // Lagerartikel mit Bestand → erscheint in der Inventur
    await idb.db.insert(artikel).values({
      mandantId, bezeichnung: 'Bier vom Fass', preisBruttoCent: 450,
      mwstSatz: 'normal', lagerstandAktiv: true, lagerstandMenge: 40,
    })
  })

  afterAll(async () => {
    await new Promise<void>((res) => fakeDrucker.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  async function inventurMitAbweichung(): Promise<string> {
    const inv = (await srv.fastify.inject({
      method: 'POST', url: '/api/inventuren', headers: auth(), payload: {},
    })).json()
    const detail = (await srv.fastify.inject({
      method: 'GET', url: `/api/inventuren/${inv.id}`, headers: auth(),
    })).json()
    const bier = detail.positionen.find((p: { bezeichnung: string }) => p.bezeichnung === 'Bier vom Fass')
    await srv.fastify.inject({
      method: 'PATCH', url: `/api/inventuren/${inv.id}/zaehlung`, headers: auth(),
      payload: { positionen: [{ artikelId: bier.artikelId, istMenge: 37 }] },
    })
    return inv.id
  }

  it('Inventur-Bon auf den Kassen-Bondrucker: nur Abweichungen, mit Zählstand', async () => {
    const invId = await inventurMitAbweichung()
    empfangen = []

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/inventuren/${invId}/drucken`, headers: auth(),
      payload: { kasseId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ erfolgreich: true })

    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const text = Buffer.concat(empfangen).toString('latin1')
    expect(text).toContain('INVENTUR')
    expect(text).toContain('(Zwischenstand)')          // Inventur ist noch offen
    expect(text).toContain('Bier vom Fass')
    expect(text).toContain('Soll 40')
    expect(text).toContain('Ist 37')
    expect(text).toContain('-3')
    // Schnitt am Ende (GS V)
    expect(Buffer.concat(empfangen).includes(Buffer.from([0x1d, 0x56]))).toBe(true)
  })

  it('Inventur-Bon gezielt auf einen Bibliotheks-Drucker', async () => {
    const invId = await inventurMitAbweichung()
    empfangen = []

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/inventuren/${invId}/drucken`, headers: auth(),
      payload: { kasseId, druckerId: bibliotheksDruckerId },
    })
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    expect(Buffer.concat(empfangen).toString('latin1')).toContain('INVENTUR')
  })

  it('Wareneingangs-Bon mit Lieferant und Positionen', async () => {
    empfangen = []
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/lagerstand/wareneingang-ausgabe', headers: auth(),
      payload: {
        kasseId,
        lieferant: 'Getränke Müller',
        positionen: [
          { bezeichnung: 'Bier vom Fass', menge: 24 },
          { bezeichnung: 'Almdudler',     menge: 12 },
        ],
      },
    })
    expect(res.statusCode).toBe(200)

    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const text = Buffer.concat(empfangen).toString('latin1')
    expect(text).toContain('WARENEINGANG')
    expect(text).toContain('Getr')            // „Getränke Müller" (CP858-kodiert)
    expect(text).toContain('Bier vom Fass')
    expect(text).toContain('+24')
    expect(text).toContain('+12')

    // Drucker-Log führt die Ausgabe mit eigenem Typ (Einstellungen → Drucker-Log)
    const [log] = await idb.db.select().from(druckLog)
      .orderBy(desc(druckLog.erstelltAt)).limit(1)
    expect(log).toMatchObject({ druckerTyp: 'wareneingang', erfolg: true })
  })

  it('Guards: fremde Kasse 404, unbekannter Drucker 404, deaktivierter Drucker 409', async () => {
    const invId = await inventurMitAbweichung()

    const fremdeKasse = await srv.fastify.inject({
      method: 'POST', url: `/api/inventuren/${invId}/drucken`, headers: auth(),
      payload: { kasseId: '00000000-0000-4000-8000-000000000000' },
    })
    expect(fremdeKasse.statusCode).toBe(404)

    const unbekannt = await srv.fastify.inject({
      method: 'POST', url: `/api/inventuren/${invId}/drucken`, headers: auth(),
      payload: { kasseId, druckerId: '00000000-0000-4000-8000-000000000001' },
    })
    expect(unbekannt.statusCode).toBe(404)

    const deaktiviert = await srv.fastify.inject({
      method: 'POST', url: `/api/inventuren/${invId}/drucken`, headers: auth(),
      payload: { kasseId, druckerId: inaktiverDruckerId },
    })
    expect(deaktiviert.statusCode).toBe(409)
  })

  it('E-Mail-Weg ohne SMTP-Konfiguration meldet 409 (statt stiller Fehlschlag)', async () => {
    const invId = await inventurMitAbweichung()
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/inventuren/${invId}/email`, headers: auth(),
      payload: { empfaenger: 'chef@betrieb.at' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().fehler).toContain('SMTP')

    const we = await srv.fastify.inject({
      method: 'POST', url: '/api/lagerstand/wareneingang-email', headers: auth(),
      payload: { empfaenger: 'chef@betrieb.at', positionen: [{ bezeichnung: 'Bier', menge: 1 }] },
    })
    expect(we.statusCode).toBe(409)
  })
})
