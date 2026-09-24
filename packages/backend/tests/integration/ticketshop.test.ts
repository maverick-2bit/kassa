/**
 * Integrationstest: Ticketshop (Online-Kauf, Ticketing Release 3) gegen echtes PostgreSQL.
 *
 * Stripe ist ersetzt (kein Netz): die Bezahlseite liefert ein Fake, Zahlungen
 * kommen als echt signierte Webhooks (generateTestHeaderString) an.
 *
 * Kernpunkte:
 *  - Eventseite: nur Online-Ticketarten, Verfügbarkeit, Entwurf unsichtbar
 *  - Prüfungen: Mindestalter am Eventtag, Höchstmenge, Verkaufsfenster, nur Online-Arten
 *  - Reservierung: reservierte Tickets zählen im Kontingent, sind nach außen unsichtbar
 *  - Zahlung → RKSV-Beleg auf der Verkaufskasse (je Steuersatz), gültige Tickets, Mail mit Beleg
 *  - Kontingent: gleichzeitige Bestellungen überverkaufen nie
 *  - Freigabe: expired-Webhook, Abbruch, Aufräum-Job — bezahlte Session wird abgeschlossen statt verworfen
 *  - Ein fremdes Stripe-Konto kann keine Bestellung als bezahlt melden
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Stripe from 'stripe'
import { and, eq, inArray } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { wienerTag } from '@kassa/shared'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, ticketBestellungen, tickets } from '../../src/db/schema.js'
import { raeumeReservierungenAuf, type ShopStripe, type TicketShopDeps } from '../../src/services/ticketshop.service.js'
import type { Config } from '../../src/config.js'

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
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'TS-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

// ---- Stripe-Ersatz: merkt sich Sessions, Tests setzen deren Stand ----
interface FakeSession { status: 'open' | 'complete' | 'expired'; bezahlt: boolean; bestellungId: string; laeuftAbAt: Date; email: string; successUrl: string }
const sessions = new Map<string, FakeSession>()
let sessionNr = 0
const stripeFake: ShopStripe = {
  erstelleCheckout: vi.fn(async (input) => {
    const id = `cs_test_${++sessionNr}`
    sessions.set(id, { status: 'open', bezahlt: false, bestellungId: input.bestellungId, laeuftAbAt: input.laeuftAbAt, email: input.email, successUrl: input.successUrl })
    return { id, url: `https://checkout.stripe.test/${id}` }
  }),
  holeSession: vi.fn(async (id) => {
    const s = sessions.get(id)
    if (!s) throw new Error('unbekannte Session')
    return { status: s.status, bezahlt: s.bezahlt }
  }),
  beendeSession: vi.fn(async (id) => {
    const s = sessions.get(id)
    if (!s || s.status !== 'open') throw new Error('Session ist nicht offen')
    s.status = 'expired'
  }),
}
const sessionFuer = (bestellungId: string) => [...sessions.entries()].find(([, s]) => s.bestellungId === bestellungId)

const SECRET_KEY = 'sk_test_dummy_ticketshop_123'
const WH_SECRET  = { 1: 'whsec_ticketshop_konto_a_123456', 2: 'whsec_ticketshop_konto_b_654321' } as const

const setupInput = (nr: number) => ({
  firmenname: `Shop Test ${nr} GmbH`,
  uid:        `ATU9999993${nr}`,
  kassenId:   `TS-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-TS-${nr}`, benutzerkennung: `BID-TS-${nr}`, pin: `PIN-TS-${nr}` },
  umgebung: 'test',
  admin: { name: `TS Admin ${nr}`, email: `admin${nr}@shoptest.at`, passwort: 'shoptest-passwort-123' },
})

const TAG = 86_400_000
/** Geburtsdatum so, dass die Person am Tag in `tage` Tagen genau `jahre` alt ist. */
function geburtsdatumFuer(jahre: number, tage: number): string {
  const [j, m, t] = wienerTag(new Date(Date.now() + tage * TAG)).split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(j - jahre, m - 1, t)).toISOString().slice(0, 10)
}

function signiert(typ: string, session: Record<string, unknown>, secret: string) {
  const payload = JSON.stringify({ id: `evt_${typ}_${Math.random()}`, object: 'event', type: typ, data: { object: { object: 'checkout.session', ...session } } })
  const signature = new Stripe(SECRET_KEY).webhooks.generateTestHeaderString({ payload, secret })
  return { payload, headers: { 'stripe-signature': signature, 'content-type': 'application/json' } }
}

describe('Ticketshop (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const token: Record<number, string> = {}
  const mandant: Record<number, string> = {}
  const kasse: Record<number, string> = {}
  let eventId: string
  let normalId: string, vipId: string, internId: string, limitId: string
  let deps: TicketShopDeps

  const auth = (nr: 1 | 2) => ({ authorization: `Bearer ${token[nr]}` })
  const beginn = new Date(Date.now() + 60 * TAG)
  const gast = (artId: string, jahre = 30, name?: string) => ({
    ticketArtId: artId, geburtsdatum: geburtsdatumFuer(jahre, 60), ...(name ? { name } : {}),
  })
  const bestelle = (payload: Record<string, unknown>) =>
    srv.fastify.inject({ method: 'POST', url: '/api/ticketshop/bestellungen', payload })
  const bestellung = (tickets: unknown[], extra: Record<string, unknown> = {}) => ({
    eventId, kaeufer: { name: 'Karin Käuferin', email: 'karin@example.at' }, tickets, agbAkzeptiert: true, ...extra,
  })
  const webhook = (nr: 1 | 2, typ: string, session: Record<string, unknown>) => {
    const { payload, headers } = signiert(typ, session, WH_SECRET[nr])
    return srv.fastify.inject({ method: 'POST', url: `/api/stripe/webhook/${mandant[nr]}`, headers, payload })
  }
  const bestellRow = async (id: string) =>
    (await idb.db.select().from(ticketBestellungen).where(eq(ticketBestellungen.id, id)).limit(1))[0]!
  const ticketsDer = (id: string) => idb.db.select().from(tickets).where(eq(tickets.bestellungId, id))

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    const smtp = { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'tickets@test.at' }
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient(), config: smtp, ticketshopStripe: stripeFake })
    for (const nr of [1, 2] as const) {
      const setup = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setup.statusCode !== 201) throw new Error(`Setup ${nr}: ${setup.body}`)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@shoptest.at`, passwort: 'shoptest-passwort-123' },
      })).json()
      token[nr] = login.token; mandant[nr] = login.mandant.id; kasse[nr] = login.kassen[0].id
      await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: auth(nr), payload: { modulTicketsAktiv: true } })
      const stripe = await srv.fastify.inject({
        method: 'PATCH', url: '/api/mandanten/stripe', headers: auth(nr), payload: { secretKey: SECRET_KEY, webhookSecret: WH_SECRET[nr] },
      })
      if (stripe.statusCode !== 200) throw new Error(`Stripe ${nr}: ${stripe.body}`)
    }
    await srv.fastify.inject({ method: 'PUT', url: '/api/ticketing/einstellungen', headers: auth(1), payload: { ticketBasisUrl: 'https://tickets.test.at/' } })

    const ev = await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: auth(1),
      payload: { titel: 'Sommerfest', beginn: beginn.toISOString(), ort: 'Festhalle', status: 'veroeffentlicht', mindestalter: 16 },
    })
    eventId = ev.json().id
    const art = async (payload: Record<string, unknown>) => (await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/arten`, headers: auth(1), payload,
    })).json().id as string
    normalId = await art({ bezeichnung: 'Normal', preisCent: 2500, mwstSatz: 'ermaessigt2', kontingent: 5, maxProBestellung: 4 })
    vipId    = await art({ bezeichnung: 'VIP', preisCent: 6000, mwstSatz: 'normal' })
    internId = await art({ bezeichnung: 'Freikarte', preisCent: 0, mwstSatz: 'ermaessigt2', onlineVerkauf: false })
    limitId  = await art({ bezeichnung: 'Frühbucher', preisCent: 1500, mwstSatz: 'ermaessigt2', kontingent: 3 })

    deps = {
      db: idb.db,
      belegDeps: { db: idb.db, masterPassphrase: TEST_MASTER },
      config: { NODE_ENV: 'test', MASTER_PASSPHRASE: TEST_MASTER, ...smtp, SMTP_PORT: 587 } as unknown as Config,
      stripe: stripeFake,
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Einstellungen: fremde Kasse abgelehnt; Verkaufskasse + Rechtliches gespeichert, Shop-Link aus der Ticket-Adresse', async () => {
    const fremd = await srv.fastify.inject({
      method: 'PUT', url: '/api/ticketing/shop-einstellungen', headers: auth(1),
      payload: { verkaufKasseId: kasse[2], agbUrl: null, datenschutzUrl: null, impressumUrl: null, kaufhinweis: null },
    })
    expect(fremd.statusCode).toBe(400)

    const res = await srv.fastify.inject({
      method: 'PUT', url: '/api/ticketing/shop-einstellungen', headers: auth(1),
      payload: { verkaufKasseId: kasse[1], agbUrl: 'https://shop.test.at/agb', datenschutzUrl: 'https://shop.test.at/datenschutz', impressumUrl: null, kaufhinweis: 'Kein Rücktrittsrecht.' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      verkaufKasseId: kasse[1], stripe: { konfiguriert: true, eigenesKonto: true },
      shopUrl: `https://tickets.test.at/v/${mandant[1]}`,
    })
  })

  it('Eventseite: nur Online-Ticketarten mit Verfügbarkeit; Entwurf und fremdes Event unsichtbar', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/events/${eventId}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const e = res.json()
    expect(e.arten.map((a: { bezeichnung: string }) => a.bezeichnung)).toEqual(['Normal', 'VIP', 'Frühbucher'])
    expect(e.arten[0]).toMatchObject({ preisCent: 2500, verfuegbar: 5, status: 'verfuegbar', maxProBestellung: 4 })
    expect(e.arten[1].verfuegbar).toBeNull()
    expect(e).toMatchObject({ verkaufOffen: true, mindestalter: 16, veranstalter: 'Shop Test 1 GmbH',
      rechtliches: { agbUrl: 'https://shop.test.at/agb', kaufhinweis: 'Kein Rücktrittsrecht.' } })

    const entwurf = await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: auth(1),
      payload: { titel: 'Geheim', beginn: beginn.toISOString(), ort: 'X' },
    })
    expect((await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/events/${entwurf.json().id}` })).statusCode).toBe(404)

    const ueber = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/veranstalter/${mandant[1]}` })).json()
    expect(ueber.firmenname).toBe('Shop Test 1 GmbH')
    expect(ueber.events.map((x: { titel: string }) => x.titel)).toEqual(['Sommerfest'])
    expect(ueber.events[0].abPreisCent).toBe(1500)
  })

  it('Prüfungen: Mindestalter am Eventtag, Höchstmenge, nur Online-Arten, Zustimmung', async () => {
    const jung = await bestelle(bestellung([gast(normalId, 30), gast(normalId, 15)]))
    expect(jung.statusCode).toBe(422)
    expect(jung.json().fehler).toMatch(/Ticket 2: Mindestalter 16/)

    const zuViele = await bestelle(bestellung(Array.from({ length: 5 }, () => gast(normalId))))
    expect(zuViele.statusCode).toBe(400)
    expect(zuViele.json().fehler).toMatch(/Höchstens 4/)

    expect((await bestelle(bestellung([gast(internId)]))).statusCode).toBe(400)
    const ohneZustimmung = await bestelle(bestellung([gast(normalId)], { agbAkzeptiert: false }))
    expect(ohneZustimmung.statusCode).toBe(400)
    expect(ohneZustimmung.json().fehler).toMatch(/zustimmen/)

    // Nichts davon hat Tickets reserviert
    expect(await idb.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.eventId, eventId))).toHaveLength(0)
  })

  let bezahltId: string
  it('Bestellen reserviert die Tickets (unsichtbar, zählen im Kontingent) und öffnet die Bezahlseite', async () => {
    const res = await bestelle(bestellung([gast(normalId, 30, 'Anna'), gast(normalId, 17, 'Ben'), gast(vipId, 40)]))
    expect(res.statusCode).toBe(201)
    const { bestellungId, checkoutUrl } = res.json()
    bezahltId = bestellungId
    expect(checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\/cs_test_/)

    const [sid, s] = sessionFuer(bestellungId)!
    expect(s.email).toBe('karin@example.at')
    expect(s.successUrl).toBe(`https://tickets.test.at/b/${bestellungId}`)
    const row = await bestellRow(bestellungId)
    expect(row).toMatchObject({ status: 'zahlung', summeCent: 11000, stripeSessionId: sid })
    expect(Math.abs(row.reserviertBis.getTime() - s.laeuftAbAt.getTime())).toBeLessThan(1000)
    expect(row.reserviertBis.getTime() - Date.now()).toBeGreaterThan(31 * 60_000)

    const reserviert = await ticketsDer(bestellungId)
    expect(reserviert).toHaveLength(3)
    expect(reserviert.every(t => t.status === 'reserviert')).toBe(true)

    // nach außen unsichtbar: Ticketseite 404, Bestellseite ohne Tickets, Backoffice-Liste ohne sie
    expect((await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/ticket/${reserviert[0]!.code}` })).statusCode).toBe(404)
    const stand = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/bestellungen/${bestellungId}` })).json()
    expect(stand).toMatchObject({ status: 'zahlung', tickets: [], emailMaskiert: 'k…@example.at' })
    const liste = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventId}/tickets`, headers: auth(1) })).json()
    expect(liste).toHaveLength(0)

    // Kontingent: 2 von 5 „Normal" vergeben
    const e = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/events/${eventId}` })).json()
    expect(e.arten[0].verfuegbar).toBe(3)
  })

  it('Fremdes Stripe-Konto und fremde Session können die Bestellung nicht als bezahlt melden', async () => {
    const [sid] = sessionFuer(bezahltId)!
    const fremdesKonto = await webhook(2, 'checkout.session.completed', { id: sid, payment_status: 'paid', metadata: { ticketBestellungId: bezahltId } })
    expect(fremdesKonto.statusCode).toBe(200)
    const fremdeSession = await webhook(1, 'checkout.session.completed', { id: 'cs_test_fremd', payment_status: 'paid', metadata: { ticketBestellungId: bezahltId } })
    expect(fremdeSession.statusCode).toBe(200)
    expect((await bestellRow(bezahltId)).status).toBe('zahlung')
  })

  it('Zahlung (Webhook) → RKSV-Beleg je Steuersatz auf der Verkaufskasse, gültige Tickets, Mail mit Tickets + Beleg', async () => {
    const [sid, s] = sessionFuer(bezahltId)!
    s.status = 'complete'; s.bezahlt = true
    gesendet.length = 0
    const res = await webhook(1, 'checkout.session.completed', { id: sid, payment_status: 'paid', metadata: { ticketBestellungId: bezahltId } })
    expect(res.statusCode).toBe(200)

    const row = await bestellRow(bezahltId)
    expect(row.status).toBe('bezahlt')
    expect(row.emailGesendetAt).not.toBeNull()
    const [beleg] = await idb.db.select().from(belege).where(eq(belege.id, row.belegId!))
    expect(beleg).toMatchObject({ kasseId: kasse[1], summeKarteCent: 11000, summeBarCent: 0, betragErmaessigt2Cent: 5000, betragNormalCent: 6000 })
    expect((await ticketsDer(bezahltId)).every(t => t.status === 'gueltig')).toBe(true)

    expect(gesendet).toHaveLength(1)
    const mail = gesendet[0]!
    expect(mail.to).toBe('karin@example.at')
    expect(mail.html).toContain(`Beleg Nr. ${beleg!.belegNummer}`)
    expect(mail.html).toContain(beleg!.maschinenlesbareCode)
    expect(mail.html).toContain(`https://tickets.test.at/b/${bezahltId}`)
    expect((mail.attachments as unknown[]).length).toBe(4)   // 3 QR + PDF

    const stand = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/bestellungen/${bezahltId}` })).json()
    expect(stand).toMatchObject({ status: 'bezahlt', belegNummer: beleg!.belegNummer, emailStatus: 'gesendet' })
    // in der Reihenfolge des Formulars (Ticket 1, 2, 3) — nicht zufällig nach Code
    expect(stand.tickets.map((t: { name: string | null }) => t.name)).toEqual(['Anna', 'Ben', null])

    const rechnung = await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/bestellungen/${bezahltId}/rechnung` })
    expect(rechnung.statusCode).toBe(200)
    expect(rechnung.headers['content-type']).toMatch(/text\/html/)
    expect(rechnung.body).toContain('Shop Test 1 GmbH')
    expect(rechnung.body).not.toContain('window.print')   // Käufer am Handy: kein Druckdialog beim Öffnen
    const pdf = await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/bestellungen/${bezahltId}/pdf` })
    expect(pdf.headers['content-type']).toBe('application/pdf')

    // Ticketseite zeigt das Ticket jetzt
    const code = stand.tickets[0].code
    expect((await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/ticket/${code}` })).statusCode).toBe(200)
  })

  it('Idempotenz: zweite Zustellung erzeugt keinen zweiten Beleg und keine zweite Mail', async () => {
    const [sid] = sessionFuer(bezahltId)!
    const vorher = await bestellRow(bezahltId)
    gesendet.length = 0
    expect((await webhook(1, 'checkout.session.completed', { id: sid, payment_status: 'paid', metadata: { ticketBestellungId: bezahltId } })).statusCode).toBe(200)
    expect((await bestellRow(bezahltId)).belegId).toBe(vorher.belegId)
    expect(gesendet).toHaveLength(0)
  })

  it('Rechnung auf Firma: Firma und UID stehen auf dem Beleg bzw. der Rechnung', async () => {
    const res = await bestelle(bestellung([gast(vipId)], {
      rechnung: { firma: 'Event Partner GmbH', strasse: 'Hauptplatz 1', plz: '4020', ort: 'Linz', uid: 'ATU12345678' },
    }))
    const { bestellungId } = res.json()
    const [sid, s] = sessionFuer(bestellungId)!
    s.status = 'complete'; s.bezahlt = true
    await webhook(1, 'checkout.session.completed', { id: sid, payment_status: 'paid', metadata: { ticketBestellungId: bestellungId } })
    const rechnung = await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/bestellungen/${bestellungId}/rechnung` })
    expect(rechnung.body).toContain('Event Partner GmbH')
    expect(rechnung.body).toContain('ATU12345678')
  })

  it('Kontingent: 20 gleichzeitige Bestellungen auf 3 freie Plätze → genau 3 kommen durch', async () => {
    // 20 statt weniger: erst so überlappen sich die Transaktionen verlässlich —
    // Gegenprobe ohne FOR UPDATE: 5–7 kamen durch (3 von 3 Läufen rot), mit 6 fiel es nie auf.
    const antworten = await Promise.all(Array.from({ length: 20 }, () => bestelle(bestellung([gast(limitId)]))))
    const ok = antworten.filter(r => r.statusCode === 201)
    const voll = antworten.filter(r => r.statusCode === 409)
    expect(ok).toHaveLength(3)
    expect(voll).toHaveLength(17)
    expect(voll[0]!.json().fehler).toMatch(/ausverkauft/)
    const vergeben = await idb.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.ticketArtId, limitId))
    expect(vergeben).toHaveLength(3)

    // Eine Bezahlseite läuft ab (Webhook) → Platz wieder frei, reservierte Tickets gelöscht
    const id = ok[0]!.json().bestellungId as string
    const [sid, s] = sessionFuer(id)!
    s.status = 'expired'
    expect((await webhook(1, 'checkout.session.expired', { id: sid, payment_status: 'unpaid', metadata: { ticketBestellungId: id } })).statusCode).toBe(200)
    expect((await bestellRow(id)).status).toBe('abgelaufen')
    expect(await ticketsDer(id)).toHaveLength(0)
    const e = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/events/${eventId}` })).json()
    expect(e.arten.find((a: { id: string }) => a.id === limitId).verfuegbar).toBe(1)
  })

  it('Abbruch auf der Bezahlseite gibt sofort frei — außer die Session wurde inzwischen bezahlt', async () => {
    const a = (await bestelle(bestellung([gast(vipId)]))).json().bestellungId as string
    const abbruch = await srv.fastify.inject({ method: 'POST', url: `/api/ticketshop/bestellungen/${a}/abbrechen` })
    expect(abbruch.json().status).toBe('abgebrochen')
    expect(sessionFuer(a)![1].status).toBe('expired')
    expect(await ticketsDer(a)).toHaveLength(0)

    // Zweiter Tab hat schon bezahlt: Schließen scheitert, Stripe meldet „complete + bezahlt" → abschließen
    const b = (await bestelle(bestellung([gast(vipId)]))).json().bestellungId as string
    const s = sessionFuer(b)![1]
    s.status = 'complete'; s.bezahlt = true
    const zweiterTab = await srv.fastify.inject({ method: 'POST', url: `/api/ticketshop/bestellungen/${b}/abbrechen` })
    expect(zweiterTab.json().status).toBe('bezahlt')
    expect((await bestellRow(b)).belegId).not.toBeNull()
  })

  it('Verzögerte Zahlart (SEPA): Tickets bleiben reserviert, bis Stripe das Geld meldet', async () => {
    const id = (await bestelle(bestellung([gast(vipId)]))).json().bestellungId as string
    const [sid, s] = sessionFuer(id)!
    s.status = 'complete'
    await webhook(1, 'checkout.session.completed', { id: sid, payment_status: 'unpaid', metadata: { ticketBestellungId: id } })
    const row = await bestellRow(id)
    expect(row.status).toBe('zahlung')
    expect(row.reserviertBis.getTime() - Date.now()).toBeGreaterThan(2 * TAG)

    s.bezahlt = true
    await webhook(1, 'checkout.session.async_payment_succeeded', { id: sid, payment_status: 'paid', metadata: { ticketBestellungId: id } })
    expect((await bestellRow(id)).status).toBe('bezahlt')
  })

  it('Aufräum-Job: fragt Stripe — verfallen → frei, bezahlt → abschließen, noch offen → Seite schließen', async () => {
    const neu = async () => (await bestelle(bestellung([gast(vipId)]))).json().bestellungId as string
    const [verfallen, bezahlt, offen] = [await neu(), await neu(), await neu()]
    sessionFuer(verfallen)![1].status = 'expired'
    Object.assign(sessionFuer(bezahlt)![1], { status: 'complete', bezahlt: true })
    await idb.db.update(ticketBestellungen).set({ reserviertBis: new Date(Date.now() - 20 * 60_000) })
      .where(inArray(ticketBestellungen.id, [verfallen, bezahlt, offen]))

    const ergebnis = await raeumeReservierungenAuf(deps)
    expect(ergebnis).toEqual({ freigegeben: 1, abgeschlossen: 1 })
    expect((await bestellRow(verfallen)).status).toBe('abgelaufen')
    expect((await bestellRow(bezahlt)).status).toBe('bezahlt')
    expect((await bestellRow(offen)).status).toBe('zahlung')
    expect(sessionFuer(offen)![1].status).toBe('expired')   // geschlossen — die nächste Runde gibt frei

    expect(await raeumeReservierungenAuf(deps)).toEqual({ freigegeben: 1, abgeschlossen: 0 })
    expect((await bestellRow(offen)).status).toBe('abgelaufen')
  })

  it('Kostenlose Tickets: ohne Bezahlseite und ohne Beleg sofort gültig', async () => {
    const ev = (await srv.fastify.inject({
      method: 'POST', url: '/api/ticketing/events', headers: auth(1),
      payload: { titel: 'Tag der offenen Tür', beginn: beginn.toISOString(), ort: 'Halle', status: 'veroeffentlicht' },
    })).json()
    const gratis = (await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${ev.id}/arten`, headers: auth(1),
      payload: { bezeichnung: 'Anmeldung', preisCent: 0, mwstSatz: 'ermaessigt2' },
    })).json()
    const res = await bestelle({ ...bestellung([gast(gratis.id, 12)]), eventId: ev.id })
    expect(res.statusCode).toBe(201)
    expect(res.json().checkoutUrl).toBeNull()
    const row = await bestellRow(res.json().bestellungId)
    expect(row).toMatchObject({ status: 'bezahlt', belegId: null, summeCent: 0 })
  })

  it('Backoffice: Bestellliste je Event, erneut senden; fremder Mandant sieht nichts', async () => {
    const liste = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventId}/bestellungen`, headers: auth(1) })).json()
    const b = liste.find((x: { id: string }) => x.id === bezahltId)
    expect(b).toMatchObject({ status: 'bezahlt', anzahlTickets: 3, summeCent: 11000, name: 'Karin Käuferin' })
    expect(b.belegNummer).toBeGreaterThan(0)
    expect(liste.some((x: { status: string }) => x.status === 'abgelaufen')).toBe(true)

    gesendet.length = 0
    const senden = await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/bestellungen/${bezahltId}/senden`, headers: auth(1), payload: { email: 'buero@example.at' },
    })
    expect(senden.statusCode).toBe(200)
    expect(gesendet[0]!.to).toBe('buero@example.at')

    expect((await srv.fastify.inject({ method: 'GET', url: `/api/ticketing/events/${eventId}/bestellungen`, headers: auth(2) })).json()).toEqual([])
    expect((await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/bestellungen/${bezahltId}/senden`, headers: auth(2), payload: {},
    })).statusCode).toBe(404)
  })

  it('Verkaufsfenster: Verkauf erst ab morgen → „startet am …"', async () => {
    const spaeter = (await srv.fastify.inject({
      method: 'POST', url: `/api/ticketing/events/${eventId}/arten`, headers: auth(1),
      payload: { bezeichnung: 'Abendkasse online', preisCent: 3000, mwstSatz: 'ermaessigt2', verkaufAb: new Date(Date.now() + TAG).toISOString() },
    })).json()
    const e = (await srv.fastify.inject({ method: 'GET', url: `/api/ticketshop/events/${eventId}` })).json()
    expect(e.arten.find((a: { id: string }) => a.id === spaeter.id).status).toBe('noch_nicht')
    const res = await bestelle(bestellung([gast(spaeter.id)]))
    expect(res.statusCode).toBe(409)
    expect(res.json().fehler).toMatch(/startet am/)
    const offen = await idb.db.select().from(tickets).where(and(eq(tickets.ticketArtId, spaeter.id)))
    expect(offen).toHaveLength(0)
  })
})
