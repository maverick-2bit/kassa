import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // E2E-Specs laufen über Playwright (node e2e/run-e2e.mjs), NICHT über vitest.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
