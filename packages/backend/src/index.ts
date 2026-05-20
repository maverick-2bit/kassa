/**
 * Backend-Einstiegspunkt.
 * Lädt die Konfiguration, baut den Server und startet ihn.
 */

import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
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
  })

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
