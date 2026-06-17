/**
 * Integrationstest: Kunden + Offene Posten (Kredit/Anschreiben) gegen echtes
 * PostgreSQL.
 *
 * Geld-kritisch. Prüft: Kunde anlegen, offenen Posten erfassen (Saldo),
 * Teil-/Voll-Zahlung + Status, keine Über-/Doppelzahlung, Statistik,
 * Beleg↔Kunde-Verknüpfung.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { OffenerPostenResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@offeneposten.at'
const ADMIN_PASSWORT = 'offeneposten-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Offene-Posten GmbH',
  uid:        'ATU99999912',
  kassenId:   'OP-001',
  finanzOnline: { teilnehmerId: 'TID-OP', benutzerkennung: 'BID-OP', pin: 'PIN-OP' },
  umgebung: 'test',
  admin: { name: 'OP Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Kunde + Offene Posten (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let kundeId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function neuerKunde(nachname: string): Promise<string> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/kunden', headers: auth(),
      payload: { nachname, ort: 'Wien' },
    })
    if (r.statusCode !== 201) throw new Error(`Kunde (${r.statusCode}): ${r.body}`)
    return r.json().id
  }

  async function neuerPosten(betragCent: number, kunde = kundeId): Promise<OffenerPostenResponse> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/offene-posten', headers: auth(),
      payload: { kundeId: kunde, betragCent },
    })
    if (r.statusCode !== 201) throw new Error(`Offener Posten (${r.statusCode}): ${r.body}`)
    return r.json() as OffenerPostenResponse
  }

  const zahlung = (id: string, zahlungCent: number) =>
    srv.fastify.inject({
      method: 'POST', url: `/api/offene-posten/${id}/zahlung`, headers: auth(),
      payload: { zahlungCent },
    })

  const statistik = async () =>
    (await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten/statistik', headers: auth() }))
      .json() as { anzahl: number; gesamtRestCent: number }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id
    kundeId = await neuerKunde('Mustermann')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert offene Posten ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten' })
    expect(res.statusCode).toBe(401)
  })

  it('legt einen offenen Posten für einen Kunden an', async () => {
    const op = await neuerPosten(5000)
    expect(op.status).toBe('offen')
    expect(op.betragCent).toBe(5000)
    expect(op.bezahltCent).toBe(0)
    expect(op.restCent).toBe(5000)
    expect(op.kundeId).toBe(kundeId)
  })

  it('verbucht Teil- und Restzahlung mit korrektem Status', async () => {
    const op = await neuerPosten(5000)

    const teil = await zahlung(op.id, 2000)
    expect(teil.statusCode).toBe(200)
    const nachTeil = teil.json() as OffenerPostenResponse
    expect(nachTeil.bezahltCent).toBe(2000)
    expect(nachTeil.restCent).toBe(3000)
    expect(nachTeil.status).toBe('teilbezahlt')

    const rest = await zahlung(op.id, 3000)
    const nachVoll = rest.json() as OffenerPostenResponse
    expect(nachVoll.restCent).toBe(0)
    expect(nachVoll.status).toBe('bezahlt')

    // weitere Zahlung auf bezahlten Posten -> 400
    expect((await zahlung(op.id, 100)).statusCode).toBe(400)
  })

  it('weist Überzahlung ab und lässt den Posten unverändert (400)', async () => {
    const op = await neuerPosten(1000)
    const res = await zahlung(op.id, 1500)
    expect(res.statusCode).toBe(400)
    const unveraendert = await srv.fastify.inject({
      method: 'GET', url: `/api/offene-posten/${op.id}`, headers: auth(),
    })
    expect((unveraendert.json() as OffenerPostenResponse).restCent).toBe(1000)
  })

  it('Statistik zählt nur nicht-bezahlte Posten und summiert den Restbetrag', async () => {
    const vorher = await statistik()
    await neuerPosten(4444)   // bleibt offen
    const nachher = await statistik()
    expect(nachher.anzahl).toBe(vorher.anzahl + 1)
    expect(nachher.gesamtRestCent).toBe(vorher.gesamtRestCent + 4444)
  })

  it('verknüpft eine Barzahlung mit einem Kunden (Kundenbelege)', async () => {
    const kunde2 = await neuerKunde('Beleg-Kunde')
    const beleg = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Artikel', preisBruttoCent: 700, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 700, karteCent: 0, sonstigeCent: 0 },
        kundeId: kunde2,
      },
    })
    expect(beleg.statusCode).toBe(201)

    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kunden/${kunde2}/belege`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as unknown[]).length).toBeGreaterThanOrEqual(1)
  })
})
