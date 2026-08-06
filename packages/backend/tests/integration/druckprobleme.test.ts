/**
 * Integrationstest: offene Druckprobleme (GET /kassen/:id/druckprobleme).
 *
 * Der Autodruck des Kundenbelegs läuft fire-and-forget mit Retry. Scheitern
 * alle Versuche, stand das bisher nur im Druck-Log — die Kassa meldete Erfolg,
 * der Gast bekam keinen Beleg (RKSV-Belegerteilungspflicht). Dieser Endpoint
 * macht genau diese Fälle sichtbar.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { BelegResponse } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { druckLog } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@druckprobleme.at'
const ADMIN_PASSWORT = 'druckprobleme-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Druckprobleme GmbH',
  uid:        'ATU99999920',
  kassenId:   'DP-001',
  finanzOnline: { teilnehmerId: 'TID-DP', benutzerkennung: 'BID-DP', pin: 'PIN-DP' },
  umgebung: 'test',
  admin: { name: 'DP Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

const stundenHer = (h: number) => new Date(Date.now() - h * 3_600_000)

describe('Offene Druckprobleme (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let mandantId: string
  let belegA: BelegResponse
  let belegB: BelegResponse

  const auth = () => ({ authorization: `Bearer ${token}` })

  const probleme = (id = kasseId) =>
    srv.fastify.inject({ method: 'GET', url: `/api/kassen/${id}/druckprobleme`, headers: auth() })

  async function log(opt: {
    belegId?: string; erfolg: boolean; typ?: string; vorStunden?: number; fehler?: string
  }) {
    await idb.db.insert(druckLog).values({
      mandantId,
      kasseId,
      druckerIp:  '192.168.1.50',
      druckerTyp: opt.typ ?? 'bon',
      ...(opt.belegId ? { belegId: opt.belegId } : {}),
      erfolg:     opt.erfolg,
      erstelltAt: stundenHer(opt.vorStunden ?? 0),
      ...(opt.fehler ? { fehlerText: opt.fehler } : {}),
    })
  }

  async function barzahlung(betragCent: number): Promise<BelegResponse> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Artikel', preisBruttoCent: betragCent, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: betragCent, karteCent: 0, sonstigeCent: 0 },
      },
    })
    if (res.statusCode !== 201) throw new Error(`Barzahlung (${res.statusCode}): ${res.body}`)
    return res.json() as BelegResponse
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    kasseId   = login.kassen[0].id
    mandantId = login.mandant.id

    belegA = await barzahlung(1234)
    belegB = await barzahlung(500)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('meldet nichts, solange kein Druck fehlgeschlagen ist', async () => {
    const res = await probleme()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('meldet einen Beleg, dessen Bon nicht gedruckt wurde', async () => {
    await log({ belegId: belegA.id, erfolg: false, fehler: 'connect ECONNREFUSED 192.168.1.50:9100' })

    const liste = (await probleme()).json()
    expect(liste).toHaveLength(1)
    expect(liste[0].belegId).toBe(belegA.id)
    expect(liste[0].belegNummer).toBe(belegA.belegNummer)
    expect(liste[0].summeCent).toBe(1234)
    expect(liste[0].fehlerText).toContain('ECONNREFUSED')   // Grund muss anzeigbar sein
    expect(liste[0].druckerIp).toBe('192.168.1.50')
  })

  it('lässt das Problem verschwinden, sobald ein späterer Versuch klappt', async () => {
    // So verhält sich der Retry (2 s/10 s/30 s) und der manuelle Nachdruck —
    // deshalb zählt je Beleg nur der JÜNGSTE Eintrag.
    await log({ belegId: belegA.id, erfolg: true })
    expect((await probleme()).json()).toEqual([])
  })

  it('meldet erneut, wenn nach einem Erfolg wieder ein Versuch scheitert', async () => {
    await log({ belegId: belegA.id, erfolg: false, fehler: 'Papier leer' })
    const liste = (await probleme()).json()
    expect(liste).toHaveLength(1)
    expect(liste[0].fehlerText).toBe('Papier leer')
  })

  it('ignoriert Bonierbons — die haben ihre eigene Meldung an der Kasse', async () => {
    await log({ belegId: belegB.id, erfolg: false, typ: 'bonierbon', fehler: 'Küche offline' })
    const liste = (await probleme()).json()
    expect(liste.map((p: { belegId: string }) => p.belegId)).toEqual([belegA.id])
  })

  it('ignoriert alte Fehlschläge (älter als 24 h)', async () => {
    await log({ belegId: belegB.id, erfolg: false, vorStunden: 30, fehler: 'vorgestern' })
    const liste = (await probleme()).json()
    expect(liste.map((p: { belegId: string }) => p.belegId)).toEqual([belegA.id])
  })

  it('verweigert eine fremde Kasse (404) und den Zugriff ohne Token (401)', async () => {
    expect((await probleme('11111111-1111-1111-1111-111111111111')).statusCode).toBe(404)
    const ohne = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/druckprobleme` })
    expect(ohne.statusCode).toBe(401)
  })
})
