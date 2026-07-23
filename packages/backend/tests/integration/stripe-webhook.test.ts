/**
 * Integrationstest: Stripe-Webhook-Produktionspfad gegen echtes PostgreSQL.
 *
 * Prüft den *echten* Zahlungspfad (nicht den Demo-Pfad): ein signiertes
 * `checkout.session.completed` an POST /api/stripe/webhook/:mandantId muss die
 * Gast-Bestellung finalisieren → RKSV-Beleg + Status „bezahlt". Netzwerkfrei:
 * Stripe signiert Webhooks per lokalem HMAC (webhooks.generateTestHeaderString).
 *
 * Abgedeckt:
 *  - gültige Signatur + Mandant-eigene (verschlüsselte) Keys → finalisiert
 *  - ungültige Signatur → 400, Bestellung bleibt „zahlung"
 *  - Idempotenz: zweite Zustellung erzeugt keinen zweiten Beleg
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Stripe from 'stripe'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, gastBestellungen, kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@webhook.at'
const ADMIN_PASSWORT = 'webhook-passwort-123'
const SECRET_KEY     = 'sk_test_dummy_webhook_key_123'          // wird vom Finalisieren NICHT benutzt
const WEBHOOK_SECRET = 'whsec_test_secret_abcdefghijklmnop'     // signiert + verifiziert den Webhook

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'WH-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Webhook Test GmbH',
  uid:        'ATU99999904',
  kassenId:   'WH-001',
  finanzOnline: { teilnehmerId: 'TID-WH', benutzerkennung: 'BID-WH', pin: 'PIN-WH' },
  umgebung: 'test',
  admin: { name: 'WH Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

/** Signiertes checkout.session.completed für eine Bestell-ID (byte-genau, damit die HMAC-Prüfung passt). */
function signierterWebhook(bestellungId: string, secret: string): { payload: string; signature: string } {
  const payload = JSON.stringify({
    id:     'evt_test_webhook',
    object: 'event',
    type:   'checkout.session.completed',
    data:   { object: { id: 'cs_test_1', object: 'checkout.session', metadata: { bestellungId } } },
  })
  const signature = new Stripe(SECRET_KEY).webhooks.generateTestHeaderString({ payload, secret })
  return { payload, signature }
}

describe('Stripe-Webhook-Produktionspfad (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string
  let colaId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    const [k] = await idb.db.select({ mandantId: kassen.mandantId }).from(kassen).where(eq(kassen.id, kasseId)).limit(1)
    mandantId = k!.mandantId

    const kat = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'Getraenke', farbe: 'blau', reihenfolge: 0 },
    })
    const a = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Cola', preisBruttoCent: 420, mwstSatz: 'normal', kategorieId: kat.json().id },
    })
    colaId = a.json().id

    // Gast-Bestellung aktivieren + eigene (verschlüsselte) Stripe-Keys hinterlegen
    await srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(), payload: { gastBestellungAktiv: true } })
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/stripe', headers: auth(),
      payload: { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().eigenesKontoAktiv).toBe(true)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  /** Legt eine offene (Status „zahlung") Gast-Bestellung direkt an — ohne echten Stripe-Checkout. */
  async function offeneBestellung(tisch: string): Promise<string> {
    const [row] = await idb.db.insert(gastBestellungen).values({
      mandantId, kasseId, tischNummer: tisch,
      positionen: [{ artikelId: colaId, bezeichnung: 'Cola', menge: 1, preisBruttoCent: 420 }],
      summeCent:  420,
      status:     'zahlung',
    }).returning()
    return row!.id
  }

  it('gültig signiertes checkout.session.completed finalisiert die Bestellung (RKSV-Beleg)', async () => {
    const id = await offeneBestellung('Tisch 1')
    const { payload, signature } = signierterWebhook(id, WEBHOOK_SECRET)

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/stripe/webhook/${mandantId}`,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ received: true })

    const st = (await srv.fastify.inject({ method: 'GET', url: `/api/gast/bestellung/${id}` })).json()
    expect(st.status).toBe('bezahlt')
    expect(st.belegId).toBeTruthy()
    expect(st.beleg?.beleg?.belegNummer).toBeGreaterThan(0)
  })

  it('ungültige Signatur → 400, Bestellung bleibt „zahlung"', async () => {
    const id = await offeneBestellung('Tisch 2')
    const { payload } = signierterWebhook(id, 'whsec_falsches_secret')  // mit falschem Secret signiert

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/stripe/webhook/${mandantId}`,
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      payload,
    })
    expect(res.statusCode).toBe(400)

    const [row] = await idb.db.select({ status: gastBestellungen.status }).from(gastBestellungen).where(eq(gastBestellungen.id, id)).limit(1)
    expect(row!.status).toBe('zahlung')
  })

  it('Idempotenz: zweite Zustellung erzeugt keinen zweiten Beleg', async () => {
    const id = await offeneBestellung('Tisch 3')
    const { payload, signature } = signierterWebhook(id, WEBHOOK_SECRET)
    const headers = { 'stripe-signature': signature, 'content-type': 'application/json' }

    const r1 = await srv.fastify.inject({ method: 'POST', url: `/api/stripe/webhook/${mandantId}`, headers, payload })
    expect(r1.statusCode).toBe(200)
    const [nach1] = await idb.db.select({ belegId: gastBestellungen.belegId }).from(gastBestellungen).where(eq(gastBestellungen.id, id)).limit(1)
    const belegId1 = nach1!.belegId
    expect(belegId1).toBeTruthy()

    const r2 = await srv.fastify.inject({ method: 'POST', url: `/api/stripe/webhook/${mandantId}`, headers, payload })
    expect(r2.statusCode).toBe(200)
    const [nach2] = await idb.db.select({ belegId: gastBestellungen.belegId }).from(gastBestellungen).where(eq(gastBestellungen.id, id)).limit(1)
    expect(nach2!.belegId).toBe(belegId1)   // unveränderter Beleg → keine Doppel-Signierung

    // Genau ein Beleg für diese Bestellung
    const belegeFuerBestellung = await idb.db.select({ id: belege.id }).from(belege).where(and(eq(belege.kasseId, kasseId), eq(belege.id, belegId1!)))
    expect(belegeFuerBestellung).toHaveLength(1)
  })
})
