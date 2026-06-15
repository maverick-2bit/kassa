/**
 * Drizzle-Client mit postgres.js Driver.
 * Liest DATABASE_URL aus den Umgebungsvariablen.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>

export function createDb(databaseUrl: string): ReturnType<typeof drizzle<typeof schema>> {
  const sql = createSql(databaseUrl)
  return drizzle(sql, { schema })
}

/**
 * Wie createDb, gibt aber zusätzlich den rohen sql-Pool zurück,
 * damit der Aufrufer ihn beim Graceful Shutdown schließen kann.
 */
export function createDbWithPool(databaseUrl: string): {
  db:  ReturnType<typeof drizzle<typeof schema>>
  sql: ReturnType<typeof postgres>
} {
  const sql = createSql(databaseUrl)
  return { db: drizzle(sql, { schema }), sql }
}

/**
 * Erzeugt den rohen postgres.js-Client mit dem Verbindungspool.
 * Wird getrennt exportiert, damit der Pool beim Graceful Shutdown
 * sauber geschlossen werden kann (sql.end()).
 */
export function createSql(databaseUrl: string): ReturnType<typeof postgres> {
  return postgres(databaseUrl, {
    max:             10,
    idle_timeout:    20,   // Sekunden — ungenutzte Verbindungen freigeben
    connect_timeout: 10,   // Sekunden — bei Netzwerkproblemen nicht endlos blockieren
    max_lifetime:    60 * 30, // Sekunden — Verbindungen nach 30 min erneuern (gegen stale Connections)
    onnotice: () => {}, // unterdrücke NOTICE-Logs
  })
}

export { schema }
