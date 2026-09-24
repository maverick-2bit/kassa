/**
 * Integrationstest: Einlass (Ticketing Release 2) gegen echtes PostgreSQL.
 *
 * Kernpunkte:
 *  - „nur 1× gültig" hält auch bei GLEICHZEITIGEN Scans (genau einer gewinnt)
 *  - Mehrfachtickets: jeder Eintritt zählt, die Besucherzahl nur einmal
 *  - Einlass-Gerät: eigener Token, Zaun (kein Backoffice, keine Kassa, kein SSE),
 *    einzeln sperrbar
 *  - Mandanten-Isolation: fremde Tickets sind „unbekannt", nie „anderes Event"
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { tickets } from '../../src/db/schema.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'EL-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = (nr: number) => ({
  firmenname: `Einlass Test ${nr} OG`,
  uid:        `ATU9999993${nr}`,
  kassenId:   `EL-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-EL-${nr}`, benutzerkennung: `BID-EL-${nr}`, pin: `PIN-EL-${nr}` },
  umgebung: 'test',
  admin: { name: `EL Admin ${nr}`, email: `admin${nr}@einlasstest.at`, passwort: 'einlasstest-passwort-123' },
})

const TAG = 86_400_000

describe('Einlass (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const token: Record<'A' | 'B', string> = { A: '', B: '' }
  const geraet: Record<string, { id: string; token: string }> = {}
  let eventA: string, eventA2: string, eventB: string
  let erwachsen: string, jugendlich: string, crew: string, wettlauf: string, storno: string, fremdEvent: string

  const admin = (m: 'A' | 'B') => ({ authorization: `Bearer ${token[m]}` })
  const alsGeraet = (name: string) => ({ authorization: `Bearer ${geraet[name]!.token}` })

  const scan = (name: string, eventId: string, inhalt: string) =>
    srv.fastify.inject({ method: 'POST', url: '/api/einlass/scan', headers: alsGeraet(name), payload: { eventId, inhalt } })

  async function event(m: 'A' | 'B', titel: string, status = 'test') {
    const e = (await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: admin(m),
      payload: { titel, ort: 'Leoben', beginn: new Date(Date.now() + 2 * 3600_000).toISOString(), status },
    })).json()
    const art = (await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${e.id}/arten`, headers: admin(m),
      payload: { bezeichnung: 'Eintritt', preisCent: 1000, mwstSatz: 'ermaessigt1' },
    })).json()
    return { id: e.id as string, artId: art.id as string }
  }

  async function ausstellen(m: 'A' | 'B', eventId: string, payload: object): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/tickets`, headers: admin(m), payload,
    })
    if (res.statusCode !== 201) throw new Error(`Ausstellen fehlgeschlagen: ${res.body}`)
    return res.json().tickets[0].code
  }

  async function neuesGeraet(m: 'A' | 'B', name: string) {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/einlass-geraete', headers: admin(m), payload: { name },
    })
    expect(res.statusCode).toBe(201)
    geraet[name] = { id: res.json().geraet.id, token: res.json().token }
    return res.json()
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const [nr, m] of [[1, 'A'], [2, 'B']] as const) {
      const setup = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setup.statusCode !== 201) throw new Error(`Setup ${m}: ${setup.body}`)
      token[m] = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@einlasstest.at`, passwort: 'einlasstest-passwort-123' },
      })).json().token
      await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: admin(m), payload: { modulTicketsAktiv: true } })
    }

    const a  = await event('A', 'Sommerfest')
    const a2 = await event('A', 'Herbstball')
    const b  = await event('B', 'Fremdes Fest')
    eventA = a.id; eventA2 = a2.id; eventB = b.id

    const geb = (jahre: number) => new Date(Date.now() - jahre * 365.25 * TAG - 30 * TAG).toISOString().slice(0, 10)
    erwachsen  = await ausstellen('A', eventA, { typ: 'einzel', ticketArtId: a.artId, anzahl: 1, name: 'Anna', geburtsdatum: geb(30) })
    jugendlich = await ausstellen('A', eventA, { typ: 'einzel', ticketArtId: a.artId, anzahl: 1, name: 'Lena', geburtsdatum: geb(16) })
    crew       = await ausstellen('A', eventA, { typ: 'mehrfach', rolle: 'Crew', anzahl: 1, name: 'Tom' })
    wettlauf   = await ausstellen('A', eventA, { typ: 'einzel', ticketArtId: a.artId, anzahl: 1 })
    storno     = await ausstellen('A', eventA, { typ: 'einzel', ticketArtId: a.artId, anzahl: 1 })
    fremdEvent = await ausstellen('A', eventA2, { typ: 'einzel', ticketArtId: a2.artId, anzahl: 1 })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Gerät anlegen: Token + Einrichtungs-Link (sobald die Einlass-Adresse steht)', async () => {
    const ohne = await neuesGeraet('A', 'Einlass 1')
    expect(ohne.url).toBeNull()
    expect(ohne.token.split('.')).toHaveLength(3)

    await srv.fastify.inject({
      method: 'PUT', url: '/api/ticketing/einstellungen', headers: admin('A'),
      payload: { ticketBasisUrl: 'https://tickets.test.at', einlassBasisUrl: 'https://einlass.test.at/' },
    })
    const mit = await neuesGeraet('A', 'Einlass 2')
    expect(mit.url).toBe(`https://einlass.test.at/?token=${encodeURIComponent(mit.token)}`)
    await neuesGeraet('B', 'B-Einlass')
  })

  it('Zaun: Einlass-Token nur für /api/einlass — kein Backoffice, keine Kassa, kein SSE', async () => {
    for (const url of ['/api/ticketing/events', '/api/artikel', '/api/kassen']) {
      const res = await srv.fastify.inject({ method: 'GET', url, headers: alsGeraet('Einlass 1') })
      expect(res.statusCode, url).toBe(403)
    }
    const sse = await srv.fastify.inject({ method: 'GET', url: `/sse/events?token=${geraet['Einlass 1']!.token}` })
    expect(sse.statusCode).toBe(403)

    // umgekehrt: ein normaler Login ist kein Einlass-Gerät
    const alsAdmin = await srv.fastify.inject({ method: 'GET', url: '/api/einlass/events', headers: admin('A') })
    expect(alsAdmin.statusCode).toBe(403)
  })

  it('Gerät kennt sich + sieht nur Events mit Einlass (keine Entwürfe)', async () => {
    const ich = (await srv.fastify.inject({ method: 'GET', url: '/api/einlass/ich', headers: alsGeraet('Einlass 1') })).json()
    expect(ich).toEqual({ geraet: { id: geraet['Einlass 1']!.id, name: 'Einlass 1' }, firmenname: 'Einlass Test 1 OG' })

    await event('A', 'Entwurf-Event', 'entwurf')
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/einlass/events', headers: alsGeraet('Einlass 1') })).json() as Array<{ titel: string }>
    expect(liste.map(e => e.titel).sort()).toEqual(['Herbstball', 'Sommerfest'])
  })

  it('Einzelticket: Einlass mit Band + Alter + Geburtsdatum — zweiter Scan „bereits eingelöst" mit Gerät', async () => {
    const erst = await scan('Einlass 1', eventA, `https://tickets.test.at/t/${erwachsen}`)
    expect(erst.statusCode).toBe(200)
    const e = erst.json()
    expect(e).toMatchObject({ ergebnis: 'zugelassen', zugelassen: true })
    expect(e.ticket).toMatchObject({ name: 'Anna', typ: 'einzel', einlassAnzahl: 1, ersterEinlassGeraet: 'Einlass 1' })
    expect(e.ticket.alter).toBeGreaterThanOrEqual(30)
    expect(e.ticket.geburtsdatum).toMatch(/^\d{4}-\d{2}-\d{2}$/)   // fürs Einlasspersonal: Abgleich mit dem Ausweis
    expect(e.ticket.band).toMatchObject({ bezeichnung: 'Grün', altersText: 'ab 18 Jahre' })
    expect(e.stand.besucher).toBe(1)

    const nochmal = (await scan('Einlass 2', eventA, erwachsen.toUpperCase())).json()
    expect(nochmal).toMatchObject({ ergebnis: 'bereits_eingeloest', zugelassen: false })
    expect(nochmal.ticket.ersterEinlassGeraet).toBe('Einlass 1')
    expect(nochmal.stand.besucher).toBe(1)

    const jung = (await scan('Einlass 1', eventA, jugendlich)).json()
    expect(jung.ticket.band).toMatchObject({ bezeichnung: 'Gelb', hinweis: 'Keine Spirituosen' })
  })

  it('Mehrfachticket: jeder Eintritt zählt — die Besucherzahl nur beim ersten', async () => {
    const vorher = (await srv.fastify.inject({ method: 'GET', url: `/api/einlass/events/${eventA}/stand`, headers: alsGeraet('Einlass 1') })).json()
    for (let n = 1; n <= 3; n++) {
      const r = (await scan(n === 2 ? 'Einlass 2' : 'Einlass 1', eventA, crew)).json()
      expect(r).toMatchObject({ ergebnis: 'mehrfach', zugelassen: true })
      expect(r.ticket).toMatchObject({ rolle: 'Crew', einlassAnzahl: n, ersterEinlassGeraet: 'Einlass 1' })
      expect(r.stand.besucher).toBe(vorher.besucher + 1)
      expect(r.stand.besucherMehrfach).toBe(1)
    }
  })

  it('Gleichzeitige Scans derselben Ticketkopie: genau EINER wird eingelassen', async () => {
    const ergebnisse = await Promise.all(
      Array.from({ length: 6 }, (_, i) => scan(i % 2 ? 'Einlass 2' : 'Einlass 1', eventA, wettlauf)),
    )
    const arten = ergebnisse.map(r => r.json().ergebnis as string)
    expect(arten.filter(a => a === 'zugelassen')).toHaveLength(1)
    expect(arten.filter(a => a === 'bereits_eingeloest')).toHaveLength(5)

    const [t] = await idb.db.select().from(tickets).where(eq(tickets.code, wettlauf))
    expect(t!.einlassAnzahl).toBe(1)
  })

  it('Abgewiesen: storniert, unbekannt, fremder QR, anderes Event', async () => {
    const liste = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventA}/tickets?suche=${storno}`, headers: admin('A') })).json()
    await srv.fastify.inject({ method: 'POST', url: `/api/ticketing/tickets/${liste[0].id}/stornieren`, headers: admin('A') })
    expect((await scan('Einlass 1', eventA, storno)).json()).toMatchObject({ ergebnis: 'storniert', zugelassen: false })

    const unbekannt = (await scan('Einlass 1', eventA, 'abcdefghjkmnpqrs')).json()
    expect(unbekannt).toMatchObject({ ergebnis: 'unbekannt', zugelassen: false, ticket: null })
    expect((await scan('Einlass 1', eventA, 'https://example.at/speisekarte')).json().ergebnis).toBe('unbekannt')

    const falsch = (await scan('Einlass 1', eventA, fremdEvent)).json()
    expect(falsch).toMatchObject({ ergebnis: 'falsches_event', zugelassen: false, anderesEvent: { titel: 'Herbstball' } })
    // … und es wurde dabei NICHT eingelöst: am richtigen Event kommt der Gast rein
    expect((await scan('Einlass 1', eventA2, fremdEvent)).json().ergebnis).toBe('zugelassen')
  })

  it('Mandanten-Isolation: fremdes Event 404, fremdes Ticket „unbekannt" (kein Hinweis auf den anderen Mandanten)', async () => {
    const fremdesEvent = await scan('B-Einlass', eventA, erwachsen)
    expect(fremdesEvent.statusCode).toBe(404)

    const fremdesTicket = (await scan('B-Einlass', eventB, jugendlich)).json()
    expect(fremdesTicket).toMatchObject({ ergebnis: 'unbekannt', ticket: null })
    expect(fremdesTicket.anderesEvent).toBeUndefined()

    const log = await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventA}/einlass-log`, headers: admin('B') })
    expect(log.statusCode).toBe(404)
    const sperren = await srv.fastify.inject({ method: 'POST', url: `/api/ticketing/einlass-geraete/${geraet['Einlass 1']!.id}/sperren`, headers: admin('B') })
    expect(sperren.statusCode).toBe(404)
  })

  it('Abgesagtes Event löst nichts ein', async () => {
    const e = await event('A', 'Regenfest')
    const code = await ausstellen('A', e.id, { typ: 'einzel', ticketArtId: e.artId, anzahl: 1 })
    await srv.fastify.inject({ method: 'PATCH', url: `/api/ticketing/events/${e.id}`, headers: admin('A'), payload: { status: 'abgesagt' } })
    expect((await scan('Einlass 1', e.id, code)).json()).toMatchObject({ ergebnis: 'abgesagt', zugelassen: false })
    const [t] = await idb.db.select().from(tickets).where(eq(tickets.code, code))
    expect(t!.ersterEinlassAt).toBeNull()
  })

  it('Gesperrtes Gerät ist sofort draußen, die anderen arbeiten weiter', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/einlass-geraete/${geraet['Einlass 2']!.id}/sperren`, headers: admin('A'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().widerrufenAt).not.toBeNull()

    const danach = await srv.fastify.inject({ method: 'GET', url: '/api/einlass/events', headers: alsGeraet('Einlass 2') })
    expect(danach.statusCode).toBe(401)
    expect((await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/einlass-geraete/${geraet['Einlass 2']!.id}/sperren`, headers: admin('A'),
    })).statusCode).toBe(409)
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/einlass/events', headers: alsGeraet('Einlass 1') })).statusCode).toBe(200)
  })

  it('Protokoll: jeder Scan mit Gerät und Ergebnis, neueste zuerst', async () => {
    const log = (await srv.fastify.inject({
      method: 'GET', url: `/api/ticketing/events/${eventA}/einlass-log`, headers: admin('A'),
    })).json() as Array<{ ergebnis: string; geraetName: string; zeitpunkt: string; ticket: { name: string | null } | null }>
    const arten = new Set(log.map(l => l.ergebnis))
    for (const a of ['zugelassen', 'bereits_eingeloest', 'mehrfach', 'storniert', 'unbekannt', 'falsches_event']) {
      expect(arten.has(a), a).toBe(true)
    }
    expect(log.some(l => l.geraetName === 'Einlass 2')).toBe(true)
    expect(log.some(l => l.ticket?.name === 'Anna')).toBe(true)
    const zeiten = log.map(l => l.zeitpunkt)
    expect([...zeiten].sort().reverse()).toEqual(zeiten)
  })

  it('Eventauswahl der App zählt Besucher und Tickets mit', async () => {
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/einlass/events', headers: alsGeraet('Einlass 1') })).json() as
      Array<{ id: string; besucher: number; tickets: number }>
    const sommerfest = liste.find(x => x.id === eventA)!
    // Anna, Lena, Crew, Wettlauf-Ticket eingelassen; Storno zählt nicht als gültig
    expect(sommerfest.besucher).toBe(4)
    expect(sommerfest.tickets).toBe(4)
  })
})
