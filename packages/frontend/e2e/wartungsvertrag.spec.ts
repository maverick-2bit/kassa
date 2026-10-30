import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Wartungsverträge: Vertrag anlegen → Monatslauf (Vorschau + erzeugen) → Sammelrechnung.
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript; das Modul „angebote" wird per API aktiviert.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ serviceWorkers: 'block' })
test.setTimeout(120_000)

interface Login { token: string; user: unknown; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }

/** /api/auth/login ist auf 10 Anmeldungen je Minute begrenzt (429): abwarten statt fälschlich in /api/setup zu fallen. */
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

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-HILFE-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
  }
  return (await res.json()) as Login
}

/** Erster Tag des Monats vor drei Monaten (lokal) als YYYY-MM-DD */
function beginnVorDreiMonaten(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 3)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

test('Wartungsvertrag: anlegen, Monatslauf, Sammelrechnung durch die UI', async ({ page, request }) => {
  const login = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  const patch = await request.patch('/api/mandanten/module', { headers: authHeader, data: { ...module, modulAngeboteAktiv: true } })
  expect(patch.ok()).toBe(true)

  const kundenName = `Wartungskunde ${Date.now()}`
  const kunde = await request.post('/api/kunden', { headers: authHeader, data: { firma: kundenName } })
  expect(kunde.ok()).toBe(true)

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant: { ...login.mandant, modulAngeboteAktiv: true }, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })

  await page.goto('/wartungsvertraege')
  await expect(page.getByRole('heading', { name: 'Wartungsverträge' })).toBeVisible({ timeout: 10_000 })

  await test.step('Vertrag anlegen: monatlicher Support + jährliches Zertifikat', async () => {
    await page.getByRole('button', { name: 'Neuer Vertrag' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Kunde', { exact: false }).first().selectOption({ label: kundenName })
    await dialog.getByLabel('Vertragsbeginn').fill(beginnVorDreiMonaten())
    await expect(dialog.getByText(/Erste Abrechnung:/)).toBeVisible()

    await dialog.getByLabel('Bezeichnung Position 1').fill('Support')
    await dialog.getByLabel('Einzelpreis Position 1').fill('10,00')

    await dialog.getByRole('button', { name: '+ Position' }).click()
    await dialog.getByLabel('Bezeichnung Position 2').fill('RKSV-Zertifikat')
    await dialog.getByLabel('Einzelpreis Position 2').fill('50,00')
    await dialog.locator('#wv-pi-1').selectOption('jahr')
    // „Fällig im Monat" erscheint nur bei nicht-monatlichen Positionen
    await expect(dialog.getByText('Fällig im Monat')).toBeVisible()

    await dialog.getByRole('button', { name: 'Vertrag anlegen' }).click()
    await expect(dialog).toHaveCount(0)
  })

  const zeile = page.locator('tr', { hasText: kundenName })
  await expect(zeile).toBeVisible()
  await expect(zeile).toContainText(/W-\d{4}/)

  await test.step('Monatslauf: Vorschau zeigt die fehlenden Lieferscheine, dann erzeugen', async () => {
    await page.getByRole('button', { name: 'Monatslauf' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/Lieferscheine?$/)).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Lieferscheine jetzt erzeugen' }).click()
    await expect(dialog).toHaveCount(0)
  })

  await expect(page.locator('tr', { hasText: kundenName })).toContainText(/\d Lieferscheine?/)

  await test.step('Zur Verrechnung: Sammelrechnung erstellen', async () => {
    await page.getByRole('button', { name: /Zur Verrechnung/ }).click()
    const faellig = page.locator('tr', { hasText: kundenName })
    await expect(faellig).toBeVisible({ timeout: 10_000 })
    await faellig.getByRole('button', { name: 'Sammelrechnung erstellen' }).click()
    await expect(page.getByText(/Rechnung SR-\d{4} ausgeben/)).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Ohne Druck fortfahren' }).click()
    // Der Vertrag ist verrechnet und steht nicht mehr in der Liste
    await expect(page.locator('tr', { hasText: kundenName })).toHaveCount(0)
  })
})
