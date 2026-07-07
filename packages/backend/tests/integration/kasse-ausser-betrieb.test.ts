/**
 * Integrationstest: Kasse RKSV-konform außer Betrieb nehmen.
 *
 * Deckt ab:
 *  - Stilllegung erstellt einen signierten Schlussbeleg (letzter Beleg,
 *    Kette bleibt valide) und setzt status='ausser_betrieb' + ausser_betrieb_am.
 *  - Danach ist KEINE Belegerstellung mehr möglich (409).
 *  - Ohne FON-Zugangsdaten wird FinanzOnline nicht kontaktiert; mit
 *    Zugangsdaten wird kasseAusserBetriebNehmen aufgerufen.
 *  - Die letzte aktive Kasse kann nicht stillgelegt werden (409).
 *  - Login-Kassenliste enthält die stillgelegte Kasse nicht mehr,
 *    GET /kassen (Verwaltung) schon.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, asc, eq } from 'drizzle-orm'
import { pruefeKette, type FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen, belege } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@ausser-betrieb.at'
const ADMIN_PASSWORT = 'ausser-betrieb-passwort-123'

const kasseInBetriebNehmen     = vi.fn().mockResolvedValue({ erfolgreich: true })
const startbelegPruefen        = vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'PW' })
const kasseAusserBetriebNehmen = vi.fn().mockResolvedValue({ erfolgreich: true })

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen,
    startbelegPruefen,
    kasseAusserBetriebNehmen,
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Stilllegung GmbH',
  uid:        'ATU99999907',
  kassenId:   'AB-KASSE-001',
  umgebung:   'test',
  admin: { name: 'AB Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Kasse außer Betrieb nehmen (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let ersteKasseId: string
  let zweiteKasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function legeKasseAn(kassenId: string, mitFon = false): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: auth(),
      payload: {
        kassenId, umgebung: 'test',
        ...(mitFon && { finanzOnline: { teilnehmerId: 'TID', benutzerkennung: 'BID', pin: 'PIN' } }),
      },
    })
    if (res.statusCode !== 201) throw new Error(`Kasse ${kassenId} anlegen fehlgeschlagen: ${res.body}`)
    return res.json().kasseId
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token        = login.token
    ersteKasseId = login.kassen[0].id

    // Zweite Kasse (FON-registriert), die stillgelegt wird
    zweiteKasseId = await legeKasseAn('AB-KASSE-002', true)
    kasseAusserBetriebNehmen.mockClear()
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Stilllegung ohne FON-Daten: Schlussbeleg + status, FON nicht kontaktiert', async () => {
    // Vorher einen Umsatzbeleg erstellen, damit die Kette mehr als den Startbeleg hat
    const bar = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId: zweiteKasseId,
        positionen: [{ bezeichnung: 'Bier', preisBruttoCent: 500, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(bar.statusCode).toBe(201)

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${zweiteKasseId}/ausser-betrieb`, headers: auth(),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.schlussbeleg.belegTyp).toBe('Schlussbeleg')
    expect(body.schlussbeleg.signaturwert).toBeTruthy()
    expect(body.fonMeldung).toBeUndefined()
    expect(kasseAusserBetriebNehmen).not.toHaveBeenCalled()

    // Status + Zeitstempel gesetzt
    const [k] = await idb.db.select().from(kassen).where(eq(kassen.id, zweiteKasseId))
    expect(k!.status).toBe('ausser_betrieb')
    expect(k!.ausserBetriebAm).not.toBeNull()

    // Schlussbeleg ist der letzte Beleg; Signaturkette der Kasse bleibt valide
    const alle = await idb.db.select().from(belege)
      .where(eq(belege.kasseId, zweiteKasseId)).orderBy(asc(belege.belegNummer))
    expect(alle.at(-1)!.belegTyp).toBe('Schlussbeleg')
    const kettValide = pruefeKette('AB-KASSE-002', alle.map(b => ({
      maschinenlesbareCode: b.maschinenlesbareCode,
      sigVorbeleg:          b.sigVorbeleg,
    })))
    expect(kettValide).toBe(true)
  })

  it('nach der Stilllegung sind keine Belege mehr möglich (409)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId: zweiteKasseId,
        positionen: [{ bezeichnung: 'Bier', preisBruttoCent: 500, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 500, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(409)
  })

  it('erneute Stilllegung wird abgelehnt (bereits außer Betrieb)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${zweiteKasseId}/ausser-betrieb`, headers: auth(),
      payload: {},
    })
    expect(res.statusCode).toBe(409)
  })

  it('Login-Kassenliste ohne stillgelegte Kasse, GET /kassen mit', async () => {
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    expect(login.kassen.map((k: { id: string }) => k.id)).not.toContain(zweiteKasseId)

    const verwaltung = (await srv.fastify.inject({
      method: 'GET', url: '/api/kassen', headers: auth(),
    })).json()
    const stillgelegte = verwaltung.find((k: { id: string }) => k.id === zweiteKasseId)
    expect(stillgelegte).toBeDefined()
    expect(stillgelegte.status).toBe('ausser_betrieb')
    expect(stillgelegte.ausserBetriebAm).toBeTruthy()
  })

  it('mit FON-Zugangsdaten wird die Abmeldung an FinanzOnline gesendet', async () => {
    const dritteId = await legeKasseAn('AB-KASSE-003', true)
    kasseAusserBetriebNehmen.mockClear()

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${dritteId}/ausser-betrieb`, headers: auth(),
      payload: { credentials: { teilnehmerId: 'TID', benutzerkennung: 'BID', pin: 'PIN' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().fonMeldung).toEqual({ versucht: true, erfolgreich: true })
    expect(kasseAusserBetriebNehmen).toHaveBeenCalledTimes(1)
    expect(kasseAusserBetriebNehmen).toHaveBeenCalledWith(
      'AB-KASSE-003',
      { teilnehmerId: 'TID', benutzerkennung: 'BID', pin: 'PIN' },
    )
  })

  it('die letzte aktive Kasse kann nicht stillgelegt werden (409)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/kassen/${ersteKasseId}/ausser-betrieb`, headers: auth(),
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().fehler).toMatch(/letzte aktive/i)

    const [k] = await idb.db.select().from(kassen)
      .where(and(eq(kassen.id, ersteKasseId), eq(kassen.status, 'aktiv')))
    expect(k).toBeDefined()
  })
})
