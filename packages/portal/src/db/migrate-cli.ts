/**
 * Migrationen von Hand einspielen: pnpm --filter @kassa/portal db:migrate:run
 */

import { loadConfig } from '../config.js'
import { runMigrations } from './migrate.js'

const config = loadConfig()
console.info('Führe Datenbankmigrationen aus…')
await runMigrations(config.DATABASE_URL)
console.info('Migrationen abgeschlossen.')
