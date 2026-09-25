import { test, expect, type Page } from '@playwright/test'

/**
 * Update-Hinweis der Kellner-App bei DAUERHAFT offener Seite, gegen das gebaute
 * Kellner-Bundle (vite preview, Port 5178): Die Seite fragt beim Start, alle
 * 5 min und beim Wieder-Sichtbarwerden (Handy entsperrt) GET /api/health und
 * zeigt den Hinweis, sobald das Backend eine NEUERE Version meldet — ohne
 * Neuladen und ohne Service Worker (http://<LAN-IP> hat keinen).
 *
 * Die Server-Version steuert page.route (echte Antwort, nur `version` ersetzt),
 * die Uhr page.clock — so müssen die Minuten nicht echt vergehen. Keine
 * Anmeldung nötig: der Hinweis steht auch auf der Login-Seite.
 */

const KELLNER_URL = 'http://127.0.0.1:5178'

test.use({
  viewport: { width: 390, height: 844 }, // iPhone 13
  hasTouch: true,
  isMobile: true,
  // page.route sieht keine Anfragen, die ein Service Worker kontrolliert — und
  // der Hinweis darf ohnehin nicht vom SW abhängen.
  serviceWorkers: 'block',
})

/** Server-Version umschaltbar: null = echte Antwort des Backends (= Bundle-Version) */
async function steuereServerVersion(page: Page) {
  const server = { version: null as string | null }
  await page.route('**/api/health', async (route) => {
    const echt = await route.fetch()
    if (!server.version) return route.fulfill({ response: echt })
    const json = await echt.json() as Record<string, unknown>
    return route.fulfill({ response: echt, json: { ...json, version: server.version } })
  })
  return server
}

/** Handy sperren und entsperren: visibilitychange hidden → visible (bubbelt wie im Browser) */
async function sperrenUndEntsperren(page: Page) {
  await page.evaluate(() => {
    for (const zustand of ['hidden', 'visible'] as const) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => zustand })
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    }
  })
}

/** Login-Seite öffnen und warten, bis die Startprüfung beantwortet ist */
async function oeffneKellnerApp(page: Page) {
  // Warmup: erste Verbindung Kellner-Preview-Proxy → Backend (Muster zz-kellner-mobil)
  await expect.poll(
    async () => (await page.request.get(`${KELLNER_URL}/api/health`)).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const startpruefung = page.waitForResponse('**/api/health')
  await page.goto(`${KELLNER_URL}/login`)
  await expect(page.getByRole('heading', { name: 'Kellner-App' })).toBeVisible({ timeout: 15_000 })
  await startpruefung
}

/** Kurz warten, damit ein (fälschlich) erscheinender Hinweis gerendert wäre */
async function nachwirken(page: Page) {
  await page.waitForTimeout(500)
}

test.describe('Kellner-App: Update-Hinweis bei offener Seite', () => {

test('gleiche Version: kein Hinweis — neuere Version: Hinweis beim Entsperren, Neuladen räumt ihn ab', async ({ page }) => {
  const server  = await steuereServerVersion(page)
  const hinweis = page.getByText('Neue Version verfügbar')
  await page.clock.install()

  await oeffneKellnerApp(page)
  await nachwirken(page)
  await expect(hinweis).toHaveCount(0)

  // Update eingespielt, das Handy liegt 2 min gesperrt — länger als die
  // Frische der letzten Antwort (60 s), kürzer als das Intervall (5 min)
  server.version = '99.0.0'
  await page.clock.fastForward('02:00')
  await nachwirken(page)
  await expect(hinweis).toHaveCount(0)

  await sperrenUndEntsperren(page)
  await expect(hinweis).toBeVisible()
  // Leiste über der Seite, nicht schwebend über den Knöpfen am unteren Rand
  expect((await page.getByRole('status').boundingBox())?.y).toBe(0)

  // „Jetzt aktualisieren" lädt neu; danach passen Bundle und Backend wieder
  server.version = null
  await page.evaluate(() => { (window as { vorDemNeuladen?: boolean }).vorDemNeuladen = true })
  const nachDemNeuladen = page.waitForResponse('**/api/health')
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Jetzt aktualisieren' }).click(),
  ])
  expect(await page.evaluate(() => (window as { vorDemNeuladen?: boolean }).vorDemNeuladen)).toBeUndefined()
  await nachDemNeuladen
  await expect(page.getByRole('heading', { name: 'Kellner-App' })).toBeVisible()
  await nachwirken(page)
  await expect(hinweis).toHaveCount(0)
})

test('dauerhaft sichtbare Seite (Theken-Tablet) erfährt es spätestens nach 5 Minuten', async ({ page }) => {
  const server  = await steuereServerVersion(page)
  const hinweis = page.getByText('Neue Version verfügbar')
  await page.clock.install()

  await oeffneKellnerApp(page)
  server.version = '99.0.0'

  // Ohne Sperren/Entsperren: allein das Intervall prüft
  await page.clock.fastForward('05:30')
  await expect(hinweis).toBeVisible()
})

})
