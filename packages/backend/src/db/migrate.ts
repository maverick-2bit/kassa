/**
 * Drizzle-Migrations-Runner.
 *
 * Wird beim Server-Start einmalig aufgerufen und spielt alle ausstehenden
 * Migrationen aus dem `drizzle/`-Ordner ein.
 *
 * Nutzung:
 *   import { runMigrations } from './db/migrate.js'
 *   await runMigrations(config.DATABASE_URL)
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

export async function runMigrations(databaseUrl: string): Promise<void> {
  // Eigene Verbindung nur für Migrationen (max 1 Connection, dann sofort schliessen).
  // fetch_types:false → keine Array-Typ-Introspektion, die beim sofortigen sql.end()
  // als unhandled CONNECTION_CLOSED racen könnte (Schema hat keine Array-/Enum-Typen).
  const sql = postgres(databaseUrl, { max: 1, fetch_types: false })
  const db  = drizzle(sql)

  const migrationsFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../drizzle',
  )

  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await sql.end()
  }
}
