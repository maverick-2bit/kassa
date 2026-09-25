import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

/**
 * Eingabefelder behalten die Breite, die der Aufrufer setzt. Input hängte
 * `className` an seine Basis `block w-full …` an — im gebauten CSS steht `.w-full`
 * hinter `.w-20`/`.w-40`, also blieb jede Breite des Aufrufers wirkungslos:
 * Tisch und Kellner in der Kontextleiste der Kasse waren je 217 px breit, im
 * Rezept eines Artikels nahm das Mengenfeld die ganze Zeile ein (der Name des
 * Bestandteils war 0 px breit, also unsichtbar), und im Rabatt-Dialog rutschten
 * die Schnellwahl-Knöpfe unter das volle Prozentfeld.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet
 * adminLogin() die Instanz notfalls selbst ein.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ viewport: { width: 1280, height: 800 } })

type Login = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }

// Einmal je Datei anmelden: /api/auth/login ist je IP auf 10/min begrenzt,
// und die ganze Suite teilt sich 127.0.0.1 (Muster ensureAuth in onboarding).
let gemerkterLogin: Login | null = null

async function adminLogin(request: APIRequestContext): Promise<Login> {
  gemerkterLogin ??= await neuerAdminLogin(request)
  return gemerkterLogin
}

async function neuerAdminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Feldbreite GmbH',
        uid:        'ATU87654331',
        kassenId:   'E2E-FELDBREITE-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test',
        admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', {
      data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return res.json() as Promise<Login>
}

async function anmelden(page: Page, login: Login) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:     login.token,
    authJson:  JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id,
    kasseId:   login.kassen[0]!.id,
  })
}

async function breite(el: Locator) {
  return Math.round((await el.boundingBox())?.width ?? -1)
}

async function mitteY(el: Locator) {
  const box = await el.boundingBox()
  return box ? box.y + box.height / 2 : Number.NaN
}

test.describe('Eingabefelder behalten die Breite des Aufrufers', () => {
  let authHeader: Record<string, string> = {}
  let artikel = ''
  let artikelId = ''

  test.beforeAll(async ({ request }) => {
    await expect.poll(
      async () => (await request.get('/api/health')).status(),
      { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
    ).toBe(200)
    authHeader = { Authorization: `Bearer ${(await adminLogin(request)).token}` }
    // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
    artikel = `Feldbreite ${Date.now()}`
    const res = await request.post('/api/artikel', {
      headers: authHeader, data: { bezeichnung: artikel, preisBruttoCent: 450, mwstSatz: 'normal' },
    })
    expect(res.ok(), await res.text()).toBe(true)
    artikelId = ((await res.json()) as { id: string }).id
  })

  test.afterAll(async ({ request }) => {
    if (artikelId) await request.delete(`/api/artikel/${artikelId}`, { headers: authHeader })
  })

  test.beforeEach(async ({ page, request }) => {
    await anmelden(page, await adminLogin(request))
  })

  test('Kasse: Tisch 80 px, Kellner 160 px, Rabatt-Schnellwahl neben dem Prozentfeld', async ({ page }) => {
    await page.goto('/kasse')
    const tisch = page.getByPlaceholder('Schank')
    await expect(tisch).toBeVisible()
    expect(await breite(tisch)).toBe(80)                                                  // w-20
    expect(await breite(page.getByRole('textbox', { name: 'Kellner', exact: true }))).toBe(160) // w-40

    await page.getByPlaceholder(/Artikel suchen/).fill(artikel)
    await page.getByRole('button', { name: artikel }).first().click()
    await page.getByRole('button', { name: '+ Rabatt hinzufügen' }).click()
    const dialog = page.getByRole('dialog')
    const prozent = dialog.getByPlaceholder('10', { exact: true })
    await expect(prozent).toBeVisible()
    expect(await breite(prozent)).toBe(80)
    // gleiche Zeile statt umgebrochen (vorher 40 px tiefer)
    const knopf = dialog.getByRole('button', { name: '5%', exact: true })
    expect(Math.abs(await mitteY(knopf) - await mitteY(prozent))).toBeLessThan(4)
  })

  test('Artikel-Rezept: Name des Bestandteils bleibt neben dem Mengenfeld sichtbar', async ({ page }) => {
    await page.goto('/artikel')
    await page.getByRole('button', { name: '+ Neuer Artikel' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Bestandteil wählen').selectOption(artikelId)
    await dialog.getByRole('button', { name: '+ Hinzufügen' }).click()

    const menge = dialog.getByRole('spinbutton', { name: 'Menge', exact: true })
    await expect(menge).toBeVisible()
    expect(await breite(menge)).toBe(80)                                                  // w-20
    const name = menge.locator('xpath=ancestor::li[1]').getByText(artikel)
    await expect(name).toBeVisible()
    expect(await breite(name)).toBeGreaterThan(150)
  })
})
