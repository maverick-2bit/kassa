/**
 * CLI-Einstiegspunkt für manuelle Migrations-Ausführung.
 *
 * Verwendung (ohne Server zu starten):
 *   pnpm --filter @kassa/backend db:migrate:run
 *
 * Nützlich in CI/CD-Pipelines, Docker-Entrypoints und manuellen Deployments.
 */

import { loadConfig } from '../config.js'
import { runMigrations } from './migrate.js'

const config = loadConfig()

console.info(`Verbinde mit Datenbank…`)
console.info(`Führe Migrationen aus…`)

runMigrations(config.DATABASE_URL)
  .then(() => {
    console.info('✓ Alle Migrationen erfolgreich ausgeführt.')
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error('✗ Migrationen fehlgeschlagen:', err)
    process.exit(1)
  })
