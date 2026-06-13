/**
 * Wegwerf-Datenbank für Integrationstests.
 *
 * Erstellt pro Aufruf eine eigene PostgreSQL-Datenbank (kassa_test_<random>),
 * spielt alle Migrationen aus drizzle/ ein und löscht sie nach dem Test wieder.
 * Dadurch laufen Test-Dateien isoliert und parallel, ohne sich Daten zu teilen.
 *
 * Voraussetzungen:
 *  - PostgreSQL erreichbar über TEST_DATABASE_URL
 *    (Standard: postgresql://kassa:kassa@localhost:5432/kassa)
 *  - Die Rolle hat CREATEDB-Recht (einmalig: ALTER ROLE kassa CREATEDB;)
 */

import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { schema, type Db } from '../../../src/db/client.js'
import { runMigrations } from '../../../src/db/migrate.js'

const BASIS_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'

export interface IntegrationsDb {
  db:  Db
  url: string
  /** Schließt alle Verbindungen und löscht die Test-Datenbank */
  zerstoeren: () => Promise<void>
}

export async function erstelleIntegrationsDb(): Promise<IntegrationsDb> {
  const name = `kassa_test_${randomBytes(6).toString('hex')}`

  const admin = postgres(BASIS_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }

  const url = new URL(BASIS_URL)
  url.pathname = `/${name}`
  const testUrl = url.toString()

  await runMigrations(testUrl)

  const sql = postgres(testUrl, { max: 5, onnotice: () => {} })
  const db  = drizzle(sql, { schema }) as Db

  return {
    db,
    url: testUrl,
    zerstoeren: async () => {
      await sql.end()
      const aufraeumer = postgres(BASIS_URL, { max: 1 })
      try {
        await aufraeumer.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await aufraeumer.end()
      }
    },
  }
}
