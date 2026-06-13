import { defineConfig } from 'vitest/config'

/**
 * Integrationstests gegen ein echtes PostgreSQL.
 *
 * Voraussetzungen:
 *  - PostgreSQL läuft (lokal oder CI-Service-Container)
 *  - TEST_DATABASE_URL gesetzt oder Standard postgresql://kassa:kassa@localhost:5432/kassa
 *  - Die Rolle braucht CREATEDB (einmalig: ALTER ROLE kassa CREATEDB;)
 *
 * Aufruf: pnpm test:integration
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
