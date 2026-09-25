/**
 * Integrationstest: Migration 0056 (Gast-Modus je Kasse) übernimmt den Bestand richtig.
 *
 * Vorher gab es nur gast_bestellung_aktiv („mit Online-Zahlung"); ohne ihn nahm jede
 * Kasse Gast-Bestellungen ohne Zahlung an. Die Migration setzt:
 *   gast_bestellung_aktiv            → online
 *   sonst schon Gast-Tab (Kellner „Gast") → tab
 *   sonst                            → aus
 *
 * Der Zustand vor 0056 wird auf einer voll migrierten Wegwerf-DB nachgestellt (alte
 * Spalte zurück, gast_modus weg); danach läuft die 0056-SQL genau wie im Drizzle-Migrator
 * (an den statement-breakpoints getrennt) — zweimal, denn sie muss idempotent sein.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0056_gast_modus.sql')

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Migration Gast GmbH',
  uid:        'ATU99999906',
  kassenId:   'MIG-ONLINE',
  finanzOnline: { teilnehmerId: 'TID-MIG', benutzerkennung: 'BID-MIG', pin: 'PIN-MIG' },
  umgebung: 'test',
  admin: { name: 'Mig Admin', email: 'admin@migration-gast.at', passwort: 'migration-passwort-123' },
}

describe('Migration 0056: Gast-Modus aus dem Bestand (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer

  const fuehreMigrationAus = async () => {
    const teile = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')
    for (const teil of teile) {
      if (teil.trim()) await idb.db.execute(sql.raw(teil))
    }
  }

  const gastModi = async () => {
    const rows = await idb.db.execute<{ kassen_id: string; gast_modus: string }>(
      sql`SELECT kassen_id, gast_modus FROM kassen ORDER BY kassen_id`,
    )
    return Object.fromEntries([...rows].map(r => [r.kassen_id, r.gast_modus]))
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)

    // Drei weitere Kassen als Kopie der ersten (nur id/kassen_id neu). Ein Aufruf = eine
    // Verbindung, sonst sähe der Pool die TEMP-Tabelle nicht.
    await idb.db.execute(sql.raw(`
      CREATE TEMP TABLE kassen_kopie AS SELECT * FROM kassen WHERE kassen_id = 'MIG-ONLINE';
      UPDATE kassen_kopie SET id = gen_random_uuid(), kassen_id = 'MIG-TAB';
      INSERT INTO kassen SELECT * FROM kassen_kopie;
      UPDATE kassen_kopie SET id = gen_random_uuid(), kassen_id = 'MIG-SERVICE';
      INSERT INTO kassen SELECT * FROM kassen_kopie;
      UPDATE kassen_kopie SET id = gen_random_uuid(), kassen_id = 'MIG-NEU';
      INSERT INTO kassen SELECT * FROM kassen_kopie;
      DROP TABLE kassen_kopie;
    `))

    // Zustand vor 0056 nachstellen
    await idb.db.execute(sql.raw(`
      ALTER TABLE kassen ADD COLUMN gast_bestellung_aktiv boolean NOT NULL DEFAULT false;
      ALTER TABLE kassen DROP CONSTRAINT kassen_gast_modus_check;
      ALTER TABLE kassen DROP COLUMN gast_modus;
    `))

    // Bestand: MIG-ONLINE hat Online-Zahlung (und zusätzlich einen alten Gast-Tab),
    // MIG-TAB hat eine Gast-Bestellung ohne Zahlung bekommen, MIG-SERVICE nur Kellner-Tabs.
    await idb.db.execute(sql.raw(`UPDATE kassen SET gast_bestellung_aktiv = true WHERE kassen_id = 'MIG-ONLINE'`))
    await idb.db.execute(sql.raw(`
      INSERT INTO tisch_tabs (mandant_id, kasse_id, tisch_nummer, kellner, positionen, status)
      SELECT mandant_id, id, 'Tisch 3', 'Gast', '[]'::jsonb, 'bezahlt' FROM kassen WHERE kassen_id IN ('MIG-ONLINE', 'MIG-TAB')
    `))
    await idb.db.execute(sql.raw(`
      INSERT INTO tisch_tabs (mandant_id, kasse_id, tisch_nummer, kellner, positionen)
      SELECT mandant_id, id, 'Tisch 4', 'Service', '[]'::jsonb FROM kassen WHERE kassen_id = 'MIG-SERVICE'
    `))
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('setzt online / tab / aus nach Bestand und entfernt die alte Spalte', async () => {
    await fuehreMigrationAus()

    expect(await gastModi()).toEqual({
      'MIG-NEU':     'aus',
      'MIG-ONLINE':  'online',
      'MIG-SERVICE': 'aus',
      'MIG-TAB':     'tab',
    })
    const alteSpalte = await idb.db.execute(sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'kassen' AND column_name = 'gast_bestellung_aktiv'
    `)
    expect([...alteSpalte]).toHaveLength(0)
  })

  it('ist idempotent und lässt nur gültige Modi zu', async () => {
    await fuehreMigrationAus()
    expect((await gastModi())['MIG-TAB']).toBe('tab')

    // Drizzle verpackt den Postgres-Fehler (DrizzleQueryError.cause)
    const fehler = await idb.db.execute(sql.raw(`UPDATE kassen SET gast_modus = 'immer' WHERE kassen_id = 'MIG-NEU'`))
      .then(() => null, (e: unknown) => e as { cause?: { constraint_name?: string } })
    expect(fehler?.cause?.constraint_name).toBe('kassen_gast_modus_check')
  })
})
