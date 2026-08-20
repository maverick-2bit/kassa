/**
 * Integrationstest: Kellner-App-Konfiguration (Tischauswahl + Favoriten).
 *
 * Die Kellner-App liest die pos-config und den Tischplan mit einem
 * PIN-Kellner-Token — nicht mit einem Admin-Token. Genau dieser Pfad wird
 * hier abgesichert, damit die Tischauswahl am Handy nicht an einer stillen
 * 401/403 scheitert (Muster der Kellner-Bootstrap-Fälle von v0.7.155/157).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@kellner-konfig.at'
const ADMIN_PASSWORT = 'kellner-konfig-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KK-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Kellner-App-Konfiguration (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Konfig GmbH',
        uid:        'ATU99999927',
        kassenId:   'KK-001',
        finanzOnline: { teilnehmerId: 'TID-KK', benutzerkennung: 'BID-KK', pin: 'PIN-KK' },
        umgebung: 'test',
        admin: { name: 'KK Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('liefert die Standardwerte: Tisch-Betrieb, manuelle Tischwahl, Favoriten aus', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().kellnerModus).toBe('tische')
    expect(res.json().kellnerTischwahl).toBe('manuell')
    expect(res.json().kellnerFavoritenAktiv).toBe(false)
  })

  it('speichert die Betriebsart Theke (und lehnt Unsinn ab)', async () => {
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { kellnerModus: 'theke' },
    })
    expect(put.statusCode).toBe(204)
    const res = (await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
    })).json()
    expect(res.kellnerModus).toBe('theke')

    expect((await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { kellnerModus: 'drivein' },
    })).statusCode).toBe(400)

    // Zurück auf Standard, damit die Folgetests unbeeinflusst bleiben
    await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { kellnerModus: 'tische' },
    })
  })

  it('speichert Tischwahl-Modus und Favoriten-Schalter', async () => {
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { kellnerTischwahl: 'liste', kellnerFavoritenAktiv: true },
    })
    expect(put.statusCode).toBe(204)

    const res = (await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
    })).json()
    expect(res.kellnerTischwahl).toBe('liste')
    expect(res.kellnerFavoritenAktiv).toBe(true)
  })

  it('lehnt einen unbekannten Tischwahl-Modus ab', async () => {
    const res = await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { kellnerTischwahl: 'zauberwuerfel' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('ein PIN-Kellner kann Konfiguration UND Tischplan lesen', async () => {
    // Genau der Pfad der Kellner-App nach dem PIN-Login.
    const anlage = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: {
        name: 'Aushilfe Toni', rolle: 'kellner',
        berechtigungen: ['tische', 'kasse'], kassenIds: [kasseId], pin: '5511',
      },
    })
    expect(anlage.statusCode).toBe(201)

    const pinLogin = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/pin-login', payload: { kasseId, pin: '5511' },
    })
    expect(pinLogin.statusCode).toBe(200)
    const kellnerToken = pinLogin.json().token

    const konfig = await srv.fastify.inject({
      method: 'GET', url: `/api/kassen/${kasseId}/pos-config`,
      headers: { authorization: `Bearer ${kellnerToken}` },
    })
    expect(konfig.statusCode).toBe(200)
    expect(konfig.json().kellnerTischwahl).toBe('liste')

    const plan = await srv.fastify.inject({
      method: 'GET', url: `/api/tischplan/bereiche?kasseId=${kasseId}`,
      headers: { authorization: `Bearer ${kellnerToken}` },
    })
    expect(plan.statusCode).toBe(200)
    expect(Array.isArray(plan.json())).toBe(true)
  })
})
