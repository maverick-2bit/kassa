import { defineConfig } from 'vitest/config'

/**
 * RKSV-Burn-in (Dauer-/Rechtssicherheitstest) gegen ein echtes PostgreSQL.
 * Gehört NICHT zur normalen Test-Suite und zur CI: läuft nur auf Abruf (pnpm test:burnin).
 * Steuerung über BURNIN_BELEGE / BURNIN_MINUTEN / BURNIN_SEED, siehe tests/burnin/rksv-burnin.test.ts.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/burnin/**/*.test.ts'],
    testTimeout: 12 * 60 * 60_000,
    hookTimeout: 5 * 60_000,
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
  },
})
