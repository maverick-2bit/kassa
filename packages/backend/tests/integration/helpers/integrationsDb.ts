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

  // fetch_types:false überall (Schema hat keine Array-/Enum-Typen): verhindert die
  // interne Array-Typ-Introspektions-Query von postgres.js, die bei kurzlebigen
  // Verbindungen mit end() um die Wette läuft und als unhandled CONNECTION_CLOSED
  // den Integrationstest-Lauf rot färbt (früherer Flake).
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
  const db  = drizzle(sql, { schema }) as Db

  return {
    db,
    url: testUrl,
    zerstoeren: async () => {
      await sql.end()
      await dropDatenbankSicher(name)
    },
  }
}

/**
 * DROP DATABASE mit Retry — DER Phantom-Flake der Suite.
 *
 * `WITH (FORCE)` beendet alle Verbindungen zur Ziel-DB. Läuft dort gerade
 * Autovacuum, gehört dessen Verbindung dem Superuser — die kassa-Rolle darf
 * sie nicht beenden: „keine Berechtigung, um Prozess zu beenden". Der DROP
 * warf dann als unbehandelte Ablehnung, die Datei wurde rot (bei durchweg
 * grünen Tests, wandernd zwischen Dateien, nur unter Last — Autovacuum braucht
 * Schreibaktivität) und die Test-DB blieb als Leiche liegen.
 *
 * Autovacuum auf einer Wegwerf-DB ist in Millisekunden fertig → kurz warten
 * und erneut versuchen. Scheitert es endgültig, wird gewarnt statt geworfen:
 * eine liegengebliebene Test-DB ist lästig, ein roter Lauf ohne echten Fehler
 * ist schlimmer.
 */
export async function dropDatenbankSicher(name: string): Promise<void> {
  const aufraeumer = postgres(BASIS_URL, { max: 1, fetch_types: false })
  try {
    for (let versuch = 1; ; versuch++) {
      try {
        await aufraeumer.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        return
      } catch (err) {
        if (versuch >= 5) {
          console.warn(`Test-DB ${name} konnte nicht gelöscht werden (bleibt liegen):`,
            err instanceof Error ? err.message : err)
          return
        }
        await new Promise(r => setTimeout(r, 200 * versuch))
      }
    }
  } finally {
    await aufraeumer.end()
  }
}
