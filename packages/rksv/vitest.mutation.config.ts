import { defineConfig } from 'vitest/config'

/**
 * Vitest-Konfiguration für die Mutationstests (stryker.config.json).
 *
 * Ausgelassen werden Tests, die Python, WebAssembly-XSD-Prüfung oder Kindprozesse starten oder nur auf Anforderung
 * laufen: Sie prüfen die externen Prüfer, nicht den Kern, und würden jeden der Tausenden Mutanten-Läufe verlangsamen.
 * Was übrig bleibt, ist genau die schnelle Suite, die in jedem Pull Request läuft — ihre Lücken zeigt der Bericht.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      'tests/dep7-zweitpruefer.test.ts',
      'tests/bmf-runner.test.ts',
      'tests/fon-xsd.test.ts',
      'tests/zeit-matrix.test.ts',
      'tests/atrust-abnahme.test.ts',
      // Stellen die Prozess-Zeitzone (process.env.TZ) um; Strykers Vitest-Läufer arbeitet mit Worker-Threads, in denen das
      // nicht greift („Prozess-TZ … wirkt nicht") — der Probelauf von Stryker scheitert sonst schon vor dem ersten Mutanten.
      'tests/zeit.test.ts',
    ],
  },
})
