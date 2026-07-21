import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'

// Version aus package.json — dieselbe globale Konstante wie im vite-Build
// (vite.config.ts), damit Module, die __APP_VERSION__ nutzen (z. B. lib/offline.ts),
// auch unter vitest laufen statt an einer ReferenceError zu scheitern.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    // E2E-Specs laufen über Playwright (node e2e/run-e2e.mjs), NICHT über vitest.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
