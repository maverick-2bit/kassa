/**
 * Integrationstest: Offline-Einlass (Ticketing Release 4) gegen echtes PostgreSQL.
 *
 * Kernpunkte:
 *  - Offline-Liste: nur gültige/stornierte Tickets des Events, Code NUR als SHA-256
 *  - Abgleich mit ?seit liefert nur geänderte Tickets
 *  - Nachreichen: löst mit dem Zeitpunkt am Eingang ein, wiederholbar (scanId),
 *    auch gleichzeitig nie doppelt
 *  - Konflikt: offline eingelassen, aber woanders schon eingelöst / storniert
 *  - Zaun: gesperrtes Gerät, fremder Mandant, Backoffice-Token
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { ticketEinlassLog, tickets } from '../../src/db/schema.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'OF-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = (nr: number) => ({
  firmenname: `Offline Test ${nr} OG`,
  uid:        `ATU9999994${nr}`,
  kassenId:   `OF-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-OF-${nr}`, benutzerkennung: `BID-OF-${nr}`, pin: `PIN-OF-${nr}` },
  umgebung: 'test',
  admin: { name: `OF Admin ${nr}`, email: `admin${nr}@offlinetest.at`, passwort: 'offlinetest-passwort-123' },
})

const TAG = 86_400_000
const sha = (code: string) => createHash('sha256').update(code).digest('hex')
const vor = (minuten: number) => new Date(Date.now() - minuten * 60_000).toISOString()

describe('Offline-Einlass (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const token: Record<'A' | 'B', string> = { A: '', B: '' }
  const geraet: Record<string, { id: string; token: string }> = {}
  let eventA: string, artA: string, eventB: string
  const code: Record<string, string> = {}

  const admin = (m: 'A' | 'B') => ({ authorization: `Bearer ${token[m]}` })
  const alsGeraet = (name: string) => ({ authorization: `Bearer ${geraet[name]!.token}` })
  const liste = (name: string, eventId: string, seit?: string) => srv.fastify.inject({
    method: 'GET', url: `/api/einlass/events/${eventId}/offline-liste${seit ? `?seit=${encodeURIComponent(seit)}` : ''}`,
    headers: alsGeraet(name),
  })
  const sync = (name: string, scans: Array<{ scanId?: string; inhalt: string; zeitpunkt?: string; lokal: string }>, eventId = eventA) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/einlass/sync', headers: alsGeraet(name),
      payload: { eventId, scans: scans.map(s => ({ scanId: s.scanId ?? randomUUID(), zeitpunkt: s.zeitpunkt ?? vor(1), inhalt: s.inhalt, lokal: s.lokal })) },
    })
  const ticketRow = async (c: string) => (await idb.db.select().from(tickets).where(eq(tickets.code, c)).limit(1))[0]!

  async function ausstellen(eventId: string, payload: object): Promise<string> {
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/ticketing/events/${eventId}/tickets`, headers: admin('A'), payload })
    if (res.statusCode !== 201) throw new Error(`Ausstellen: ${res.body}`)
    return res.json().tickets[0].code
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const [nr, m] of [[1, 'A'], [2, 'B']] as const) {
      const setup = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setup.statusCode !== 201) throw new Error(`Setup ${m}: ${setup.body}`)
      token[m] = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@offlinetest.at`, passwort: 'offlinetest-passwort-123' },
      })).json().token
      await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: admin(m), payload: { modulTicketsAktiv: true } })
    }
    for (const [m, name] of [['A', 'Nord'], ['A', 'Süd'], ['A', 'Weg'], ['B', 'Fremd']] as const) {
      const res = await srv.fastify.inject({ method: 'POST', url: '/api/ticketing/einlass-geraete', headers: admin(m), payload: { name } })
      geraet[name] = { id: res.json().geraet.id, token: res.json().token }
    }

    const ev = (await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: admin('A'),
      payload: { titel: 'Offline-Fest', ort: 'Wiese', beginn: new Date(Date.now() + 2 * 3600_000).toISOString(), status: 'test' },
    })).json()
    eventA = ev.id
    artA = (await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventA}/arten`, headers: admin('A'),
      payload: { bezeichnung: 'Eintritt', preisCent: 0, mwstSatz: 'ermaessigt2' },
    })).json().id
    eventB = (await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: admin('B'),
      payload: { titel: 'Fremd', ort: 'X', beginn: new Date(Date.now() + 3600_000).toISOString(), status: 'test' },
    })).json().id

    const geb = (jahre: number) => new Date(Date.now() - jahre * 365.25 * TAG - 30 * TAG).toISOString().slice(0, 10)
    const einzel = (extra: object = {}) => ausstellen(eventA, { typ: 'einzel', ticketArtId: artA, anzahl: 1, ...extra })
    code.anna     = await einzel({ name: 'Anna', geburtsdatum: geb(30) })
    code.ben      = await einzel({ name: 'Ben', geburtsdatum: geb(16) })
    code.crew     = await ausstellen(eventA, { typ: 'mehrfach', rolle: 'Crew', anzahl: 1 })
    code.doppelt  = await einzel()
    code.storno   = await einzel()
    code.parallel = await einzel()
    code.zukunft  = await einzel()

    // Reserviert (Online-Zahlung läuft) — gehört NICHT in die Offline-Liste
    const [vorlage] = await idb.db.select().from(tickets).where(eq(tickets.code, code.anna)).limit(1)
    await idb.db.insert(tickets).values({
      mandantId: vorlage!.mandantId, eventId: eventA, ticketArtId: artA, code: 'reserviertxxxxxx',
      typ: 'einzel', bezeichnung: 'Eintritt', status: 'reserviert',
    })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  let listenStand = ''
  it('Offline-Liste: gültige/stornierte Tickets des Events, Code NUR als SHA-256, mit Bändern + Geburtsdaten', async () => {
    const res = await liste('Nord', eventA)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const l = res.json()
    listenStand = l.erstelltAt
    expect(l).toMatchObject({ eventId: eventA, vollstaendig: true, event: { titel: 'Offline-Fest', status: 'test' } })
    expect(l.baender).toHaveLength(3)
    expect(l.tickets).toHaveLength(7)   // ohne das reservierte
    const hashes = new Set(l.tickets.map((t: { h: string }) => t.h))
    for (const c of Object.values(code)) expect(hashes.has(sha(c))).toBe(true)
    expect(hashes.has(sha('reserviertxxxxxx'))).toBe(false)
    // Kein Klartext-Code auf dem Gerät
    for (const c of Object.values(code)) expect(res.body).not.toContain(c)
    const anna = l.tickets.find((t: { h: string }) => t.h === sha(code.anna!))
    expect(anna).toMatchObject({ name: 'Anna', typ: 'einzel', status: 'gueltig', einlassAnzahl: 0, ersterEinlassAt: null })
    expect(anna.geburtsdatum).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('Abgleich: ?seit liefert nur die seither geänderten Tickets (hier: storniert)', async () => {
    const [t] = await idb.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.code, code.storno!))
    expect((await srv.fastify.inject({ method: 'POST', url: `/api/ticketing/tickets/${t!.id}/stornieren`, headers: admin('A') })).statusCode).toBe(200)

    const delta = (await liste('Nord', eventA, listenStand)).json()
    expect(delta.vollstaendig).toBe(false)
    expect(delta.tickets).toHaveLength(1)
    expect(delta.tickets[0]).toMatchObject({ h: sha(code.storno!), status: 'storniert' })
  })

  it('Offline eingelassen → nachgereicht: eingelöst mit dem Zeitpunkt am Eingang, protokolliert als offline', async () => {
    const scanId = randomUUID()
    const zeitpunkt = vor(5)
    const res = await sync('Süd', [{ scanId, inhalt: `https://tickets.test.at/t/${code.anna}`, zeitpunkt, lokal: 'zugelassen' }])
    expect(res.statusCode).toBe(200)
    const [e] = res.json().ergebnisse
    expect(e).toMatchObject({ scanId, ergebnis: 'zugelassen', lokal: 'zugelassen', konflikt: false })
    expect(e.ticket).toMatchObject({ name: 'Anna', alter: 30, band: { bezeichnung: 'Grün' } })
    expect(res.json().stand.besucher).toBe(1)

    const t = await ticketRow(code.anna!)
    expect(t.ersterEinlassAt!.toISOString()).toBe(zeitpunkt)
    expect(t.ersterEinlassGeraet).toBe('Süd')
    const [log] = await idb.db.select().from(ticketEinlassLog).where(eq(ticketEinlassLog.scanId, scanId))
    expect(log).toMatchObject({ offline: true, lokalesErgebnis: 'zugelassen', ergebnis: 'zugelassen', geraetName: 'Süd' })
    expect(log!.zeitpunkt.toISOString()).toBe(zeitpunkt)
  })

  it('Wiederholtes Nachreichen (Netz riss nach dem Senden ab) löst nichts doppelt ein', async () => {
    const scanId = randomUUID()
    const erst  = (await sync('Süd', [{ scanId, inhalt: code.ben!, lokal: 'zugelassen' }])).json().ergebnisse[0]
    const zweit = (await sync('Süd', [{ scanId, inhalt: code.ben!, lokal: 'zugelassen' }])).json().ergebnisse[0]
    expect(erst).toMatchObject({ ergebnis: 'zugelassen', konflikt: false })
    expect(zweit).toMatchObject({ ergebnis: 'zugelassen', konflikt: false })   // nicht „bereits eingelöst"!
    expect(zweit.ticket.band.bezeichnung).toBe('Gelb')
    expect(await idb.db.select().from(ticketEinlassLog).where(eq(ticketEinlassLog.scanId, scanId))).toHaveLength(1)
    expect((await ticketRow(code.ben!)).einlassAnzahl).toBe(1)
  })

  it('Konflikt: offline eingelassen, aber an einem anderen Eingang schon eingelöst — Backoffice sieht es', async () => {
    const online = await srv.fastify.inject({
      method: 'POST', url: '/api/einlass/scan', headers: alsGeraet('Nord'), payload: { eventId: eventA, inhalt: code.doppelt },
    })
    expect(online.json().ergebnis).toBe('zugelassen')

    const [e] = (await sync('Süd', [{ inhalt: code.doppelt!, lokal: 'zugelassen' }])).json().ergebnisse
    expect(e).toMatchObject({ ergebnis: 'bereits_eingeloest', lokal: 'zugelassen', konflikt: true })
    expect(e.ticket.ersterEinlassGeraet).toBe('Nord')

    const log = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventA}/einlass-log`, headers: admin('A') })).json()
    const konflikte = log.filter((l: { konflikt: boolean }) => l.konflikt)
    expect(konflikte).toHaveLength(1)
    expect(konflikte[0]).toMatchObject({ offline: true, lokal: 'zugelassen', ergebnis: 'bereits_eingeloest', geraetName: 'Süd' })
  })

  it('Online-Antwort verloren, derselbe Scan offline nachgereicht (gleiches Gerät, gleiche Minute) → kein Konflikt', async () => {
    const c = await ausstellen(eventA, { typ: 'einzel', ticketArtId: artA, anzahl: 1 })
    const online = await srv.fastify.inject({
      method: 'POST', url: '/api/einlass/scan', headers: alsGeraet('Nord'), payload: { eventId: eventA, inhalt: c },
    })
    expect(online.json().ergebnis).toBe('zugelassen')
    const [e] = (await sync('Nord', [{ inhalt: c, zeitpunkt: new Date().toISOString(), lokal: 'zugelassen' }])).json().ergebnisse
    expect(e).toMatchObject({ ergebnis: 'zugelassen', konflikt: false })
    expect((await ticketRow(c)).einlassAnzahl).toBe(1)
  })

  it('Storniert, nachdem die Liste geladen war → Konflikt „storniert", nichts eingelöst', async () => {
    const [e] = (await sync('Süd', [{ inhalt: code.storno!, lokal: 'zugelassen' }])).json().ergebnisse
    expect(e).toMatchObject({ ergebnis: 'storniert', konflikt: true })
    expect((await ticketRow(code.storno!)).ersterEinlassAt).toBeNull()
  })

  it('Mehrfachticket offline: jeder Eintritt zählt, Besucher einmal; früherer Offline-Eintritt wird erster Einlass', async () => {
    const online = await srv.fastify.inject({
      method: 'POST', url: '/api/einlass/scan', headers: alsGeraet('Nord'), payload: { eventId: eventA, inhalt: code.crew },
    })
    expect(online.json().ergebnis).toBe('mehrfach')
    const frueher = vor(30)
    const res = (await sync('Süd', [{ inhalt: code.crew!, zeitpunkt: frueher, lokal: 'mehrfach' }])).json()
    expect(res.ergebnisse[0]).toMatchObject({ ergebnis: 'mehrfach', konflikt: false })
    const t = await ticketRow(code.crew!)
    expect(t.einlassAnzahl).toBe(2)
    expect(t.ersterEinlassAt!.toISOString()).toBe(frueher)
    expect(res.stand.besucherMehrfach).toBe(1)
  })

  it('Lokal abgewiesene Scans werden nur protokolliert — nichts eingelöst, kein Konflikt', async () => {
    const vorher = await ticketRow(code.anna!)
    const res = (await sync('Süd', [
      { inhalt: code.anna!, lokal: 'bereits_eingeloest' },
      { inhalt: 'kein-ticket-qr', lokal: 'unbekannt' },
    ])).json()
    expect(res.ergebnisse.map((e: { ergebnis: string; konflikt: boolean }) => [e.ergebnis, e.konflikt]))
      .toEqual([['bereits_eingeloest', false], ['unbekannt', false]])
    expect((await ticketRow(code.anna!)).einlassAnzahl).toBe(vorher.einlassAnzahl)
  })

  it('Gleichzeitig von zwei Geräten nachgereicht → genau einer lässt ein, der andere ist Konflikt', async () => {
    const [a, b] = await Promise.all([
      sync('Nord', [{ inhalt: code.parallel!, lokal: 'zugelassen' }]),
      sync('Süd',  [{ inhalt: code.parallel!, lokal: 'zugelassen' }]),
    ])
    const ergebnisse = [a.json().ergebnisse[0], b.json().ergebnisse[0]].map((e: { ergebnis: string }) => e.ergebnis).sort()
    expect(ergebnisse).toEqual(['bereits_eingeloest', 'zugelassen'])
    expect((await ticketRow(code.parallel!)).einlassAnzahl).toBe(1)
  })

  it('Uhr des Geräts vorgehend: Zeitpunkt in der Zukunft wird auf jetzt begrenzt', async () => {
    const zukunft = new Date(Date.now() + 2 * 3600_000).toISOString()
    await sync('Nord', [{ inhalt: code.zukunft!, zeitpunkt: zukunft, lokal: 'zugelassen' }])
    expect((await ticketRow(code.zukunft!)).ersterEinlassAt!.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('Zaun: gesperrtes Gerät, fremder Mandant, Backoffice-Token', async () => {
    await srv.fastify.inject({ method: 'POST', url: `/api/ticketing/einlass-geraete/${geraet.Weg!.id}/sperren`, headers: admin('A') })
    expect((await liste('Weg', eventA)).statusCode).toBe(401)
    expect((await sync('Weg', [{ inhalt: code.anna!, lokal: 'zugelassen' }])).statusCode).toBe(401)

    expect((await liste('Fremd', eventA)).statusCode).toBe(404)
    expect((await sync('Fremd', [{ inhalt: code.anna!, lokal: 'zugelassen' }])).statusCode).toBe(404)
    expect((await liste('Fremd', eventB)).statusCode).toBe(200)

    const backoffice = await srv.fastify.inject({
      method: 'GET', url: `/api/einlass/events/${eventA}/offline-liste`, headers: admin('A'),
    })
    expect(backoffice.statusCode).toBe(403)

    // Kein Einlösen über fremde Mandanten: das Ticket von A bleibt unverändert
    const t = await ticketRow(code.anna!)
    expect(t.ersterEinlassGeraet).toBe('Süd')
    const alle = await idb.db.select().from(ticketEinlassLog)
      .where(and(eq(ticketEinlassLog.eventId, eventA), eq(ticketEinlassLog.geraetName, 'Fremd')))
    expect(alle).toHaveLength(0)
  })
})
