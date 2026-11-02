/**
 * Integrationstest: Stripe-Webhook, Gast-Bestellung — das Ereignis muss zur Bestellung passen.
 *
 * Das Ereignis ist signiert, aber nur mit dem Secret DES MANDANTEN IN DER URL (bzw. dem globalen Konto).
 * Wer ein eigenes Stripe-Konto hat, unterschreibt damit beliebige Ereignisse — auch mit der Bestell-ID
 * eines anderen Mandanten. Früher genügte das, um dort eine Bestellung als bezahlt zu finalisieren
 * (RKSV-Beleg, Bon in der Küche, Essen ohne Geld). Jetzt prüft der Webhook wie der Ticketshop:
 * Mandant, Checkout-Session, "paid" und Summe (Positionen + Trinkgeld).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Stripe from 'stripe'
import { count, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { belege, gastBestellungen, kassen } from '../../src/db/schema.js'
import { buildTestServer, TEST_SETUP_TOKEN, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const SECRET_KEY    = 'sk_test_dummy_webhook_key_123'
const SECRET_A      = 'whsec_test_secret_mandant_a_abcdefgh'
const SECRET_B      = 'whsec_test_secret_mandant_b_abcdefgh'
const SECRET_GLOBAL = 'whsec_test_secret_global_abcdefghijk'
/** Die Checkout-Session, die beim Anlegen einer Bestellung am Stripe-Konto entsteht und in der Bestellung steht */
const SESSION_ID    = 'cs_test_1'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'WHP-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

/** Was Stripe in `checkout.session.completed` über die Session meldet — Standard: richtige Session, bezahlt, 4,20 €. */
interface SessionAngaben { id?: string; payment_status?: string; amount_total?: number }

function signierterWebhook(bestellungId: string, secret: string, session: SessionAngaben = {}) {
  const payload = JSON.stringify({
    id: 'evt_test_webhook', object: 'event', type: 'checkout.session.completed',
    data: { object: {
      id: SESSION_ID, object: 'checkout.session', payment_status: 'paid', amount_total: 420,
      ...session, metadata: { bestellungId },
    } },
  })
  const signature = new Stripe(SECRET_KEY).webhooks.generateTestHeaderString({ payload, secret })
  return { payload, signature }
}

const einrichtung = (nr: number) => ({
  firmenname: `Webhook ${nr} GmbH`,
  uid:        `ATU6666660${nr}`,
  kassenId:   `WHP-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-WHP-${nr}`, benutzerkennung: `BID-WHP-${nr}`, pin: `PIN-WHP-${nr}` },
  umgebung: 'test',
  admin: { name: `Admin ${nr}`, email: `admin${nr}@webhook-passt.at`, passwort: 'webhook-passt-123' },
})

describe('Stripe-Webhook: das Ereignis muss zur Gast-Bestellung passen (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer          // ohne globales Stripe-Konto
  let srvGlobal: TestServer    // mit globalem Konto aus der Umgebung (Fallback für Mandanten ohne eigene Keys)
  const m = {} as Record<'A' | 'B' | 'C', { mandantId: string; kasseId: string; artikelId: string }>

  /** Mandant einrichten, Artikel + Online-Gast-Bestellung; eigene Stripe-Keys nur, wenn `secret` angegeben ist. */
  async function mandant(nr: number, secret: string | null): Promise<{ mandantId: string; kasseId: string; artikelId: string }> {
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup', payload: einrichtung(nr),
      ...(nr > 1 ? { headers: { 'x-setup-token': TEST_SETUP_TOKEN } } : {}),
    })
    if (setup.statusCode !== 201) throw new Error(`Setup ${nr}: ${setup.statusCode} ${setup.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: `admin${nr}@webhook-passt.at`, passwort: 'webhook-passt-123' },
    })).json()
    const auth = { authorization: `Bearer ${login.token}` }
    const kasseId = login.kassen[0].id as string
    const [k] = await idb.db.select({ mandantId: kassen.mandantId }).from(kassen).where(eq(kassen.id, kasseId)).limit(1)

    const kat = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth, payload: { name: 'Getraenke', farbe: 'blau', reihenfolge: 0 },
    })
    const art = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth,
      payload: { bezeichnung: 'Cola', preisBruttoCent: 420, mwstSatz: 'normal', kategorieId: kat.json().id },
    })
    const modus = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth, payload: { gastModus: 'online' },
    })
    expect(modus.statusCode).toBe(200)
    if (secret) {
      const patch = await srv.fastify.inject({
        method: 'PATCH', url: '/api/mandanten/stripe', headers: auth, payload: { secretKey: SECRET_KEY, webhookSecret: secret },
      })
      expect(patch.json().eigenesKontoAktiv).toBe(true)
    }
    return { mandantId: k!.mandantId, kasseId, artikelId: art.json().id as string }
  }

  /** Offene Bestellung des Mandanten `wem`; Standard: gehört zur Session `cs_test_1`, 4,20 €. */
  async function bestellung(wem: 'A' | 'B' | 'C', o: { session?: string | null; trinkgeldCent?: number } = {}): Promise<string> {
    const [row] = await idb.db.insert(gastBestellungen).values({
      mandantId: m[wem].mandantId, kasseId: m[wem].kasseId, tischNummer: 'Tisch 1',
      positionen: [{ artikelId: m[wem].artikelId, bezeichnung: 'Cola', menge: 1, preisBruttoCent: 420 }],
      summeCent: 420, trinkgeldCent: o.trinkgeldCent ?? 0, status: 'zahlung',
      stripeSessionId: o.session === undefined ? SESSION_ID : o.session,
    }).returning()
    return row!.id
  }

  const status = async (id: string) =>
    (await idb.db.select({ status: gastBestellungen.status, belegId: gastBestellungen.belegId })
      .from(gastBestellungen).where(eq(gastBestellungen.id, id)).limit(1))[0]!

  async function sende(server: TestServer, url: string, id: string, secret: string, session: SessionAngaben = {}) {
    const { payload, signature } = signierterWebhook(id, secret, session)
    return server.fastify.inject({
      method: 'POST', url, headers: { 'stripe-signature': signature, 'content-type': 'application/json' }, payload,
    })
  }

  /** Stripe bekommt 200 (ein Retry änderte nichts), die Bestellung bleibt offen und es entsteht kein Beleg. */
  async function sollIgnoriertWerden(res: { statusCode: number }, id: string) {
    expect(res.statusCode).toBe(200)
    const s = await status(id)
    expect(s.status).toBe('zahlung')
    expect(s.belegId).toBeNull()
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    srvGlobal = await buildTestServer(idb.db, {
      finanzOnlineClient: mockFoClient(),
      config: { STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: SECRET_GLOBAL },
    })
    m.A = await mandant(1, SECRET_A)     // eigenes Stripe-Konto
    m.B = await mandant(2, SECRET_B)     // eigenes Stripe-Konto — der "Angreifer": unterschreibt beliebige Ereignisse
    m.C = await mandant(3, null)         // ohne eigenes Konto → globaler Fallback
  })

  afterAll(async () => {
    await srvGlobal?.close()
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Kontrolle: ein passendes Ereignis bezahlt die Bestellung', async () => {
    const id = await bestellung('A')
    const res = await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, id, SECRET_A)
    expect(res.statusCode).toBe(200)
    const s = await status(id)
    expect(s.status).toBe('bezahlt')
    expect(s.belegId).toBeTruthy()
  })

  it('ein Mandant mit eigenem Stripe-Konto kann die Bestellung eines ANDEREN Mandanten nicht als bezahlt melden', async () => {
    const id = await bestellung('A')
    // Mandant B unterschreibt mit SEINEM Secret ein Ereignis mit der Bestell-ID von A
    // (Session, Summe und "paid" stimmen sogar — nur der Mandant nicht)
    const res = await sende(srv, `/api/stripe/webhook/${m.B.mandantId}`, id, SECRET_B)
    await sollIgnoriertWerden(res, id)
  })

  it('eine andere Checkout-Session bezahlt die Bestellung nicht', async () => {
    const id = await bestellung('A')
    const res = await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, id, SECRET_A, { id: 'cs_test_fremd' })
    await sollIgnoriertWerden(res, id)
  })

  it('ohne gespeicherte Checkout-Session ist nichts zu bezahlen', async () => {
    const id = await bestellung('A', { session: null })
    const res = await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, id, SECRET_A)
    await sollIgnoriertWerden(res, id)
  })

  it('"nicht bezahlt" (payment_status) bezahlt nicht', async () => {
    const id = await bestellung('A')
    const res = await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, id, SECRET_A, { payment_status: 'unpaid' })
    await sollIgnoriertWerden(res, id)
  })

  it('eine abweichende Summe bezahlt nicht — das Trinkgeld gehört zur Summe', async () => {
    const zuWenig = await bestellung('A')
    await sollIgnoriertWerden(
      await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, zuWenig, SECRET_A, { amount_total: 1 }), zuWenig)

    const mitTrinkgeld = await bestellung('A', { trinkgeldCent: 50 })
    // 4,20 € gezahlt, aber 4,70 € geschuldet
    await sollIgnoriertWerden(
      await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, mitTrinkgeld, SECRET_A, { amount_total: 420 }), mitTrinkgeld)
    // 4,70 € → bezahlt
    const ok = await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, mitTrinkgeld, SECRET_A, { amount_total: 470 })
    expect(ok.statusCode).toBe(200)
    expect((await status(mitTrinkgeld)).status).toBe('bezahlt')
  })

  it('eine unbekannte Bestell-ID wird ignoriert (200), nichts entsteht', async () => {
    const vorher = (await idb.db.select({ n: count() }).from(belege))[0]!.n
    const res = await sende(srv, `/api/stripe/webhook/${m.A.mandantId}`, '99999999-9999-4999-8999-999999999999', SECRET_A)
    expect(res.statusCode).toBe(200)
    expect((await idb.db.select({ n: count() }).from(belege))[0]!.n).toBe(vorher)
  })

  it('das globale Stripe-Konto bezahlt nur Mandanten OHNE eigenes Konto', async () => {
    // A hat eigene Keys → das globale Konto hat dort nichts zu melden
    const fremd = await bestellung('A')
    await sollIgnoriertWerden(await sende(srvGlobal, '/api/stripe/webhook', fremd, SECRET_GLOBAL), fremd)

    // Kontrolle: C hat keine eigenen Keys → der globale Fallback gilt
    const eigene = await bestellung('C')
    const ok = await sende(srvGlobal, '/api/stripe/webhook', eigene, SECRET_GLOBAL)
    expect(ok.statusCode).toBe(200)
    expect((await status(eigene)).status).toBe('bezahlt')
  })
})
