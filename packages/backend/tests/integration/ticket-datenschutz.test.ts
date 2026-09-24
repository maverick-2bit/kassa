/**
 * Integrationstest: Datenschutz im Ticketing — Personendaten nach Eventende löschen.
 *
 * Kernpunkte:
 *  - fällig = (Ende bzw. Beginn) + „Daten löschen nach" Tage vorbei
 *  - gelöscht werden Namen, Geburtsdaten, E-Mails der Tickets und Käuferdaten
 *    der Bestellungen; Tickets, Beträge und Einlasszeiten bleiben
 *  - idempotent; „Jetzt löschen" im Backoffice erst nach dem Event
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { auditLogs, ticketBestellungen, ticketEvents, tickets } from '../../src/db/schema.js'
import { loescheFaelligePersonendaten } from '../../src/services/ticket-datenschutz.service.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'DS-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const TAG = 86_400_000

describe('Ticketing-Datenschutz (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let mandantId: string
  const ev: Record<string, string> = {}

  const auth = () => ({ authorization: `Bearer ${token}` })

  /** Event mit zwei personalisierten Tickets + einer Bestellung; Beginn/Ende danach in die Vergangenheit legen. */
  async function eventMitGaesten(titel: string, endeVorTagen: number, loeschTage: number): Promise<string> {
    const e = (await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: auth(),
      payload: { titel, ort: 'Halle', beginn: new Date(Date.now() + TAG).toISOString(), status: 'veroeffentlicht', datenLoeschenNachTagen: loeschTage },
    })).json()
    const art = (await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${e.id}/arten`, headers: auth(),
      payload: { bezeichnung: 'Eintritt', preisCent: 0, mwstSatz: 'ermaessigt2' },
    })).json()
    for (const name of ['Anna', 'Ben']) {
      const r = await srv.fastify.inject({
        method: 'POST', url: `/api/ticketing/events/${e.id}/tickets`, headers: auth(),
        payload: { typ: 'einzel', ticketArtId: art.id, anzahl: 1, name, geburtsdatum: '1990-04-01', email: `${name.toLowerCase()}@example.at` },
      })
      if (r.statusCode !== 201) throw new Error(r.body)
    }
    await idb.db.insert(ticketBestellungen).values({
      mandantId, eventId: e.id, status: 'bezahlt', name: 'Karin Käuferin', email: 'karin@example.at',
      rechnung: { firma: 'Firma GmbH', strasse: 'Weg 1', plz: '1010', ort: 'Wien', land: 'AT', uid: null },
      positionen: [], summeCent: 0, reserviertBis: new Date(), agbAkzeptiertAt: new Date(),
    })
    const ende = new Date(Date.now() - endeVorTagen * TAG)
    await idb.db.update(ticketEvents).set({ beginn: new Date(ende.getTime() - 5 * 3600_000), ende }).where(eq(ticketEvents.id, e.id))
    return e.id
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setup = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: {
      firmenname: 'Datenschutz Test OG', uid: 'ATU99999951', kassenId: 'DS-001',
      finanzOnline: { teilnehmerId: 'TID-DS', benutzerkennung: 'BID-DS', pin: 'PIN-DS' }, umgebung: 'test',
      admin: { name: 'DS Admin', email: 'admin@dstest.at', passwort: 'dstest-passwort-123' },
    } })
    if (setup.statusCode !== 201) throw new Error(setup.body)
    const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@dstest.at', passwort: 'dstest-passwort-123' } })).json()
    token = login.token; mandantId = login.mandant.id
    await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulTicketsAktiv: true } })

    ev.alt       = await eventMitGaesten('Alt (40 Tage, Frist 30)', 40, 30)
    ev.frisch    = await eventMitGaesten('Frisch (10 Tage, Frist 30)', 10, 30)
    ev.kurzFrist = await eventMitGaesten('Kurze Frist (5 Tage, Frist 3)', 5, 3)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  const gaeste = (eventId: string) =>
    idb.db.select({ name: tickets.name, geburtsdatum: tickets.geburtsdatum, email: tickets.email, code: tickets.code, status: tickets.status })
      .from(tickets).where(eq(tickets.eventId, eventId))
  const bestellung = async (eventId: string) =>
    (await idb.db.select().from(ticketBestellungen).where(eq(ticketBestellungen.eventId, eventId)).limit(1))[0]!

  it('Job löscht nur fällige Events: Gäste- und Käuferdaten weg, Tickets bleiben', async () => {
    const r = await loescheFaelligePersonendaten(idb.db)
    expect(r).toEqual({ events: 2, tickets: 4, bestellungen: 2 })

    for (const id of [ev.alt!, ev.kurzFrist!]) {
      const t = await gaeste(id)
      expect(t).toHaveLength(2)
      expect(t.every(x => x.name === null && x.geburtsdatum === null && x.email === null)).toBe(true)
      expect(t.every(x => x.status === 'gueltig' && x.code.length === 16)).toBe(true)
      expect(await bestellung(id)).toMatchObject({ name: 'gelöscht', email: '', rechnung: null })
      const [e] = await idb.db.select({ geloescht: ticketEvents.datenGeloeschtAt }).from(ticketEvents).where(eq(ticketEvents.id, id))
      expect(e!.geloescht).not.toBeNull()
    }
    // Innerhalb der Frist: unverändert
    const frisch = await gaeste(ev.frisch!)
    expect(frisch.map(t => t.name).sort()).toEqual(['Anna', 'Ben'])
    expect((await bestellung(ev.frisch!)).email).toBe('karin@example.at')
  })

  it('Zweiter Lauf ändert nichts mehr (idempotent)', async () => {
    expect(await loescheFaelligePersonendaten(idb.db)).toEqual({ events: 0, tickets: 0, bestellungen: 0 })
  })

  it('Backoffice „Jetzt löschen": vor dem Event abgelehnt, danach sofort — mit Audit-Eintrag', async () => {
    const zukunft = (await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: auth(),
      payload: { titel: 'Kommt noch', ort: 'X', beginn: new Date(Date.now() + 7 * TAG).toISOString() },
    })).json()
    const zuFrueh = await srv.fastify.inject({ method: 'POST', url: `/api/ticketing/events/${zukunft.id}/personendaten-loeschen`, headers: auth() })
    expect(zuFrueh.statusCode).toBe(409)

    const jetzt = await srv.fastify.inject({ method: 'POST', url: `/api/ticketing/events/${ev.frisch}/personendaten-loeschen`, headers: auth() })
    expect(jetzt.statusCode).toBe(200)
    expect(jetzt.json()).toEqual({ tickets: 2, bestellungen: 1 })
    expect((await gaeste(ev.frisch!)).every(t => t.name === null && t.geburtsdatum === null)).toBe(true)

    const detail = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${ev.frisch}`, headers: auth() })).json()
    expect(detail.datenGeloeschtAt).not.toBeNull()
    const audits = await idb.db.select().from(auditLogs)
      .where(and(eq(auditLogs.mandantId, mandantId), eq(auditLogs.aktion, 'einstellungen.geaendert')))
    expect(audits.some(a => (a.details as { aktion?: string } | null)?.aktion === 'personendaten_geloescht')).toBe(true)
  })

  it('Bestellseite nach dem Löschen verrät keine Adresse', async () => {
    const b = await bestellung(ev.alt!)
    const seite = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/bestellungen/${b.id}` })).json()
    expect(seite.emailMaskiert).toBe('(gelöscht)')
  })
})
