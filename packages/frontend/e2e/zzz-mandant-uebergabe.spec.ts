import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Einstellungen → System → „Mandant übertragen":
 *  1. Exportieren: Passwort zweimal (mind. 10 Zeichen) → Datei „kassa-mandant-….kuep" wird heruntergeladen.
 *  2. Einspielen derselben Datei in DIESE Kassa: falsches Passwort → „Falsches Passwort …";
 *     richtiges Passwort → Hinweis, dass der Mandant hier schon existiert (nichts überschrieben).
 *  (Der Weg in eine zweite Kassa mit echtem Zugewinn ist im Backend-Integrationstest abgedeckt —
 *   im E2E gibt es nur eine Instanz.)
 *
 * Läuft hinter onboarding.spec.ts (Dateiname zzz-…): die Instanz wird dort eingerichtet.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const UEBERGABE_PW   = 'uebergabe-pw-e2e-1'

test.use({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
test.setTimeout(150_000)

type Login = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }

async function loginAbwarten(request: APIRequestContext) {
  const body = { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } }
  for (let versuch = 0; versuch < 6; versuch++) {
    const res = await request.post('/api/auth/login', body)
    if (res.status() !== 429) return res
    const sekunden = Math.min(Math.max(Number(res.headers()['retry-after']) || 10, 2), 65)
    await new Promise(r => setTimeout(r, sekunden * 1000))
  }
  return request.post('/api/auth/login', body)
}

async function anmelden(page: Page, request: APIRequestContext) {
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Übergabe GmbH', uid: 'ATU87654333', kassenId: 'E2E-UE-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  const login = (await res.json()) as Login
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })
}

test('Mandant exportieren und die Datei prüfen lassen', async ({ page, request }, testInfo) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)
  await anmelden(page, request)
  await page.goto('/einstellungen?bereich=system')

  const sektion = page.locator('section', { has: page.getByRole('heading', { name: 'Mandant übertragen' }) })
  await expect(sektion).toBeVisible()

  // Export-Knopf bleibt gesperrt, bis beide Passwörter gleich und lang genug sind
  const exportKnopf = sektion.getByTestId('uebergabe-export')
  await expect(exportKnopf).toBeDisabled()
  await sektion.getByTestId('uebergabe-export-pw').fill(UEBERGABE_PW)
  await sektion.getByTestId('uebergabe-export-pw2').fill('anderes-passwort-1')
  await expect(exportKnopf).toBeDisabled()
  await sektion.getByTestId('uebergabe-export-pw2').fill(UEBERGABE_PW)
  await expect(exportKnopf).toBeEnabled()

  // Standard ist „danach sperren“ — dieser Test lässt die Kassa offen, damit die übrigen Specs weiter belegen können
  await expect(sektion.getByTestId('uebergabe-sperren')).toBeChecked()
  await sektion.getByTestId('uebergabe-sperren').uncheck()
  const [download] = await Promise.all([page.waitForEvent('download'), exportKnopf.click()])
  expect(download.suggestedFilename()).toMatch(/^kassa-mandant-.+-\d{4}-\d{2}-\d{2}\.kuep$/)
  await expect(sektion.getByTestId('uebergabe-export-ok')).toBeVisible()
  const datei = testInfo.outputPath('uebergabe.kuep')
  await download.saveAs(datei)

  // Einspielen in dieselbe Kassa: falsches Passwort …
  await sektion.getByTestId('uebergabe-import-datei').setInputFiles(datei)
  await sektion.getByTestId('uebergabe-import-pw').fill('falsches-passwort-1')
  await sektion.getByTestId('uebergabe-import').click()
  await expect(sektion.getByTestId('uebergabe-import-fehler')).toContainText('Falsches Passwort')

  // … richtiges Passwort: der Mandant ist hier schon da, es wird nichts überschrieben
  await sektion.getByTestId('uebergabe-import-pw').fill(UEBERGABE_PW)
  await sektion.getByTestId('uebergabe-import').click()
  await expect(sektion.getByTestId('uebergabe-import-fehler')).toContainText('existiert in dieser Kassa bereits')
  await expect(sektion.getByTestId('uebergabe-import-ok')).toHaveCount(0)
  await expect(sektion.getByTestId('uebergabe-gesperrt')).toHaveCount(0)
})

test('Export mit Sperre: Hinweis erscheint, „Sperre aufheben“ nimmt ihn wieder weg', async ({ page, request }) => {
  await anmelden(page, request)
  await page.goto('/einstellungen?bereich=system')
  const sektion = page.locator('section', { has: page.getByRole('heading', { name: 'Mandant übertragen' }) })
  await expect(sektion).toBeVisible()
  await expect(sektion.getByTestId('uebergabe-gesperrt')).toHaveCount(0)

  try {
    await sektion.getByTestId('uebergabe-export-pw').fill(UEBERGABE_PW)
    await sektion.getByTestId('uebergabe-export-pw2').fill(UEBERGABE_PW)
    await Promise.all([page.waitForEvent('download'), sektion.getByTestId('uebergabe-export').click()])
    await expect(sektion.getByTestId('uebergabe-gesperrt')).toBeVisible()
    await expect(sektion.getByTestId('uebergabe-export-ok')).toContainText('gesperrt')
  } finally {
    // Instanz in jedem Fall wieder freigeben (andere Specs müssen belegen können)
    const login = await loginAbwarten(request)
    const token = ((await login.json()) as Login).token
    await request.post('/api/mandant-uebergabe/sperre-aufheben', { headers: { Authorization: `Bearer ${token}` } })
  }
})

test('„Sperre aufheben“ im Dialog bestätigen', async ({ page, request }) => {
  await anmelden(page, request)
  const login = await loginAbwarten(request)
  const token = ((await login.json()) as Login).token
  const h = { Authorization: `Bearer ${token}` }
  await request.post('/api/mandant-uebergabe/export', { headers: h, data: { passwort: UEBERGABE_PW } })  // sperrt

  try {
    await page.goto('/einstellungen?bereich=system')
    const sektion = page.locator('section', { has: page.getByRole('heading', { name: 'Mandant übertragen' }) })
    await expect(sektion.getByTestId('uebergabe-gesperrt')).toBeVisible()
    page.once('dialog', d => d.accept())
    await sektion.getByTestId('uebergabe-sperre-aufheben').click()
    await expect(sektion.getByTestId('uebergabe-gesperrt')).toHaveCount(0)
  } finally {
    await request.post('/api/mandant-uebergabe/sperre-aufheben', { headers: h })
  }
})
