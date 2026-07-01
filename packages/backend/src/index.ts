/**
 * Backend-Einstiegspunkt.
 * Lädt die Konfiguration, baut den Server und startet ihn.
 */

import { loadConfig } from './config.js'
import { createDbWithPool } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { buildServer } from './server.js'
import { starteDepSicherungsCron } from './services/dep-sicherung.cron.js'
import { starteDbBackupCron }      from './services/db-backup.cron.js'
import { erstelleStubFinanzOnlineClient } from './services/finanz-online.stub.js'

async function main(): Promise<void> {
  const config = loadConfig()

  // Migrationen vor dem Server-Start ausführen
  console.info('Führe Datenbankmigrationen aus…')
  await runMigrations(config.DATABASE_URL)
  console.info('Migrationen abgeschlossen.')

  const { db, sql } = createDbWithPool(config.DATABASE_URL)

  // FinanzOnline-Stub für lokale Entwicklung/E2E — in Produktion strikt verboten.
  if (config.FO_STUB && config.NODE_ENV === 'production') {
    throw new Error('FO_STUB=true ist in Produktion nicht erlaubt — eine gestubte FinanzOnline-Registrierung ist keine gültige RKSV-Anmeldung.')
  }
  const rksvOptionen = config.FO_STUB
    ? { finanzOnlineClient: erstelleStubFinanzOnlineClient() }
    : undefined
  if (config.FO_STUB) {
    console.warn('⚠️  FO_STUB aktiv — FinanzOnline wird gestubt (nur für Entwicklung/Test).')
  }

  const server = await buildServer({
    config,
    db,
    setupDeps: {
      db,
      masterPassphrase: config.MASTER_PASSPHRASE,
      ...(rksvOptionen && { rksvOptionen }),
    },
    belegDeps: {
      db,
      masterPassphrase: config.MASTER_PASSPHRASE,
      ...(rksvOptionen && { finanzOnlineClient: rksvOptionen.finanzOnlineClient }),
    },
    backupDir:         config.DEP_BACKUP_DIR,
    dbBackupDir:       config.DB_BACKUP_DIR,
    dbBackupRetention: config.DB_BACKUP_RETENTION,
  })

  const stopDepCron = starteDepSicherungsCron(db, config.DEP_BACKUP_DIR, server.log)
  const stopDbCron  = starteDbBackupCron(db, config.DATABASE_URL, config.DB_BACKUP_DIR, config.DB_BACKUP_RETENTION, server.log)

  // Letzte Auffanglinie für verirrte Fehler — protokollieren statt stillem Absturz
  process.on('unhandledRejection', (reason) => {
    server.log.error({ err: reason }, 'Unbehandelte Promise-Rejection')
  })
  process.on('uncaughtException', (err) => {
    server.log.fatal({ err }, 'Unbehandelte Ausnahme — Prozess wird beendet')
    // Bei einem unbekannten Fehlerzustand ist ein sauberer Neustart sicherer
    // als ein weiterlaufender Prozess mit korrupter Laufzeit.
    void shutdown('uncaughtException', 1)
  })

  let beendet = false
  async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (beendet) return
    beendet = true
    server.log.info(`${signal} empfangen — fahre sauber herunter…`)

    // Failsafe: falls das Schließen hängt, nach 10s hart beenden
    const failsafe = setTimeout(() => {
      server.log.error('Graceful Shutdown überschritt 10s — erzwinge Beendigung')
      process.exit(exitCode || 1)
    }, 10_000)
    failsafe.unref()

    try {
      stopDepCron()
      stopDbCron()
      await server.close()   // keine neuen Requests, laufende abwarten
      await sql.end({ timeout: 5 }) // DB-Pool drainen
      server.log.info('Sauber heruntergefahren.')
    } catch (err) {
      server.log.error({ err }, 'Fehler beim Herunterfahren')
      exitCode = exitCode || 1
    } finally {
      clearTimeout(failsafe)
      process.exit(exitCode)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT',  () => void shutdown('SIGINT'))

  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' })
  } catch (err) {
    server.log.error(err)
    await sql.end({ timeout: 5 })
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('Server konnte nicht gestartet werden:', err)
  process.exit(1)
})
