import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

/**
 * Kassa im LAN ohne Internet — Sicht des Browsers (Tablet/Kassen-PC): Jede Anfrage, die nicht an
 * die Kassa im lokalen Netz geht, wird abgebrochen und mitgeschrieben. Kasse und Kellner-App müssen
 * vollständig laden und kassieren können, ohne dass der Browser auch nur einmal ins Internet will.
 * (Die Seite des Backends — A-Trust, Mail, Drucker, KDS — prüft tests/integration/lan-ohne-internet.)
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

// Ohne Service Worker sieht das Routing jede Anfrage (mit SW liefen manche an ihm vorbei)
test.use({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })

type Login = { token: string; mandant: { id: string }; kassen: { id: string }[] }

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E LAN GmbH', uid: 'ATU87654334', kassenId: 'E2E-LAN-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test',
        admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return res.json() as Promise<Login>
}

async function anmelden(page: Page, request: APIRequestContext, login: Login) {
  const ich = await (await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${login.token}` } })).json() as
    { user: unknown; mandant: { id: string }; kassen: { id: string }[] }
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, { token: login.token, authJson: JSON.stringify(ich), mandantId: ich.mandant.id, kasseId: login.kassen[0]!.id })
}

/** Internet weg: alles außer der Kassa im LAN wird abgebrochen und protokolliert */
async function internetWeg(context: BrowserContext): Promise<string[]> {
  const extern: string[] = []
  await context.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), async (route) => {
    extern.push(route.request().url())
    await route.abort('internetdisconnected')
  })
  return extern
}

test('Kasse lädt, kassiert und zeigt Einstellungen — ohne eine einzige Anfrage ins Internet', async ({ page, context, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000] }).toBe(200)
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const artikel = await (await request.post('/api/artikel', {
    headers: auth, data: { bezeichnung: `LAN-Gulasch ${Date.now() % 100000}`, preisBruttoCent: 990, mwstSatz: 'ermaessigt1' },
  })).json() as { id: string; bezeichnung: string }

  try {
    const extern = await internetWeg(context)
    await anmelden(page, request, login)

    await page.goto('/kasse')
    const suche = page.getByPlaceholder(/Artikel suchen/)
    await suche.fill(artikel.bezeichnung)
    await page.getByRole('button', { name: artikel.bezeichnung }).first().click()
    await suche.fill('')
    const start = Date.now()
    await page.getByRole('button', { name: /^Bar \(/ }).click()
    await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 10_000 })
    expect(Date.now() - start).toBeLessThan(5_000)

    // Nicht auf „networkidle" warten: die Live-Verbindungen (SSE) der Kassa bleiben offen
    for (const pfad of ['/dashboard', '/einstellungen?bereich=kassen', '/einstellungen?bereich=system']) {
      await page.goto(pfad)
      await expect(page.getByRole('heading').first()).toBeVisible()
      await page.waitForTimeout(1_500)
    }
    expect(extern).toEqual([])
  } finally {
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
  }
})

test('Kellner-App lädt ohne Anfrage ins Internet', async ({ page, context }) => {
  const extern = await internetWeg(context)
  await page.goto('http://127.0.0.1:5178/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('body')).not.toBeEmpty()
  await expect(page.locator('#root')).not.toBeEmpty()
  expect(extern).toEqual([])
})
