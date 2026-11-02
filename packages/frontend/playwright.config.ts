import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here       = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(here, '../backend')

// Die frische E2E-Datenbank wird vom Runner (e2e/run-e2e.mjs) angelegt und via
// E2E_DATABASE_URL hereingereicht. Fallback nur, falls die Config direkt (ohne
// Runner) aufgerufen wird — dann muss die DB bereits existieren.
const E2E_DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'

/**
 * Einrichtungs-Schlüssel der E2E-Instanz. POST /api/setup ist auf einer eingerichteten Installation gesperrt —
 * außer für den angemeldeten Betreiber oder mit diesem Schlüssel im Header `x-setup-token` (Backend: SETUP_TOKEN).
 * Specs legen ZUSÄTZLICHE Mandanten per API an (Mandanten-Umschalter, Layout-Export …), dafür trägt jeder
 * E2E-Aufruf den Schlüssel mit (use.extraHTTPHeaders unten). Wer das Gesperrt-Verhalten prüfen will, nimmt einen
 * eigenen Kontext OHNE den Header (system-betreiber.spec.ts).
 */
const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789abcdef'

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
    extraHTTPHeaders: { 'x-setup-token': E2E_SETUP_TOKEN },
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
        SETUP_TOKEN:       E2E_SETUP_TOKEN,
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
    {
      // Kellner-App (mobile-first) fuer die Kellner-Journey — eigener Preview
      // auf 5178 mit /api-Proxy (siehe kellner/vite.config.ts).
      command: 'npx vite build && npx vite preview --port 5178 --strictPort --host 127.0.0.1',
      cwd: resolve(here, '../kellner'),
      url: 'http://127.0.0.1:5178',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Ticket-App (öffentliche Ticketseite) — Preview auf 5181, leitet nur
      // /api/ticketshop weiter (siehe tickets/vite.config.ts).
      command: 'npx vite build && npx vite preview --port 5181 --strictPort --host 127.0.0.1',
      cwd: resolve(here, '../tickets'),
      url: 'http://127.0.0.1:5181',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Einlass-App (Scanner fürs Personal) — Preview auf 5182, leitet nur
      // /api/einlass weiter (siehe einlass/vite.config.ts).
      command: 'npx vite build && npx vite preview --port 5182 --strictPort --host 127.0.0.1',
      cwd: resolve(here, '../einlass'),
      url: 'http://127.0.0.1:5182',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
