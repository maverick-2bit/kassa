/**
 * Backend-Einstiegspunkt.
 * Lädt die Konfiguration, baut den Server und startet ihn.
 */

import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { buildServer } from './server.js'
import { starteDepSicherungsCron } from './services/dep-sicherung.cron.js'
import { starteDbBackupCron }      from './services/db-backup.cron.js'

async function main(): Promise<void> {
  const config = loadConfig()

  // Migrationen vor dem Server-Start ausführen
  console.info('Führe Datenbankmigrationen aus…')
  await runMigrations(config.DATABASE_URL)
  console.info('Migrationen abgeschlossen.')

  const db     = createDb(config.DATABASE_URL)

  const server = await buildServer({
    config,
    db,
    setupDeps: {
      db,
      masterPassphrase: config.MASTER_PASSPHRASE,
    },
    belegDeps: {
      db,
      masterPassphrase: config.MASTER_PASSPHRASE,
    },
    backupDir:         config.DEP_BACKUP_DIR,
    dbBackupDir:       config.DB_BACKUP_DIR,
    dbBackupRetention: config.DB_BACKUP_RETENTION,
  })

  starteDepSicherungsCron(db, config.DEP_BACKUP_DIR, server.log)
  starteDbBackupCron(db, config.DATABASE_URL, config.DB_BACKUP_DIR, config.DB_BACKUP_RETENTION, server.log)

  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('Server konnte nicht gestartet werden:', err)
  process.exit(1)
})
