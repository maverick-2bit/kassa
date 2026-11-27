/**
 * Drizzle-Client mit postgres.js (wie beim Backend: keine Array-Typ-Introspektion, begrenzter Pool).
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>

export function createDb(databaseUrl: string): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(createSql(databaseUrl), { schema })
}

/** Wie createDb, gibt aber zusätzlich den Pool zurück — für ein sauberes Herunterfahren (sql.end()). */
export function createDbWithPool(databaseUrl: string): {
  db:  ReturnType<typeof drizzle<typeof schema>>
  sql: ReturnType<typeof postgres>
} {
  const sql = createSql(databaseUrl)
  return { db: drizzle(sql, { schema }), sql }
}

export function createSql(databaseUrl: string): ReturnType<typeof postgres> {
  return postgres(databaseUrl, {
    max:             10,
    idle_timeout:    20,
    connect_timeout: 10,
    max_lifetime:    60 * 30,
    onnotice:        () => {},
    fetch_types:     false,
  })
}

export { schema }
