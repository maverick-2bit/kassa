/**
 * Integrationstest: Ticketing-Grundgerüst (Events, Bänder, Ticketarten,
 * internes Ausstellen, öffentliche Ansicht, PDF, E-Mail, Einlass-Stand).
 *
 * Kernpunkte:
 *  - Band nach Alter AM EVENTTAG (nicht heute)
 *  - öffentliche Ticketseite ohne Geburtsdatum/E-Mail
 *  - Besucherzahl: Mehrfachtickets zählen genau einmal
 *  - Kontingent, Mindestalter, Berechtigung, Mandanten-Isolation
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { alterAm, wienerTag } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { auditLogs, tickets } from '../../src/db/schema.js'

// nodemailer abfangen: der Test prüft den tatsächlichen Mailaufbau
const { gesendet } = vi.hoisted(() => ({ gesendet: [] as Array<Record<string, unknown>> }))
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: Record<string, unknown>) => { gesendet.push(mail); return { messageId: 'test' } },
    }),
  },
}))

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'TK-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = (nr: number) => ({
  firmenname: `Ticket Test ${nr} OG`,
  uid:        `ATU9999992${nr}`,
  kassenId:   `TK-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-TK-${nr}`, benutzerkennung: `BID-TK-${nr}`, pin: `PIN-TK-${nr}` },
  umgebung: 'test',
  admin: { name: `TK Admin ${nr}`, email: `admin${nr}@tickettest.at`, passwort: 'tickettest-passwort-123' },
})

const TAG = 86_400_000

/** Geburtsdatum so, dass die Person in `tage` Tagen genau `jahre` alt wird. */
function geburtsdatumFuer(jahre: number, tage: number): string {
  const [j, m, t] = wienerTag(new Date(Date.now() + tage * TAG)).split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(j - jahre, m - 1, t)).toISOString().slice(0, 10)
}

describe('Ticketing (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA: string, tokenB: string
  let mandantA: string
  let eventId: string
  let artId: string
  let einzelTicket: { id: string; code: string }
  let crewTickets: Array<{ id: string; code: string }>

  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })
  const beginn = new Date(Date.now() + 60 * TAG)

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, {
      finanzOnlineClient: mockFoClient(),
      config: { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'tickets@test.at' },
    })
    for (const nr of [1, 2]) {
      const setup = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setup.statusCode !== 201) throw new Error(`Setup ${nr}: ${setup.body}`)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@tickettest.at`, passwort: 'tickettest-passwort-123' },
      })).json()
      if (nr === 1) { tokenA = login.token; mandantA = login.mandant.id } else tokenB = login.token
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Modul-Schalter: aus → ein, steht danach auch in der Login-Antwort', async () => {
    const vorher = (await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/module', headers: authA() })).json()
    expect(vorher.modulTicketsAktiv).toBe(false)

    const an = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/module', headers: authA(), payload: { modulTicketsAktiv: true },
    })
    expect(an.statusCode).toBe(200)
    expect(an.json().modulTicketsAktiv).toBe(true)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'admin1@tickettest.at', passwort: 'tickettest-passwort-123' },
    })).json()
    expect(login.mandant.modulTicketsAktiv).toBe(true)
  })

  it('Event anlegen bekommt die drei Standardbänder (Jugendschutz)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: authA(),
      payload: {
        titel: 'TESTLAUF Buffet', beginn: beginn.toISOString(), ort: 'Kammersäle Leoben',
        hinweis: 'Motto: wird nach der Motto-Party enthüllt', status: 'test',
      },
    })
    expect(res.statusCode).toBe(201)
    const e = res.json()
    eventId = e.id
    expect(e.baender.map((b: { bezeichnung: string }) => b.bezeichnung)).toEqual(['Grün', 'Gelb', 'Rot'])
    expect(e.stand).toMatchObject({ tickets: 0, besucher: 0 })
  })

  it('Ende vor Beginn wird abgelehnt — auch beim Ändern nur des Endes', async () => {
    const neu = await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: authA(),
      payload: { titel: 'X', ort: 'Y', beginn: beginn.toISOString(), ende: new Date(beginn.getTime() - 3600_000).toISOString() },
    })
    expect(neu.statusCode).toBe(400)

    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/ticketing/events/${eventId}`, headers: authA(),
      payload: { ende: new Date(beginn.getTime() - 3600_000).toISOString() },
    })
    expect(patch.statusCode).toBe(400)
  })

  it('Bänder: Überschneidung → 400, gültige Liste ersetzt komplett', async () => {
    const falsch = await srv.fastify.inject({
      method: 'PUT', url: `/api/ticketing/events/${eventId}/baender`, headers: authA(),
      payload: { baender: [
        { bezeichnung: 'A', farbe: '#000000', alterVon: 16, alterBis: null },
        { bezeichnung: 'B', farbe: '#ffffff', alterVon: null, alterBis: 17 },
      ] },
    })
    expect(falsch.statusCode).toBe(400)

    const richtig = await srv.fastify.inject({
      method: 'PUT', url: `/api/ticketing/events/${eventId}/baender`, headers: authA(),
      payload: { baender: [
        { bezeichnung: 'Grün', farbe: '#16A34A', alterVon: 18, alterBis: null, hinweis: 'Alle Getränke' },
        { bezeichnung: 'Gelb', farbe: '#eab308', alterVon: 16, alterBis: 17 },
        { bezeichnung: 'Rot',  farbe: '#dc2626', alterVon: null, alterBis: 15 },
      ] },
    })
    expect(richtig.statusCode).toBe(200)
    expect(richtig.json()[0].farbe).toBe('#16a34a')   // normalisiert auf Kleinbuchstaben
  })

  it('Ticketart anlegen', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/arten`, headers: authA(),
      payload: { bezeichnung: 'Test-Buffet', preisCent: 4500, mwstSatz: 'ermaessigt1', kontingent: 100 },
    })
    expect(res.statusCode).toBe(201)
    artId = res.json().id
    expect(res.json()).toMatchObject({ bezeichnung: 'Test-Buffet', ausgegeben: 0, kontingent: 100 })
  })

  it('Band richtet sich nach dem Alter AM EVENTTAG — heute 17, beim Event 18 → Grün', async () => {
    const geburtsdatum = geburtsdatumFuer(18, 30)   // wird in 30 Tagen 18, Event in 60 Tagen
    expect(alterAm(geburtsdatum, wienerTag(new Date()))).toBe(17)

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/tickets`, headers: authA(),
      payload: { typ: 'einzel', ticketArtId: artId, anzahl: 1, name: 'Anna Gast', geburtsdatum, email: 'anna@gast.at' },
    })
    expect(res.statusCode).toBe(201)
    const t = res.json().tickets[0]
    einzelTicket = { id: t.id, code: t.code }
    expect(t.alter).toBe(18)
    expect(t.band).toMatchObject({ bezeichnung: 'Grün', altersText: 'ab 18 Jahre' })
    expect(t.code).toMatch(/^[a-hjkmnp-z2-9]{16}$/)
    expect(t.preisCent).toBe(0)                   // intern ausgestellt = Freikarte
    expect(t.url).toBeNull()                      // Ticket-Adresse noch nicht eingerichtet
  })

  it('Mehrfachtickets für die Crew: 5 Stück, ohne Band, mit Rolle', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/tickets`, headers: authA(),
      payload: { typ: 'mehrfach', rolle: 'Crew', anzahl: 5 },
    })
    expect(res.statusCode).toBe(201)
    const neu = res.json().tickets as Array<{ id: string; code: string; typ: string; bezeichnung: string; band: unknown }>
    crewTickets = neu.map(t => ({ id: t.id, code: t.code }))
    expect(neu).toHaveLength(5)
    expect(new Set(neu.map(t => t.code)).size).toBe(5)
    expect(neu.every(t => t.typ === 'mehrfach' && t.bezeichnung === 'Crew' && t.band === null)).toBe(true)
  })

  it('Kontingent: ausstellen darüber hinaus → 409, Kontingent unter Ausgegebene senken → 409', async () => {
    const senken = await srv.fastify.inject({
      method: 'PATCH', url: `/api/ticketing/arten/${artId}`, headers: authA(), payload: { kontingent: 0 },
    })
    expect(senken.statusCode).toBe(409)

    const knapp = await srv.fastify.inject({
      method: 'PATCH', url: `/api/ticketing/arten/${artId}`, headers: authA(), payload: { kontingent: 1 },
    })
    expect(knapp.statusCode).toBe(200)

    const zuViel = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/tickets`, headers: authA(),
      payload: { typ: 'einzel', ticketArtId: artId, anzahl: 1 },
    })
    expect(zuViel.statusCode).toBe(409)
    expect(zuViel.json().fehler).toContain('Kontingent')

    await srv.fastify.inject({
      method: 'PATCH', url: `/api/ticketing/arten/${artId}`, headers: authA(), payload: { kontingent: 100 },
    })
  })

  it('Mindestalter wird am Eventtag geprüft', async () => {
    await srv.fastify.inject({
      method: 'PATCH', url: `/api/ticketing/events/${eventId}`, headers: authA(), payload: { mindestalter: 16 },
    })
    const zuJung = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/tickets`, headers: authA(),
      payload: { typ: 'einzel', ticketArtId: artId, anzahl: 1, geburtsdatum: geburtsdatumFuer(16, 90) },
    })
    expect(zuJung.statusCode).toBe(422)
    await srv.fastify.inject({
      method: 'PATCH', url: `/api/ticketing/events/${eventId}`, headers: authA(), payload: { mindestalter: null },
    })
  })

  it('Öffentliche Ticketseite: Band ja — Geburtsdatum und E-Mail NEIN', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/ticket/${einzelTicket.code}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const o = res.json()
    expect(o).toMatchObject({
      code: einzelTicket.code, typ: 'einzel', bezeichnung: 'Test-Buffet', name: 'Anna Gast', anzeigeStatus: 'gueltig',
      band: { bezeichnung: 'Grün', altersText: 'ab 18 Jahre' },
      event: { titel: 'TESTLAUF Buffet', ort: 'Kammersäle Leoben', status: 'test', veranstalter: 'Ticket Test 1 OG' },
    })
    const roh = res.body
    expect(roh).not.toContain('geburtsdatum')
    expect(roh).not.toContain('anna@gast.at')
    expect(roh).not.toContain(geburtsdatumFuer(18, 30))
  })

  it('Unbekannte, fehlerhafte und reservierte Codes sind öffentlich nicht auffindbar', async () => {
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/ticketshop/ticket/abcdefghjkmnpqrs' })).statusCode).toBe(404)
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/ticketshop/ticket/nicht-gueltig' })).statusCode).toBe(404)

    await idb.db.insert(tickets).values({
      mandantId: mandantA, eventId, code: 'reserv23456789ab', typ: 'einzel', bezeichnung: 'X', status: 'reserviert',
    })
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/ticketshop/ticket/reserv23456789ab' })).statusCode).toBe(404)
  })

  it('PDF über den öffentlichen Link', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/ticketshop/ticket/${einzelTicket.code}/pdf`,
      headers: { host: 'tickets.test.at', 'x-forwarded-proto': 'https' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('Besucherzahl: Mehrfachtickets zählen genau einmal, egal wie oft sie rein sind', async () => {
    const jetzt = new Date()
    await idb.db.update(tickets).set({ ersterEinlassAt: jetzt, einlassAnzahl: 1 })
      .where(eq(tickets.id, einzelTicket.id))
    await idb.db.update(tickets).set({ ersterEinlassAt: jetzt, letzterEinlassAt: jetzt, einlassAnzahl: 4 })
      .where(eq(tickets.id, crewTickets[0]!.id))

    const e = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventId}`, headers: authA() })).json()
    expect(e.stand).toMatchObject({ tickets: 6, mehrfach: 5, besucher: 2, besucherMehrfach: 1 })
    const proBand = Object.fromEntries(e.stand.proBand.map((b: { bezeichnung: string; anzahl: number }) => [b.bezeichnung, b.anzahl]))
    expect(proBand).toMatchObject({ 'Grün': 1, 'Gelb': 0, 'Rot': 0, 'ohne Band': 1 })

    // Eventliste und Ticketart zählen mit (Regression: Drizzle setzte die Spalte
    // in der Zähl-Unterabfrage unqualifiziert ein → immer 0)
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/ticketing/events', headers: authA() })).json() as
      Array<{ id: string; tickets: number; besucher: number }>
    expect(liste.find(x => x.id === eventId)).toMatchObject({ tickets: 6, besucher: 2 })
    expect(e.arten[0]).toMatchObject({ bezeichnung: 'Test-Buffet', ausgegeben: 1 })

    // Einzelticket gilt nach außen als eingelöst, das Mehrfachticket bleibt gültig
    const einzel = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/ticket/${einzelTicket.code}` })).json()
    const crew   = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/ticket/${crewTickets[0]!.code}` })).json()
    expect(einzel.anzeigeStatus).toBe('eingeloest')
    expect(crew.anzeigeStatus).toBe('gueltig')
  })

  it('Storno: Ticket gilt danach als storniert, Vorgang steht im Audit-Log', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/tickets/${crewTickets[4]!.id}/stornieren`, headers: authA(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().anzeigeStatus).toBe('storniert')

    const nochmal = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/tickets/${crewTickets[4]!.id}/stornieren`, headers: authA(),
    })
    expect(nochmal.statusCode).toBe(409)

    await vi.waitFor(async () => {
      const log = await idb.db.select().from(auditLogs)
        .where(and(eq(auditLogs.mandantId, mandantA), eq(auditLogs.aktion, 'ticket.storniert')))
      expect(log).toHaveLength(1)
    })
  })

  it('Versand ohne Ticket-Adresse: klare Meldung statt Mail mit totem Link', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/tickets/senden', headers: authA(),
      payload: { ticketIds: [einzelTicket.id], email: 'anna@gast.at' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().fehler).toContain('Ticket-Adresse')
    expect(gesendet).toHaveLength(0)
  })

  it('Versand: Mail mit QR je Ticket + PDF, Links auf die Ticket-Adresse, kein Geburtsdatum', async () => {
    const einst = await srv.fastify.inject({
      method: 'PUT', url: '/api/ticketing/einstellungen', headers: authA(),
      payload: { ticketBasisUrl: 'https://tickets.test.at/' },
    })
    expect(einst.json().ticketBasisUrl).toBe('https://tickets.test.at')

    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/tickets/senden', headers: authA(),
      payload: { ticketIds: [einzelTicket.id, crewTickets[1]!.id], email: 'anna@gast.at' },
    })
    expect(res.statusCode).toBe(200)
    expect(gesendet).toHaveLength(1)

    const mail = gesendet[0] as { to: string; html: string; attachments: Array<{ filename: string; cid?: string; content: Buffer }> }
    expect(mail.to).toBe('anna@gast.at')
    expect(mail.html).toContain(`https://tickets.test.at/t/${einzelTicket.code}`)
    expect(mail.html).toContain('Band Grün')
    expect(mail.html).not.toContain(geburtsdatumFuer(18, 30))
    const qr  = mail.attachments.filter(a => a.cid)
    const pdf = mail.attachments.filter(a => a.filename.endsWith('.pdf'))
    expect(qr).toHaveLength(2)
    expect(qr[0]!.content.subarray(1, 4).toString()).toBe('PNG')

    // Der QR muss GENAU den Ticket-Link tragen — ein falscher QR fiele erst am Einlass auf
    const bild = PNG.sync.read(qr[0]!.content)
    const gelesen = jsQR(new Uint8ClampedArray(bild.data), bild.width, bild.height)
    expect(gelesen?.data).toBe(`https://tickets.test.at/t/${einzelTicket.code}`)
    expect(qr[0]!.cid).toBe(`qr-${einzelTicket.code}@kassa`)
    expect(pdf).toHaveLength(1)
    expect(pdf[0]!.content.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('Ohne Berechtigung „tickets" kein Zugriff (Kellner) — mit Berechtigung schon', async () => {
    const ohne = srv.signTestToken({ mandantId: mandantA, rolle: 'kellner', berechtigungen: ['kasse'] })
    const mit  = srv.signTestToken({ mandantId: mandantA, rolle: 'kellner', berechtigungen: ['tickets'] })
    expect((await srv.fastify.inject({
      method: 'GET', url: '/api/ticketing/events', headers: { authorization: `Bearer ${ohne}` },
    })).statusCode).toBe(403)
    expect((await srv.fastify.inject({
      method: 'GET', url: '/api/ticketing/events', headers: { authorization: `Bearer ${mit}` },
    })).statusCode).toBe(200)
  })

  it('Mandanten-Isolation: B sieht und ändert keine Events/Tickets von A', async () => {
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/ticketing/events', headers: authB() })).json()
    expect(liste).toEqual([])

    const pruefe = async (method: 'GET' | 'PATCH' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: object) => {
      const res = await srv.fastify.inject({ method, url, headers: authB(), ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
    await pruefe('GET',    `/api/ticketing/events/${eventId}`)
    await pruefe('PATCH',  `/api/ticketing/events/${eventId}`, { titel: 'gekapert' })
    await pruefe('PUT',    `/api/ticketing/events/${eventId}/baender`, { baender: [] })
    await pruefe('POST',   `/api/ticketing/events/${eventId}/arten`, { bezeichnung: 'X', preisCent: 0, mwstSatz: 'normal' })
    await pruefe('PATCH',  `/api/ticketing/arten/${artId}`, { preisCent: 1 })
    await pruefe('DELETE', `/api/ticketing/arten/${artId}`)
    await pruefe('GET',    `/api/ticketing/events/${eventId}/tickets`)
    await pruefe('POST',   `/api/ticketing/events/${eventId}/tickets`, { typ: 'mehrfach', rolle: 'Crew', anzahl: 1 })
    await pruefe('POST',   `/api/ticketing/tickets/${einzelTicket.id}/stornieren`)
    await pruefe('POST',   '/api/ticketing/tickets/senden', { ticketIds: [einzelTicket.id], email: 'x@y.at' })
    await pruefe('GET',    `/api/ticketing/tickets/pdf?ids=${einzelTicket.id}`)
    await pruefe('DELETE', `/api/ticketing/events/${eventId}`)

    // A ist unverändert
    const e = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventId}`, headers: authA() })).json()
    expect(e.titel).toBe('TESTLAUF Buffet')
    expect(e.baender).toHaveLength(3)
  })

  it('Event mit Tickets ist nicht löschbar (409), leeres Event schon (204)', async () => {
    expect((await srv.fastify.inject({
      method: 'DELETE', url: `/api/ticketing/events/${eventId}`, headers: authA(),
    })).statusCode).toBe(409)

    const leer = (await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: authA(),
      payload: { titel: 'Leer', ort: 'Irgendwo', beginn: beginn.toISOString() },
    })).json()
    expect((await srv.fastify.inject({
      method: 'DELETE', url: `/api/ticketing/events/${leer.id}`, headers: authA(),
    })).statusCode).toBe(204)
  })
})
