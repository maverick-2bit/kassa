import { defineConfig } from 'vitest/config'

/**
 * Integrationstests gegen ein echtes PostgreSQL.
 *
 * Voraussetzungen: PostgreSQL erreichbar über TEST_DATABASE_URL (Standard
 * postgresql://kassa:kassa@localhost:5432/kassa, dieselbe Instanz wie beim Backend) und eine Rolle mit CREATEDB.
 * Aufruf: pnpm --filter @kassa/portal test:integration
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
})
