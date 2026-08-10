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
    /**
     * Zusätzlich zum Konsolen-Report immer eine Ergebnisdatei schreiben.
     *
     * Anlass: ein Lauf war 243/246 (drei Tests einer Datei rot), die drei
     * folgenden wieder grün — und weil die Konsolenausgabe schon durchgerauscht
     * war, ließ sich nicht mehr feststellen, WELCHE Datei es war. Ohne diese
     * Information ist ein seltener Flake nicht zu untersuchen; man kann nur
     * raten. Die Datei kostet nichts und hält beim nächsten Mal Dateiname,
     * Testname und Fehlermeldung fest.
     */
    reporters: ['default', ['json', { outputFile: './test-results/integration.json' }]],
  },
})
