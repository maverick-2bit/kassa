import { test, expect } from '@playwright/test'

/**
 * End-to-End: Kassen-Onboarding durch den echten Browser.
 *
 * Treibt den vollstaendigen Stack an — React-Formular → POST /api/setup →
 * SEE-Schluesselgenerierung → FinanzOnline-Registrierung (gestubt via FO_STUB) →
 * RKSV-Startbeleg-Signierung → PostgreSQL → Erfolgs-Screen.
 *
 * Laeuft gegen eine frische E2E-Datenbank (playwright.config global-setup) und
 * ein Backend mit FO_STUB=true.
 */
test('Onboarding: Setup-Formular richtet Kasse ein und signiert den Startbeleg', async ({ page }) => {
  // Warmup: erste Proxy->Backend-Verbindung absichern. Der allererste TCP-Connect
  // ueber den Vite-Proxy kann auf Windows vereinzelt ETIMEDOUTen; expect.poll
  // wiederholt, bis das Backend ueber den Proxy sauber antwortet.
  await expect.poll(
    async () => (await page.request.get('/api/health')).status(),
    { timeout: 20_000, intervals: [500, 1000, 2000] },
  ).toBe(200)

  await page.goto('/setup')

  await expect(page.getByRole('heading', { name: 'Kasse einrichten' })).toBeVisible()

  await page.fill('#firmenname', 'E2E Onboarding GmbH')
  await page.fill('#uid', 'ATU77777701')
  await page.fill('#kassenId', 'E2E-KASSE-01')
  await page.fill('#tid', 'TID-E2E')
  await page.fill('#benid', 'BID-E2E')
  await page.fill('#pin', 'PIN-E2E')
  await page.fill('#admin-name', 'E2E Admin')
  await page.fill('#admin-email', 'e2e-onboarding@test.at')
  await page.fill('#admin-passwort', 'e2e-passwort-12345')

  await page.getByRole('button', { name: 'Kasse einrichten' }).click()

  // Erfolg: Kasse registriert (FO-Stub) + Startbeleg geprueft. Grosszuegiges
  // Timeout fuer SEE-Keygen + Signierung + DB-Roundtrip.
  await expect(page.getByRole('heading', { name: 'Kasse erfolgreich eingerichtet' }))
    .toBeVisible({ timeout: 30_000 })

  // Startbeleg-Nummer wird angezeigt (Beweis, dass signiert + persistiert wurde)
  await expect(page.getByText('Startbeleg-Nr.')).toBeVisible()

  // Weiterleitung in die App steht bereit
  await expect(page.getByRole('button', { name: /Zur Kasse/ })).toBeVisible()
})
