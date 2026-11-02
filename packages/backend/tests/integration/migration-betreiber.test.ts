/**
 * Integrationstest: Migration 0072 (Betreiber) übernimmt den Bestand richtig.
 *
 * Bis dahin durfte jeder Admin jedes Mandanten die ganze Datenbank sichern und die Kassa aktualisieren. Ab
 * jetzt darf das nur der Betreiber — und damit auf einer vorhandenen Installation nach dem Update überhaupt
 * jemand aktualisieren kann, markiert die Migration ihn selbst:
 *   - die aktiven Admins des ZUERST angelegten Mandanten (auf dem Kassen-PC der bei der Einrichtung entstandene)
 *   - Auffangnetz: hat der keinen aktiven Admin und gibt es sonst keinen Betreiber, der älteste aktive Admin überhaupt
 *
 * Der Zustand vor 0072 wird auf einer voll migrierten Wegwerf-DB nachgestellt (Flags zurück, eigene Zeilen); danach
 * läuft die SQL genau wie im Drizzle-Migrator (an den statement-breakpoints getrennt) — mehrfach, sie muss idempotent sein.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'
import { mandanten, users } from '../../src/db/schema.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0072_betreiber.sql')

describe('Migration 0072: Betreiber aus dem Bestand (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb

  const fuehreMigrationAus = async () => {
    for (const teil of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      if (teil.trim()) await idb.db.execute(sql.raw(teil))
    }
  }

  let nr = 0
  const mandant = async (name: string, angelegt: string): Promise<string> => {
    const [m] = await idb.db.insert(mandanten)
      .values({ firmenname: name, uid: `ATU4444440${++nr}`, createdAt: new Date(angelegt) }).returning()
    return m!.id
  }
  const benutzer = async (mandantId: string, name: string, o: { rolle?: string; aktiv?: boolean; angelegt?: string } = {}) => {
    await idb.db.insert(users).values({
      mandantId, email: `${name}@migration-betreiber.at`, passwordHash: 'x', name,
      rolle: o.rolle ?? 'admin', berechtigungen: [], aktiv: o.aktiv ?? true,
      createdAt: new Date(o.angelegt ?? '2026-01-01T10:00:00Z'),
    })
  }
  const betreiber = async (): Promise<string[]> =>
    (await idb.db.select({ name: users.name, ist: users.istBetreiber }).from(users))
      .filter(u => u.ist).map(u => u.name).sort()

  beforeAll(async () => { idb = await erstelleIntegrationsDb() })
  afterAll(async () => { await idb?.zerstoeren() })
  beforeEach(async () => {
    await idb.db.execute(sql`DELETE FROM users`)
    await idb.db.execute(sql`DELETE FROM mandanten`)
  })

  it('die aktiven Admins des ältesten Mandanten werden Betreiber — Kellner, Gesperrte und andere Mandanten nicht', async () => {
    const aelter = await mandant('Erster Betrieb', '2026-01-01T00:00:00Z')
    const juenger = await mandant('Zweiter Betrieb', '2026-06-01T00:00:00Z')
    await benutzer(aelter,  'admin-eins')
    await benutzer(aelter,  'admin-zwei')
    await benutzer(aelter,  'kellner',        { rolle: 'kellner' })
    await benutzer(aelter,  'admin-gesperrt', { aktiv: false })
    await benutzer(juenger, 'admin-fremd',    { angelegt: '2025-01-01T00:00:00Z' })   // sogar der ältere Benutzer ändert nichts

    await fuehreMigrationAus()
    expect(await betreiber()).toEqual(['admin-eins', 'admin-zwei'])
  })

  it('idempotent: ein zweiter Lauf ändert nichts', async () => {
    const m = await mandant('Betrieb', '2026-01-01T00:00:00Z')
    await benutzer(m, 'admin-eins')
    await fuehreMigrationAus()
    await fuehreMigrationAus()
    expect(await betreiber()).toEqual(['admin-eins'])
  })

  it('Auffangnetz: hat der älteste Mandant keinen aktiven Admin, wird der älteste aktive Admin überhaupt Betreiber', async () => {
    const aelter = await mandant('Erster Betrieb', '2026-01-01T00:00:00Z')
    const juenger = await mandant('Zweiter Betrieb', '2026-06-01T00:00:00Z')
    await benutzer(aelter,  'nur-kellner',    { rolle: 'kellner' })
    await benutzer(aelter,  'admin-gesperrt', { aktiv: false })
    await benutzer(juenger, 'admin-spaeter',  { angelegt: '2026-07-01T00:00:00Z' })
    await benutzer(juenger, 'admin-frueher',  { angelegt: '2026-06-02T00:00:00Z' })

    await fuehreMigrationAus()
    expect(await betreiber()).toEqual(['admin-frueher'])
  })

  it('ohne irgendeinen Admin passiert nichts (und es gibt keinen Fehler)', async () => {
    const m = await mandant('Betrieb', '2026-01-01T00:00:00Z')
    await benutzer(m, 'kellner', { rolle: 'kellner' })
    await fuehreMigrationAus()
    expect(await betreiber()).toEqual([])
  })

  it('eine leere Installation bleibt leer', async () => {
    await fuehreMigrationAus()
    expect(await betreiber()).toEqual([])
  })
})
