/**
 * Integrationstest: Modifikatoren gegen echtes PostgreSQL.
 *
 * Prüft die serverseitige Funktionalität: Gruppen (Pflicht/Optional) + Optionen
 * mit Aufschlag und Bestand anlegen, Artikel-Zuordnung, Verschachtelung
 * (Gruppe -> Optionen), Aktualisieren/Löschen.
 *
 * (Die Einrechnung des Aufschlags in die Belegsumme passiert im Frontend-
 *  Warenkorb; Backend speichert/liefert die Stammdaten.)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { ModifikatorGruppe } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@modifikator.at'
const ADMIN_PASSWORT = 'modifikator-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Modifikator GmbH',
  uid:        'ATU99999909',
  kassenId:   'MOD-001',
  finanzOnline: { teilnehmerId: 'TID-MOD', benutzerkennung: 'BID-MOD', pin: 'PIN-MOD' },
  umgebung: 'test',
  admin: { name: 'MOD Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Modifikatoren (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let gruppeId = ''
  let artikelId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    token = loginRes.json().token

    const a = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Burger', preisBruttoCent: 990, mwstSatz: 'normal' },
    })
    artikelId = a.json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert Modifikator-Gruppen ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen' })
    expect(res.statusCode).toBe(401)
  })

  it('legt eine Pflicht-Gruppe mit Optionen (Aufschlag + Bestand) an', async () => {
    const g = await srv.fastify.inject({
      method: 'POST', url: '/api/modifikator-gruppen', headers: auth(),
      payload: { name: 'Beilage', typ: 'pflicht', reihenfolge: 0 },
    })
    expect(g.statusCode).toBe(201)
    gruppeId = g.json().id
    expect(g.json().typ).toBe('pflicht')

    const o1 = await srv.fastify.inject({
      method: 'POST', url: `/api/modifikator-gruppen/${gruppeId}/modifikatoren`, headers: auth(),
      payload: { name: 'Pommes', aufschlagCent: 150, lagerstandMenge: 100 },
    })
    expect(o1.statusCode).toBe(201)
    const o2 = await srv.fastify.inject({
      method: 'POST', url: `/api/modifikator-gruppen/${gruppeId}/modifikatoren`, headers: auth(),
      payload: { name: 'Salat', aufschlagCent: 250 },
    })
    expect(o2.statusCode).toBe(201)

    // Gruppe enthält jetzt beide Optionen mit korrektem Aufschlag/Bestand
    const liste = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen', headers: auth() })
    const gruppe = (liste.json() as ModifikatorGruppe[]).find(x => x.id === gruppeId)!
    expect(gruppe.modifikatoren).toHaveLength(2)
    const pommes = gruppe.modifikatoren.find(m => m.name === 'Pommes')!
    expect(pommes.aufschlagCent).toBe(150)
    expect(pommes.lagerstandMenge).toBe(100)
    expect(gruppe.modifikatoren.find(m => m.name === 'Salat')!.aufschlagCent).toBe(250)
  })

  it('ordnet die Gruppe einem Artikel zu und liefert sie verschachtelt zurück', async () => {
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/artikel/${artikelId}/modifikator-gruppen`, headers: auth(),
      payload: { gruppenIds: [gruppeId] },
    })
    expect(put.statusCode).toBe(200)

    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/artikel/${artikelId}/modifikator-gruppen`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const gruppen = res.json() as ModifikatorGruppe[]
    const zugeordnet = gruppen.find(g => g.id === gruppeId)
    expect(zugeordnet).toBeDefined()
    expect(zugeordnet!.modifikatoren).toHaveLength(2)
  })

  it('aktualisiert den Aufschlag einer Option', async () => {
    const liste = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen', headers: auth() })
    const pommes = (liste.json() as ModifikatorGruppe[]).find(g => g.id === gruppeId)!.modifikatoren.find(m => m.name === 'Pommes')!

    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/modifikatoren/${pommes.id}`, headers: auth(),
      payload: { aufschlagCent: 200 },
    })
    expect(patch.statusCode).toBe(200)

    const danach = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen', headers: auth() })
    const neu = (danach.json() as ModifikatorGruppe[]).find(g => g.id === gruppeId)!.modifikatoren.find(m => m.name === 'Pommes')!
    expect(neu.aufschlagCent).toBe(200)
  })

  it('löscht eine Option und dann die Gruppe', async () => {
    const liste = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen', headers: auth() })
    const salat = (liste.json() as ModifikatorGruppe[]).find(g => g.id === gruppeId)!.modifikatoren.find(m => m.name === 'Salat')!

    const delOpt = await srv.fastify.inject({ method: 'DELETE', url: `/api/modifikatoren/${salat.id}`, headers: auth() })
    expect([200, 204]).toContain(delOpt.statusCode)

    const nachOpt = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen', headers: auth() })
    expect((nachOpt.json() as ModifikatorGruppe[]).find(g => g.id === gruppeId)!.modifikatoren).toHaveLength(1)

    const delGrp = await srv.fastify.inject({ method: 'DELETE', url: `/api/modifikator-gruppen/${gruppeId}`, headers: auth() })
    expect([200, 204]).toContain(delGrp.statusCode)
    const nachGrp = await srv.fastify.inject({ method: 'GET', url: '/api/modifikator-gruppen', headers: auth() })
    expect((nachGrp.json() as ModifikatorGruppe[]).some(g => g.id === gruppeId)).toBe(false)
  })
})
