/**
 * Integrationstest: provisorische Einrichtung ohne FinanzOnline + Nachtrag.
 *
 * Deckt den kompletten Lebenszyklus ab:
 *  - Setup OHNE FinanzOnline-Daten → Kasse provisorisch (bei_fo_registriert=false),
 *    FON-Client wird NICHT kontaktiert.
 *  - Verkauf ist trotzdem möglich (Belege werden regulär signiert).
 *  - fo-status meldet „nicht registriert".
 *  - fo-registrierung trägt die FON-Registrierung nach (SEE+Kasse registrieren,
 *    Startbeleg prüfen) → registriert=true.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@fo-optional.at'
const ADMIN_PASSWORT = 'fo-optional-passwort-123'

const kasseInBetriebNehmen = vi.fn().mockResolvedValue({ erfolgreich: true })
const startbelegPruefen    = vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'FO-NACHTRAG-PW' })

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen,
    startbelegPruefen,
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

// Setup OHNE finanzOnline-Feld → provisorische Einrichtung
const setupInput = {
  firmenname: 'Provisorisch GmbH',
  uid:        'ATU99999905',
  kassenId:   'FO-OPT-001',
  umgebung:   'test',
  admin: { name: 'FO Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Provisorische Einrichtung ohne FinanzOnline (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Setup ohne FON: Kasse ist provisorisch, FON-Client wurde nicht kontaktiert', async () => {
    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    expect(kasse!.bei_fo_registriert).toBe(false)
    expect(kasse!.registriert_am).toBeNull()
    // Bei der provisorischen Einrichtung wird FinanzOnline gar nicht kontaktiert
    expect(kasseInBetriebNehmen).not.toHaveBeenCalled()
    expect(startbelegPruefen).not.toHaveBeenCalled()
  })

  it('fo-status meldet „nicht registriert"', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege/fo-status?kasseId=${kasseId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ registriert: false, registriertAm: null })
  })

  it('provisorische Kasse kann trotzdem kassieren (Beleg wird signiert)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Bier', preisBruttoCent: 500, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(201)
    const beleg = res.json() as BelegResponse
    expect(beleg.gesamtbetragCent).toBe(500)
    expect(beleg.signaturwert).toBeTruthy()
  })

  it('fo-registrierung trägt die FinanzOnline-Registrierung nach', async () => {
    kasseInBetriebNehmen.mockClear()
    startbelegPruefen.mockClear()

    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/fo-registrierung', headers: auth(),
      payload: { kasseId, credentials: { teilnehmerId: 'TID-N', benutzerkennung: 'BID-N', pin: 'PIN-N' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().registriert).toBe(true)

    // FON wurde jetzt kontaktiert: Registrierung + Startbeleg-Prüfung
    expect(kasseInBetriebNehmen).toHaveBeenCalledTimes(1)
    expect(startbelegPruefen).toHaveBeenCalledTimes(1)

    // Kasse ist nun registriert
    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    expect(kasse!.bei_fo_registriert).toBe(true)
    expect(kasse!.registriert_am).not.toBeNull()
    expect(kasse!.fo_pruefwert).toBe('FO-NACHTRAG-PW')
  })

  it('erneuter Nachtrag wird abgelehnt (bereits registriert)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/fo-registrierung', headers: auth(),
      payload: { kasseId, credentials: { teilnehmerId: 'TID-N', benutzerkennung: 'BID-N', pin: 'PIN-N' } },
    })
    expect(res.statusCode).toBe(409)
  })
})
