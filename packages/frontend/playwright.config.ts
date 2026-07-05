import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here       = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(here, '../backend')

// Die frische E2E-Datenbank wird vom Runner (e2e/run-e2e.mjs) angelegt und via
// E2E_DATABASE_URL hereingereicht. Fallback nur, falls die Config direkt (ohne
// Runner) aufgerufen wird — dann muss die DB bereits existieren.
const E2E_DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // Cold-Boot-Jitter abfedern (frische DB-Migrationen + erster Vite-Compile beim
  // ersten Request). Der eigentliche Flow ist deterministisch.
  retries: 2,
  reporter: [['list']],
  use: {
    // Explizit IPv4: der Preview-Server bindet an 127.0.0.1. Mit "localhost"
    // löst Windows teils zu ::1 auf → sporadisch ECONNREFUSED/ETIMEDOUT bei
    // page.goto und request.*. 127.0.0.1 beseitigt diese Flakiness-Klasse.
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // Backend gegen die frische E2E-DB, FinanzOnline gestubt. Alle benoetigten
      // Variablen kommen direkt aus env (KEIN --env-file=.env) — so laeuft der
      // E2E-Lauf auch in CI ohne Secret-Management oder .env-Datei.
      command: 'npx tsx src/index.ts',
      cwd: backendDir,
      // Auf echte Bereitschaft warten (HTTP 200), nicht nur auf den offenen Port —
      // sonst rennt der erste Request gegen ein noch migrierendes Backend.
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        DATABASE_URL:      E2E_DB_URL,
        FO_STUB:           'true',
        NODE_ENV:          'test',
        PORT:              '3000',
        LOG_LEVEL:         'warn',
        MASTER_PASSPHRASE: 'e2e-master-passphrase-0123456789',
        JWT_SECRET:        'e2e-jwt-secret-key-mindestens-32-zeichen-lang',
      },
    },
    {
      // Gegen das gebaute Bundle testen (vite preview) statt den dev-Server:
      // kein On-demand-Compile beim ersten Request -> deterministisch, und es
      // wird das echte Production-Artefakt geprueft.
      command: 'npx vite build && npx vite preview --port 5173 --strictPort --host 127.0.0.1',
      cwd: here,
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
