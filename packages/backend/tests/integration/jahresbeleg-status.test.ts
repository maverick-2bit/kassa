/**
 * Integrationstest: GET /kassen/:id/jahresbeleg-status.
 *
 * Regression: der Jahresbeleg wird erst NACH Ablauf eines Kalenderjahres fällig.
 * Eine im laufenden Jahr angelegte Kasse darf KEINEN Fehlalarm auslösen (früher
 * feuerte der Header-Chip das ganze Jahr, weil im laufenden Jahr noch kein
 * Jahresbeleg existierte).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@jahresbeleg.at'
const ADMIN_PASSWORT = 'jahresbeleg-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'JB-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Jahresbeleg Test GmbH',
  uid:        'ATU99999910',
  kassenId:   'JB-001',
  finanzOnline: { teilnehmerId: 'TID-JB', benutzerkennung: 'BID-JB', pin: 'PIN-JB' },
  umgebung: 'test',
  admin: { name: 'JB Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Jahresbeleg-Status (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const status = async () => (await srv.fastify.inject({
    method: 'GET', url: `/api/kassen/${kasseId}/jahresbeleg-status`, headers: auth(),
  })).json() as { jahr: number; jahresbelegFaellig: boolean; jahresbelegErstelltAm: string | null }

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
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('frisch angelegte Kasse (laufendes Jahr) ist NICHT fällig — kein Fehlalarm', async () => {
    const s = await status()
    expect(s.jahresbelegFaellig).toBe(false)
    expect(s.jahresbelegErstelltAm).toBeNull()
  })

  it('Kasse, die ein Kalenderjahr ohne Jahresbeleg durchlaufen hat, ist fällig', async () => {
    // createdAt auf Mitte des Vorjahres zurückdatieren → Kasse hat das Vorjahr durchlaufen
    const vorjahr = new Date().getFullYear() - 1
    await idb.db
      .update(kassen)
      .set({ createdAt: new Date(Date.UTC(vorjahr, 5, 15)) })
      .where(eq(kassen.id, kasseId))

    const s = await status()
    expect(s.jahresbelegFaellig).toBe(true)
    expect(s.jahr).toBe(vorjahr)
  })
})
