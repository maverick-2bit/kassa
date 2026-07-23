/**
 * Integrationstest: Inventur gegen echtes PostgreSQL.
 *
 * Deckt den Kern ab: Anlage snapshottet nur lagergeführte Artikel mit korrektem Soll;
 * Zählung erfasst Ist; Abschluss bucht nur gezählte Positionen absolut auf den
 * Lagerstand (ungezählte bleiben unverändert); zweiter Abschluss = 409.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@inventur.at'
const ADMIN_PASSWORT = 'inventur-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'INV-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Inventur GmbH', uid: 'ATU99999904', kassenId: 'INV-001',
  finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
  admin: { name: 'Inv Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Inventur (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let aId = '', bId = '', cId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function neuerArtikel(bezeichnung: string, katId: string): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung, preisBruttoCent: 100, mwstSatz: 'normal', kategorieId: katId },
    })
    return res.json().id
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    token = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json().token

    const katId = (await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'Lager', farbe: 'blau', reihenfolge: 0 },
    })).json().id

    aId = await neuerArtikel('Artikel A', katId)
    bId = await neuerArtikel('Artikel B', katId)
    cId = await neuerArtikel('Artikel C ohne Lager', katId)

    // A + B lagergeführt (Bestand 10/5), C nicht lagergeführt
    await idb.db.update(artikel).set({ lagerstandAktiv: true, lagerstandMenge: 10 }).where(eq(artikel.id, aId))
    await idb.db.update(artikel).set({ lagerstandAktiv: true, lagerstandMenge: 5 }).where(eq(artikel.id, bId))
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  const bestand = async (id: string): Promise<number | null> => {
    const [row] = await idb.db.select({ m: artikel.lagerstandMenge }).from(artikel).where(eq(artikel.id, id)).limit(1)
    return row!.m
  }

  it('Anlage snapshottet nur lagergeführte Artikel mit korrektem Soll', async () => {
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/inventuren', headers: auth(), payload: {} })
    expect(res.statusCode).toBe(201)
    const { id } = res.json()

    const detail = (await srv.fastify.inject({ method: 'GET', url: `/api/inventuren/${id}`, headers: auth() })).json()
    const artIds = detail.positionen.map((p: { artikelId: string }) => p.artikelId).sort()
    expect(artIds).toEqual([aId, bId].sort())            // C (ohne Lager) fehlt
    const posA = detail.positionen.find((p: { artikelId: string }) => p.artikelId === aId)
    expect(posA.sollMenge).toBe(10)
    expect(posA.istMenge).toBeNull()
    expect(posA.differenz).toBeNull()
  })

  it('Zählen + Abschließen bucht nur gezählte Ist-Mengen auf den Lagerstand', async () => {
    const { id } = (await srv.fastify.inject({ method: 'POST', url: '/api/inventuren', headers: auth(), payload: {} })).json()

    // A auf 8 zählen, B ungezählt lassen
    const patch = await srv.fastify.inject({
      method: 'PATCH', url: `/api/inventuren/${id}/zaehlung`, headers: auth(),
      payload: { positionen: [{ artikelId: aId, istMenge: 8 }] },
    })
    expect(patch.statusCode).toBe(204)

    // Differenz sichtbar: 8 − 10 = −2
    const detail = (await srv.fastify.inject({ method: 'GET', url: `/api/inventuren/${id}`, headers: auth() })).json()
    expect(detail.positionen.find((p: { artikelId: string }) => p.artikelId === aId).differenz).toBe(-2)

    const abschluss = await srv.fastify.inject({ method: 'POST', url: `/api/inventuren/${id}/abschliessen`, headers: auth() })
    expect(abschluss.statusCode).toBe(200)
    expect(abschluss.json()).toEqual({ gebucht: 1, ungezaehlt: 1 })

    expect(await bestand(aId)).toBe(8)   // gezählt → gebucht
    expect(await bestand(bId)).toBe(5)   // ungezählt → unverändert

    // Status abgeschlossen, zweiter Abschluss → 409
    const wieder = await srv.fastify.inject({ method: 'POST', url: `/api/inventuren/${id}/abschliessen`, headers: auth() })
    expect(wieder.statusCode).toBe(409)
  })

  it('unbekannte ID → 404, Zählung auf abgeschlossene Inventur → 409', async () => {
    const unbekannt = await srv.fastify.inject({ method: 'GET', url: '/api/inventuren/00000000-0000-0000-0000-000000000000', headers: auth() })
    expect(unbekannt.statusCode).toBe(404)

    const { id } = (await srv.fastify.inject({ method: 'POST', url: '/api/inventuren', headers: auth(), payload: {} })).json()
    await srv.fastify.inject({ method: 'POST', url: `/api/inventuren/${id}/abschliessen`, headers: auth() })
    const zaehlen = await srv.fastify.inject({
      method: 'PATCH', url: `/api/inventuren/${id}/zaehlung`, headers: auth(),
      payload: { positionen: [{ artikelId: aId, istMenge: 3 }] },
    })
    expect(zaehlen.statusCode).toBe(409)
    void cId
  })

  it('CSV-Protokoll wird als Download geliefert', async () => {
    const { id } = (await srv.fastify.inject({ method: 'POST', url: '/api/inventuren', headers: auth(), payload: {} })).json()
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/inventuren/${id}/protokoll.csv`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toContain('Artikel;Soll;Ist;Differenz')
    expect(res.body).toContain('Artikel A')
  })

  it('ohne Berechtigung artikel.verwalten → 403', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/inventuren',
      headers: { authorization: `Bearer ${srv.signTestToken({ rolle: 'kellner', berechtigungen: [] })}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})
