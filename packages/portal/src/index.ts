/**
 * Portal-Einstiegspunkt: Konfiguration laden, Migrationen einspielen, Server starten.
 */

import { loadConfig } from './config.js'
import { createDbWithPool } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()

  console.info('Führe Datenbankmigrationen aus…')
  await runMigrations(config.DATABASE_URL)
  console.info('Migrationen abgeschlossen.')

  const { db, sql } = createDbWithPool(config.DATABASE_URL)
  const server = await buildServer({ config, db })

  const beenden = async (signal: string) => {
    server.log.info(`${signal} empfangen — fahre herunter`)
    try {
      await server.close()
      await sql.end({ timeout: 5 })
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => { void beenden('SIGTERM') })
  process.on('SIGINT',  () => { void beenden('SIGINT') })

  await server.listen({ port: config.PORT, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error('Portal konnte nicht starten:', err instanceof Error ? err.message : err)
  process.exit(1)
})
