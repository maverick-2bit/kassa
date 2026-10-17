/**
 * Integrationstest: Mandant von einer Kassa-Datenbank in eine andere übertragen.
 *
 * Quelle und Ziel haben je einen eigenen Mandanten (per /api/setup) und
 * verschiedene MASTER_PASSPHRASEs. Geprüft wird: Der übertragene Mandant steht
 * neben dem vorhandenen, der Admin kann sich im Ziel anmelden, die Signatur-
 * schlüssel sind mit der Ziel-Passphrase neu verschlüsselt (aber derselbe Inhalt),
 * der zweite Import desselben Mandanten wird abgelehnt und nichts geht verloren.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen, belege, mandanten } from '../../src/db/schema.js'
import { decryptPrivateKey } from '../../src/crypto/master-key.js'
import { exportiereMandant, importiereMandant } from '../../src/services/mandant-transfer.service.js'

import { TEST_MASTER } from '../helpers/testServer.js'
const QUELL_PASS = TEST_MASTER
const ZIEL_PASS  = 'ziel-passphrase-ganz-anders-2'

const fo = () => ({
  kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
  startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'FO-PW' }),
  kasseAusserBetriebNehmen: vi.fn(),
}) as unknown as FinanzOnlineClient

const setup = (firma: string, uid: string, kassenId: string, email: string) => ({
  firmenname: firma, uid, kassenId, umgebung: 'test',
  admin: { name: 'Admin', email, passwort: 'transfer-passwort-123' },
})

describe('Mandanten-Transfer (Integration)', () => {
  let quelle: IntegrationsDb, ziel: IntegrationsDb
  let quellSrv: TestServer, zielSrv: TestServer
  let quellSql: ReturnType<typeof postgres>, zielSql: ReturnType<typeof postgres>
  let quellMandant: string

  beforeAll(async () => {
    quelle = await erstelleIntegrationsDb()
    ziel   = await erstelleIntegrationsDb()
    quellSrv = await buildTestServer(quelle.db, { finanzOnlineClient: fo() })
    zielSrv  = await buildTestServer(ziel.db,   { finanzOnlineClient: fo() })
    for (const [srv, p] of [
      [quellSrv, setup('Laptop-Test GmbH', 'ATU11111111', 'LAPTOP-1', 'laptop@transfer.at')],
      [zielSrv,  setup('PC-Bestand GmbH',  'ATU22222222', 'PC-1',     'pc@transfer.at')],
    ] as const) {
      const r = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: p })
      if (r.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${r.body}`)
    }
    quellMandant = (await quelle.db.select().from(mandanten))[0]!.id
    quellSql = postgres(quelle.url, { max: 2, onnotice: () => {}, fetch_types: false })
    zielSql  = postgres(ziel.url,   { max: 2, onnotice: () => {}, fetch_types: false })
  })

  afterAll(async () => {
    await quellSql?.end(); await zielSql?.end()
    await quellSrv?.close(); await zielSrv?.close()
    await quelle?.zerstoeren(); await ziel?.zerstoeren()
  })

  it('überträgt den Mandanten neben den vorhandenen und verschlüsselt die Schlüssel neu', async () => {
    const export_ = await exportiereMandant(quellSql, quellMandant, QUELL_PASS)
    // JSON-Weg wie im echten Ablauf (Datei)
    const daten = JSON.parse(JSON.stringify(export_))
    expect(Object.keys(daten.tabellen)).toEqual(expect.arrayContaining(['mandanten', 'kassen', 'users', 'belege']))

    const bericht = await importiereMandant(zielSql, daten, ZIEL_PASS)
    expect(bericht.zeilen['kassen']).toBeGreaterThan(0)

    // zwei Mandanten im Ziel
    expect((await ziel.db.select().from(mandanten)).map(m => m.firmenname).sort())
      .toEqual(['Laptop-Test GmbH', 'PC-Bestand GmbH'])

    // Belege vollständig
    const nQuelle = (await quelle.db.select().from(belege).where(eq(belege.mandantId, quellMandant))).length
    const nZiel   = (await ziel.db.select().from(belege).where(eq(belege.mandantId, quellMandant))).length
    expect(nZiel).toBe(nQuelle)
    expect(nZiel).toBeGreaterThan(0)

    // Schlüssel: anderer Chiffretext, gleicher Inhalt, nur mit Ziel-Passphrase lesbar
    const kq = (await quelle.db.select().from(kassen).where(eq(kassen.mandantId, quellMandant)))[0]!
    const kz = (await ziel.db.select().from(kassen).where(eq(kassen.mandantId, quellMandant)))[0]!
    expect(kz.seePrivateKeyEnc).not.toBe(kq.seePrivateKeyEnc)
    expect(decryptPrivateKey(kz.seePrivateKeyEnc, ZIEL_PASS).equals(decryptPrivateKey(kq.seePrivateKeyEnc, QUELL_PASS))).toBe(true)
    expect(() => decryptPrivateKey(kz.seePrivateKeyEnc, QUELL_PASS)).toThrow()

    // Admin der Quelle meldet sich im Ziel an; der vorhandene Admin ebenso
    for (const email of ['laptop@transfer.at', 'pc@transfer.at']) {
      const login = await zielSrv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email, passwort: 'transfer-passwort-123' },
      })
      expect(login.statusCode, email).toBe(200)
    }
  })

  it('lehnt einen zweiten Import desselben Mandanten ab', async () => {
    const daten = JSON.parse(JSON.stringify(await exportiereMandant(quellSql, quellMandant, QUELL_PASS)))
    await expect(importiereMandant(zielSql, daten, ZIEL_PASS)).rejects.toThrow(/existiert in dieser Kassa bereits/)
  })

  it('rollt komplett zurück, wenn Daten auf Fehlendes verweisen', async () => {
    const daten = JSON.parse(JSON.stringify(await exportiereMandant(quellSql, quellMandant, QUELL_PASS)))
    // neue Mandanten-ID, aber alle übrigen IDs kollidieren mit dem Bestand
    const neuId = '99999999-9999-4999-8999-999999999999'
    daten.mandantId = neuId
    for (const z of daten.tabellen['mandanten']) z.id = neuId
    const bestand = (await ziel.db.select().from(mandanten)).length
    // IDs aller anderen Tabellen kollidieren → Fehler aus der Datenbank, nichts bleibt zurück
    await expect(importiereMandant(zielSql, daten, ZIEL_PASS)).rejects.toThrow()
    expect((await ziel.db.select().from(mandanten)).length).toBe(bestand)
  })
})
