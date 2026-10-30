import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Hilfe-Fenster: der Knopf „? Hilfe" in der Kopfleiste öffnet die Erklärung zur gerade offenen Seite; darunter alle Themen
 * und eine Suche. Mieter einer Leih-Kassa kommen so ohne Anleitung zurecht.
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript — es wird kein Passwort in die Maske getippt.
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

async function anmelden(page: Page, login: Login) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    if (sessionStorage.getItem('e2e:angemeldet')) return
    sessionStorage.setItem('e2e:angemeldet', '1')
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })
}

test('Hilfe: Knopf in der Kopfleiste, Erklärung zur Seite, alle Themen und Suche', async ({ page, request }) => {
  const login = await adminLogin(request)
  await anmelden(page, login)

  const knopf  = page.getByTestId('hilfe-knopf')
  const fenster = page.getByRole('dialog')

  await test.step('Kasse: der Knopf öffnet die Erklärung zur Kasse', async () => {
    await page.goto('/kasse')
    await expect(knopf).toBeVisible()
    await knopf.click()
    await expect(fenster.getByRole('heading', { name: 'Hilfe' })).toBeVisible()
    await expect(fenster.getByTestId('hilfe-thema-kasse')).toBeVisible()
    await expect(fenster.getByText('Zu dieser Seite')).toBeVisible()
    await expect(fenster.getByText('+ Rabatt hinzufügen')).toBeVisible()
  })

  await test.step('Alle Themen: ein Klick zeigt ein anderes Thema, der Rückweg führt zur Seite zurück', async () => {
    await fenster.getByTestId('hilfe-themen').getByRole('button', { name: 'Tagesabschluss (Z-Bon)' }).click()
    await expect(fenster.getByTestId('hilfe-thema-tagesabschluss')).toBeVisible()
    await expect(fenster.getByText('Z-Bon drucken', { exact: false }).first()).toBeVisible()
    await fenster.getByRole('button', { name: /zurück zu „Kasse/ }).click()
    await expect(fenster.getByTestId('hilfe-thema-kasse')).toBeVisible()
  })

  await test.step('Suche: „storno" führt zu Belege & Storno', async () => {
    await fenster.getByTestId('hilfe-suche').fill('storno')
    const treffer = fenster.getByTestId('hilfe-treffer')
    await expect(treffer.getByRole('button', { name: /Belege & Storno/ })).toBeVisible()
    await treffer.getByRole('button', { name: /Belege & Storno/ }).click()
    await expect(fenster.getByTestId('hilfe-thema-belege')).toBeVisible()
    await expect(fenster.getByText('Storno bestätigen').first()).toBeVisible()
  })

  await test.step('Nichts gefunden: freundlicher Hinweis statt leerer Liste', async () => {
    await fenster.getByTestId('hilfe-suche').fill('qwertzuiop')
    await expect(fenster.getByText('Dazu gibt es keinen Hilfetext')).toBeVisible()
  })

  await test.step('Esc schließt, und auf einer anderen Seite öffnet sich deren Thema', async () => {
    await page.keyboard.press('Escape')
    await expect(fenster).toHaveCount(0)
    await page.goto('/berichte')
    await knopf.click()
    await expect(fenster.getByTestId('hilfe-thema-berichte')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(fenster).toHaveCount(0)
  })
})
