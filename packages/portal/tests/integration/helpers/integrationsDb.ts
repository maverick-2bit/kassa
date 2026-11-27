/**
 * Wegwerf-Datenbank für Integrationstests (wie beim Backend): pro Aufruf eine eigene PostgreSQL-Datenbank,
 * alle Migrationen eingespielt, nach dem Test gelöscht.
 *
 * Voraussetzung: PostgreSQL über TEST_DATABASE_URL (Standard postgresql://kassa:kassa@localhost:5432/kassa),
 * die Rolle braucht CREATEDB.
 */

import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { schema, type Db } from '../../../src/db/client.js'
import { runMigrations } from '../../../src/db/migrate.js'

const BASIS_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'

export interface IntegrationsDb {
  db:  Db
  url: string
  zerstoeren: () => Promise<void>
}

export async function erstelleIntegrationsDb(): Promise<IntegrationsDb> {
  const name = `portal_test_${randomBytes(6).toString('hex')}`

  const admin = postgres(BASIS_URL, { max: 1, fetch_types: false })
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }

  const url = new URL(BASIS_URL)
  url.pathname = `/${name}`
  const testUrl = url.toString()

  await runMigrations(testUrl)

  const sql = postgres(testUrl, { max: 5, onnotice: () => {}, fetch_types: false })
  const db = drizzle(sql, { schema }) as Db

  return {
    db,
    url: testUrl,
    zerstoeren: async () => {
      await sql.end()
      await loescheDatenbank(name)
    },
  }
}

/** DROP DATABASE mit Wiederholung (Autovacuum kann die Verbindung kurz festhalten). Scheitert es, wird gewarnt statt geworfen. */
async function loescheDatenbank(name: string): Promise<void> {
  const aufraeumer = postgres(BASIS_URL, { max: 1, fetch_types: false })
  try {
    for (let versuch = 1; ; versuch++) {
      try {
        await aufraeumer.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        return
      } catch (err) {
        if (versuch >= 5) {
          console.warn(`Test-DB ${name} konnte nicht gelöscht werden (bleibt liegen):`, err instanceof Error ? err.message : err)
          return
        }
        await new Promise(r => setTimeout(r, 200 * versuch))
      }
    }
  } finally {
    await aufraeumer.end()
  }
}
