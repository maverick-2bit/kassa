/**
 * Drizzle-Client mit postgres.js Driver.
 * Liest DATABASE_URL aus den Umgebungsvariablen.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>

export function createDb(databaseUrl: string): ReturnType<typeof drizzle<typeof schema>> {
  const sql = postgres(databaseUrl, {
    max: 10,
    onnotice: () => {}, // unterdrücke NOTICE-Logs
  })
  return drizzle(sql, { schema })
}

export { schema }
