/**
 * Integrationstest: Gänge-Steuerung (Coursing) gegen echtes PostgreSQL.
 *
 * Kern: nächsten Gang feuern (kleinster offener gang>0 → gesendetAm setzen), Sofort-
 * Positionen (gang 0) bleiben unberührt, 409 wenn kein offener Gang, Position
 * nachschicken, Modul-Toggle. Ohne konfigurierten Drucker feuert bonierBestellung
 * „nichts zu bonieren" — das wird geschluckt, die Gang-Statuslogik bleibt prüfbar.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { TabPosition } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL = 'admin@gaenge.at', ADMIN_PASSWORT = 'gaenge-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'GA-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Gaenge GmbH', uid: 'ATU99999904', kassenId: 'GA-001',
  finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
  admin: { name: 'GA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Gänge-Steuerung (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let tabId: string
  let brotId = '', suppeId = '', steakId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })
  const artikel = (bezeichnung: string, katId: string) => srv.fastify.inject({
    method: 'POST', url: '/api/artikel', headers: auth(),
    payload: { bezeichnung, preisBruttoCent: 500, mwstSatz: 'normal', kategorieId: katId },
  }).then(r => r.json().id)

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })).json()
    token = login.token
    kasseId = login.kassen[0].id
    const katId = (await srv.fastify.inject({ method: 'POST', url: '/api/kategorien', headers: auth(), payload: { name: 'Speisen', farbe: 'blau', reihenfolge: 0 } })).json().id
    brotId  = await artikel('Brot', katId)
    suppeId = await artikel('Suppe', katId)
    steakId = await artikel('Steak', katId)

    tabId = (await srv.fastify.inject({ method: 'POST', url: '/api/tisch-tabs', headers: auth(), payload: { kasseId, tischNummer: 'Tisch 1', kellner: 'Anna' } })).json().id

    // Brot = Sofort (gang 0), Suppe = 1. Gang, Steak = 2. Gang
    const positionen: TabPosition[] = [
      { artikelId: brotId,  bezeichnung: 'Brot',  preisBruttoCent: 500, menge: 1, gang: 0 },
      { artikelId: suppeId, bezeichnung: 'Suppe', preisBruttoCent: 500, menge: 1, gang: 1 },
      { artikelId: steakId, bezeichnung: 'Steak', preisBruttoCent: 500, menge: 1, gang: 2 },
    ]
    const patch = await srv.fastify.inject({ method: 'PUT', url: `/api/tisch-tabs/${tabId}/positionen`, headers: auth(), payload: { positionen } })
    expect(patch.statusCode).toBe(200)
  })

  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  const holePositionen = async (): Promise<TabPosition[]> =>
    (await srv.fastify.inject({ method: 'GET', url: `/api/tisch-tabs/${tabId}`, headers: auth() })).json().positionen

  it('Modul-Toggle über /mandanten/module', async () => {
    const patch = await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulGaengeAktiv: true, gaengeAnzahl: 4 } })
    expect(patch.statusCode).toBe(200)
    const mod = (await srv.fastify.inject({ method: 'GET', url: '/api/mandanten/module', headers: auth() })).json()
    expect(mod.modulGaengeAktiv).toBe(true)
    expect(mod.gaengeAnzahl).toBe(4)
  })

  it('gang-abrufen feuert den nächsten offenen Gang (1), Sofort + spätere Gänge bleiben offen', async () => {
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/gang-abrufen`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().gang).toBe(1)

    const pos = await holePositionen()
    const suppe = pos.find(p => p.artikelId === suppeId)!
    const steak = pos.find(p => p.artikelId === steakId)!
    const brot  = pos.find(p => p.artikelId === brotId)!
    expect(suppe.gesendetAm).toBeTruthy()          // Gang 1 gefeuert
    expect(steak.gesendetAm ?? null).toBeNull()    // Gang 2 noch offen
    expect(brot.gesendetAm ?? null).toBeNull()     // Sofort wird NICHT von gang-abrufen gefeuert
  })

  it('zweiter Abruf feuert Gang 2, dritter → 409 (kein offener Gang)', async () => {
    const zwei = await srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/gang-abrufen`, headers: auth() })
    expect(zwei.json().gang).toBe(2)
    expect((await holePositionen()).find(p => p.artikelId === steakId)!.gesendetAm).toBeTruthy()

    const drei = await srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/gang-abrufen`, headers: auth() })
    expect(drei.statusCode).toBe(409)
  })

  it('Position nachschicken (Re-Print) → 204; ungültiger Index → 404', async () => {
    const ok = await srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/position-nachschicken`, headers: auth(), payload: { positionIndex: 1 } })
    expect(ok.statusCode).toBe(204)
    const weg = await srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/position-nachschicken`, headers: auth(), payload: { positionIndex: 99 } })
    expect(weg.statusCode).toBe(404)
  })
})
