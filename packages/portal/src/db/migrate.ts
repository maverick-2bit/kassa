/**
 * Spielt beim Start alle ausstehenden Migrationen aus drizzle/ ein.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function runMigrations(databaseUrl: string): Promise<void> {
  // Eigene Verbindung nur für die Migration, danach sofort schließen
  const sql = postgres(databaseUrl, { max: 1, fetch_types: false })
  const db  = drizzle(sql)
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await sql.end()
  }
}
