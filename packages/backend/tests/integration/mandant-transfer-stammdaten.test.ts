/**
 * Integrationstest: Mandanten-Transfer mit echten Stammdaten — Warengruppen (inkl. Untergruppe),
 * Artikel in diesen Gruppen und Kunden. Prüft, dass alles ankommt, die Verknüpfungen
 * (Untergruppe → Hauptgruppe, Artikel → Warengruppe) erhalten bleiben und die vorhandenen
 * Daten des Ziel-Mandanten weder verändert noch mit dem übertragenen vermischt werden.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import postgres from 'postgres'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { exportiereMandant, importiereMandant } from '../../src/services/mandant-transfer.service.js'

const PW = 'transfer-passwort-123'

const fo = () => ({
  kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
  startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'FO-PW' }),
  kasseAusserBetriebNehmen: vi.fn(),
}) as unknown as FinanzOnlineClient

const setup = (firma: string, uid: string, kassenId: string, email: string) => ({
  firmenname: firma, uid, kassenId, umgebung: 'test', admin: { name: 'Admin', email, passwort: PW },
})

describe('Mandanten-Transfer mit Stammdaten (Integration)', () => {
  let quelle: IntegrationsDb, ziel: IntegrationsDb
  let quellSrv: TestServer, zielSrv: TestServer
  let quellToken = '', zielToken = ''
  let quellMandantId = ''

  const auth = (t: string) => ({ authorization: `Bearer ${t}` })
  const post = async (srv: TestServer, token: string, url: string, payload: unknown) => {
    const r = await srv.fastify.inject({ method: 'POST', url, headers: auth(token), payload: payload as object })
    if (r.statusCode !== 201) throw new Error(`${url} → ${r.statusCode}: ${r.body}`)
    return r.json()
  }
  const get = async (srv: TestServer, token: string, url: string) =>
    (await srv.fastify.inject({ method: 'GET', url, headers: auth(token) })).json()
  const login = async (srv: TestServer, email: string) =>
    (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, passwort: PW } })).json()

  beforeAll(async () => {
    quelle = await erstelleIntegrationsDb()
    ziel   = await erstelleIntegrationsDb()
    quellSrv = await buildTestServer(quelle.db, { finanzOnlineClient: fo() })
    zielSrv  = await buildTestServer(ziel.db,   { finanzOnlineClient: fo() })
    for (const [srv, p] of [
      [quellSrv, setup('Laptop-Test GmbH', 'ATU11111111', 'LAPTOP-1', 'laptop@stamm.at')],
      [zielSrv,  setup('PC-Bestand GmbH',  'ATU22222222', 'PC-1',     'pc@stamm.at')],
    ] as const) {
      const r = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: p })
      if (r.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${r.body}`)
    }
    const ql = await login(quellSrv, 'laptop@stamm.at')
    quellToken = ql.token; quellMandantId = ql.mandant.id
    zielToken = (await login(zielSrv, 'pc@stamm.at')).token

    // Quelle: Hauptgruppe, Untergruppe, zwei Artikel, ein Kunde
    const getraenke = await post(quellSrv, quellToken, '/api/kategorien', { name: 'Getränke', farbe: 'rot', reihenfolge: 1 })
    const bier      = await post(quellSrv, quellToken, '/api/kategorien', { name: 'Bier', farbe: 'orange', reihenfolge: 1, parentId: getraenke.id })
    await post(quellSrv, quellToken, '/api/artikel', { bezeichnung: 'Pils 0,5', preisBruttoCent: 450, mwstSatz: 'normal', kategorieId: bier.id, allergene: '' })
    await post(quellSrv, quellToken, '/api/artikel', { bezeichnung: 'Cola 0,33', preisBruttoCent: 380, mwstSatz: 'normal', kategorieId: getraenke.id, allergene: '' })
    await post(quellSrv, quellToken, '/api/kunden', { firma: 'Muster GmbH', email: 'office@muster.at', ort: 'Wien' })

    // Ziel hat schon eigene Stammdaten, die unberührt bleiben müssen
    const pcGruppe = await post(zielSrv, zielToken, '/api/kategorien', { name: 'PC-Gruppe', farbe: 'blau', reihenfolge: 1 })
    await post(zielSrv, zielToken, '/api/artikel', { bezeichnung: 'PC-Artikel', preisBruttoCent: 100, mwstSatz: 'normal', kategorieId: pcGruppe.id, allergene: '' })
    await post(zielSrv, zielToken, '/api/kunden', { firma: 'PC-Kunde', ort: 'Graz' })
  })

  afterAll(async () => {
    await quellSrv?.close(); await zielSrv?.close()
    await quelle?.zerstoeren(); await ziel?.zerstoeren()
  })

  it('Warengruppen, Artikel und Kunden kommen mit allen Verknüpfungen an', async () => {
    const q = postgres(quelle.url, { max: 1, onnotice: () => {}, fetch_types: false })
    const z = postgres(ziel.url,   { max: 1, onnotice: () => {}, fetch_types: false })
    try {
      const daten = JSON.parse(JSON.stringify(await exportiereMandant(q, quellMandantId, TEST_MASTER)))
      expect(daten.tabellen['kategorien']).toHaveLength(2)
      expect(daten.tabellen['artikel']).toHaveLength(2)
      expect(daten.tabellen['kunden']).toHaveLength(1)

      const bericht = await importiereMandant(z, daten, 'ziel-passphrase-ganz-anders-2')
      expect(bericht.zeilen['kategorien']).toBe(2)
      expect(bericht.zeilen['artikel']).toBe(2)
      expect(bericht.zeilen['kunden']).toBe(1)
    } finally {
      await q.end(); await z.end()
    }

    // Als übertragener Admin im Ziel anmelden und die Daten über die normalen Routen lesen
    const l = await login(zielSrv, 'laptop@stamm.at')
    expect(l.mandant.id).toBe(quellMandantId)

    const kategorien = await get(zielSrv, l.token, '/api/kategorien')
    const artikel    = await get(zielSrv, l.token, '/api/artikel')
    const kunden     = await get(zielSrv, l.token, '/api/kunden')

    expect(kategorien.map((k: { name: string }) => k.name).sort()).toEqual(['Bier', 'Getränke'])
    const haupt = kategorien.find((k: { name: string }) => k.name === 'Getränke')
    const bier  = kategorien.find((k: { name: string }) => k.name === 'Bier')
    expect(bier.parentId).toBe(haupt.id)

    const pils = artikel.find((a: { bezeichnung: string }) => a.bezeichnung === 'Pils 0,5')
    const cola = artikel.find((a: { bezeichnung: string }) => a.bezeichnung === 'Cola 0,33')
    expect(pils).toMatchObject({ preisBruttoCent: 450, kategorieId: bier.id })
    expect(cola).toMatchObject({ preisBruttoCent: 380, kategorieId: haupt.id })
    expect(artikel).toHaveLength(2)

    expect(kunden.map((k: { firma: string }) => k.firma)).toEqual(['Muster GmbH'])
  })

  it('der vorhandene Ziel-Mandant behält seine Daten und sieht nichts vom übertragenen', async () => {
    const kategorien = await get(zielSrv, zielToken, '/api/kategorien')
    const artikel    = await get(zielSrv, zielToken, '/api/artikel')
    const kunden     = await get(zielSrv, zielToken, '/api/kunden')
    expect(kategorien.map((k: { name: string }) => k.name)).toEqual(['PC-Gruppe'])
    expect(artikel.map((a: { bezeichnung: string }) => a.bezeichnung)).toEqual(['PC-Artikel'])
    expect(kunden.map((k: { firma: string }) => k.firma)).toEqual(['PC-Kunde'])
  })
})
