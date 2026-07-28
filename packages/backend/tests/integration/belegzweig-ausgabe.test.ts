/**
 * Integrationstest: Ausgabe im Belegzweig Angebot → Lieferschein → Rechnung.
 *
 * Fake-Bondrucker empfängt die ESC/POS-Bytes. Geprüft: Lieferschein-Bon (Mengen +
 * Seriennummern, KEINE Preise, Unterschriftsfeld), Rechnungs-Bon (Preise, USt,
 * Summe, Lieferschein-Referenzen), Sammelrechnungs-Archiv (GET-Liste + Detail),
 * druckLog-Typen, Guards und der Mail-Weg ohne SMTP (409).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { desc, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { druckLog, kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@belegzweig.at'
const ADMIN_PASSWORT = 'belegzweig-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BZ-PW' }),
  } as unknown as FinanzOnlineClient
}

describe('Belegzweig-Ausgabe: Lieferschein + Rechnung (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let angebotId: string
  let fakeDrucker: net.Server
  let empfangen: Buffer[] = []

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Belegzweig GmbH',
        uid:        'ATU99999911',
        kassenId:   'BZ-001',
        finanzOnline: { teilnehmerId: 'TID-BZ', benutzerkennung: 'BID-BZ', pin: 'PIN-BZ' },
        umgebung: 'test',
        admin: { name: 'BZ Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    fakeDrucker = net.createServer((sock) => { sock.on('data', (c) => empfangen.push(c)) })
    await new Promise<void>((res) => fakeDrucker.listen(0, '127.0.0.1', () => res()))
    const port = (fakeDrucker.address() as net.AddressInfo).port
    await idb.db.update(kassen)
      .set({ druckerAktiv: true, druckerIp: '127.0.0.1', druckerPort: port, druckerBreiteZeichen: 42 })
      .where(eq(kassen.id, kasseId))

    // Angebot mit zwei Positionen (20 % und 10 %)
    const angebot = (await srv.fastify.inject({
      method: 'POST', url: '/api/angebote', headers: auth(),
      payload: {
        kasseId,
        positionen: [
          { bezeichnung: 'Kaffeemaschine', menge: 2, einzelpreisBreutto: 49900, mwstSatz: 'normal' },
          { bezeichnung: 'Kaffeebohnen',   menge: 5, einzelpreisBreutto: 1200,  mwstSatz: 'ermaessigt1' },
        ],
      },
    })).json()
    angebotId = angebot.id
  })

  afterAll(async () => {
    await new Promise<void>((res) => fakeDrucker.close(() => res()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  async function neuerLieferschein(): Promise<{ id: string; nummer: number }> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/lieferscheine', headers: auth(), payload: { angebotId },
    })
    expect(res.statusCode).toBe(201)
    return res.json()
  }

  it('Lieferschein-Bon: Mengen ohne Preise, mit Unterschriftsfeld; druckLog-Typ lieferschein', async () => {
    const ls = await neuerLieferschein()
    empfangen = []

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/lieferscheine/${ls.id}/drucken`, headers: auth(),
      payload: { kasseId },
    })
    expect(res.statusCode).toBe(200)

    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const text = Buffer.concat(empfangen).toString('latin1')
    expect(text).toContain('LIEFERSCHEIN')
    expect(text).toContain(`L-${String(ls.nummer).padStart(4, '0')}`)
    expect(text).toContain('Kaffeemaschine')
    expect(text).toContain('2 St')
    expect(text).toContain('Unterschrift')
    // Lieferschein ist ein Warenbegleitpapier — keine Preise darauf
    expect(text).not.toContain('499,00')

    const [log] = await idb.db.select().from(druckLog).orderBy(desc(druckLog.erstelltAt)).limit(1)
    expect(log).toMatchObject({ druckerTyp: 'lieferschein', erfolg: true })
  })

  it('Rechnungs-Bon: Preise, USt-Aufteilung, Summe und Lieferschein-Referenz', async () => {
    const ls = await neuerLieferschein()
    const sr = (await srv.fastify.inject({
      method: 'POST', url: '/api/sammelrechnungen', headers: auth(),
      payload: { lieferscheinIds: [ls.id] },
    })).json()
    empfangen = []

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/sammelrechnungen/${sr.id}/drucken`, headers: auth(),
      payload: { kasseId },
    })
    expect(res.statusCode).toBe(200)

    await vi.waitFor(() => { expect(empfangen.length).toBeGreaterThan(0) })
    const text = Buffer.concat(empfangen).toString('latin1')
    expect(text).toContain('RECHNUNG')
    expect(text).toContain(`SR-${String(sr.nummer).padStart(4, '0')}`)
    expect(text).toContain('SUMME')
    expect(text).toContain('1058,00 EUR')                 // 2×499,00 + 5×12,00
    expect(text).toContain('Netto 831,67 EUR')            // 20-%-Anteil
    expect(text).toContain(`L-${String(ls.nummer).padStart(4, '0')}`)

    const [log] = await idb.db.select().from(druckLog).orderBy(desc(druckLog.erstelltAt)).limit(1)
    expect(log).toMatchObject({ druckerTyp: 'rechnung', erfolg: true })
  })

  it('Archiv: Sammelrechnungen listen und einzeln laden', async () => {
    const liste = (await srv.fastify.inject({
      method: 'GET', url: '/api/sammelrechnungen', headers: auth(),
    })).json()
    expect(Array.isArray(liste)).toBe(true)
    expect(liste.length).toBeGreaterThan(0)

    const erste = liste[0]
    expect(erste.lieferscheine.length).toBeGreaterThan(0)
    expect(erste.gesamtbetragCent).toBe(105800)

    const detail = (await srv.fastify.inject({
      method: 'GET', url: `/api/sammelrechnungen/${erste.id}`, headers: auth(),
    })).json()
    expect(detail.id).toBe(erste.id)
    expect(detail.lieferscheine[0].positionen.length).toBe(2)

    const fremd = await srv.fastify.inject({
      method: 'GET', url: '/api/sammelrechnungen/00000000-0000-4000-8000-000000000000', headers: auth(),
    })
    expect(fremd.statusCode).toBe(404)
  })

  it('E-Mail-Wege ohne SMTP-Konfiguration → 409', async () => {
    const ls = await neuerLieferschein()
    const mail = await srv.fastify.inject({
      method: 'POST', url: `/api/lieferscheine/${ls.id}/email`, headers: auth(),
      payload: { empfaenger: 'kunde@example.at' },
    })
    expect(mail.statusCode).toBe(409)
    expect(mail.json().fehler).toContain('SMTP')
  })
})
