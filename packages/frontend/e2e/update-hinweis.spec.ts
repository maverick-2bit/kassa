import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

/**
 * Update-Hinweis der Kassa (Bundle-Drift): Meldet das Backend eine andere
 * installierte Version als dieses Bundle, steht an der Stelle des Versions-
 * Badges in der Kopfleiste der Knopf „Neu laden". Früher schwebte der Hinweis
 * unten mittig über allem (z-60): am POS auf „Bar" und „Leeren" und über jedem
 * Dialog, auch über der laufenden Kartenzahlung — ein Fehlgriff lud neu und
 * verwarf den Warenkorb.
 *
 * Gegen das gebaute Bundle im Kiosk-Format 1280×800. Die installierte Version
 * steuert page.route (echte Antwort, nur `installiert` ersetzt), die Uhr
 * page.clock — so erfährt die offene Kasse beim 5-Minuten-Abgleich davon, ohne
 * dass die Minuten echt vergehen.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({
  viewport: { width: 1280, height: 800 },
  // page.route sieht keine Anfragen, die ein Service Worker kontrolliert
  serviceWorkers: 'block',
})

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
        firmenname: 'E2E Update-Hinweis GmbH',
        uid:        'ATU87654330',
        kassenId:   'E2E-UPDATE-001',
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

/** Installierte Version umschaltbar: null = echte Antwort (= Bundle-Version) */
async function steuereInstallierteVersion(page: Page) {
  const server = { installiert: null as string | null }
  await page.route('**/api/system/status*', async (route) => {
    const echt = await route.fetch()
    if (!server.installiert) return route.fulfill({ response: echt })
    const json = await echt.json() as Record<string, unknown>
    return route.fulfill({ response: echt, json: { ...json, installiert: server.installiert } })
  })
  return server
}

/** Lage der Knöpfe, die am POS im Verkauf gedrückt werden */
async function lageDerZahlknoepfe(page: Page) {
  const lage: Record<string, unknown> = {}
  for (const name of ['Bar', 'Karte', 'Leeren', 'Bonieren']) {
    lage[name] = await page.getByRole('button', { name: new RegExp(`^${name}( \\(|$)`) }).boundingBox()
  }
  return lage
}

/** Liegt das Element an seinem Mittelpunkt zuoberst (also bedienbar)? */
async function zuoberst(el: Locator) {
  // „Leeren"/„Bonieren" liegen bei 800 px Höhe schon ohne Hinweis unter dem Falz
  await el.scrollIntoViewIfNeeded()
  return el.evaluate((e) => {
    const r = e.getBoundingClientRect()
    const oben = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!oben && e.contains(oben)
  })
}

/** Sichtbare Bedienelemente außerhalb des Hinweises, deren Fläche er schneidet */
async function ueberlappteBedienelemente(hinweis: Locator) {
  return hinweis.evaluate((h) => {
    const hr = h.getBoundingClientRect()
    const namen: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')) {
      if (h.contains(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const x = Math.min(r.right, hr.right) - Math.max(r.left, hr.left)
      const y = Math.min(r.bottom, hr.bottom) - Math.max(r.top, hr.top)
      if (x > 0 && y > 0) namen.push((el.innerText || el.getAttribute('aria-label') || el.tagName).trim())
    }
    return namen
  })
}

test.describe('Kassa: Update-Hinweis bei offener Seite', () => {

test('erscheint mitten im Verkauf in der Kopfleiste: nichts verrutscht, nichts verdeckt, die Kartenzahlung deckt ihn ab', async ({ page, request }) => {
  // Warmup: erste Verbindung Preview-Proxy → Backend absichern (Muster onboarding)
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }
  const kasseId    = login.kassen[0]!.id

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const praefix = `Upd${Date.now()}`
  const artikel: { id: string; bezeichnung: string }[] = []
  for (let i = 1; i <= 6; i++) {
    artikel.push(await (await request.post('/api/artikel', {
      headers: authHeader,
      data: { bezeichnung: `${praefix}-${i}`, preisBruttoCent: 150 * i, mwstSatz: 'normal' },
    })).json() as { id: string; bezeichnung: string })
  }
  // Kartenterminal im Stub-Modus: „Karte" führt über den ZVT-Dialog
  const zvt = await request.patch(`/api/kassen/${kasseId}/zvt`, {
    headers: authHeader, data: { zvtIp: 'stub', zvtAktiv: true },
  })
  expect(zvt.ok()).toBe(true)

  try {
    const server = await steuereInstallierteVersion(page)
    await anmelden(page, login)
    await page.clock.install()
    await page.goto('/kasse')

    // Verkauf läuft: sechs Positionen im Warenkorb
    const suche = page.getByPlaceholder(/Artikel suchen/)
    await suche.fill(praefix)
    for (const a of artikel) {
      await page.getByRole('button', { name: a.bezeichnung }).first().click()
    }
    await suche.fill('')
    await expect(page.getByTitle('Menge eingeben')).toHaveCount(6)
    const hinweis = page.getByRole('banner').getByRole('button', { name: 'Neu laden' })
    await expect(hinweis).toHaveCount(0)
    const vorher = await lageDerZahlknoepfe(page)

    // Update eingespielt — die offene Kasse erfährt es beim nächsten Abgleich
    server.installiert = '99.0.0'
    await page.clock.fastForward('05:30')
    await expect(hinweis).toBeVisible()
    await expect(hinweis).toHaveAttribute('title', /Version v99\.0\.0 ist installiert — diese Ansicht läuft noch auf v/)

    // Nichts verrutscht, nichts verdeckt, der Warenkorb ist unverändert
    expect(await lageDerZahlknoepfe(page)).toEqual(vorher)
    expect(await ueberlappteBedienelemente(hinweis)).toEqual([])
    for (const name of [/^Bar \(/, /^Karte \(/, /^Leeren$/, /^Bonieren$/]) {
      expect(await zuoberst(page.getByRole('button', { name }))).toBe(true)
    }
    await expect(page.getByTitle('Menge eingeben')).toHaveCount(6)

    // Kartenzahlung, das Terminal wartet auf die PIN: der Dialog liegt über dem
    // Hinweis — „Neu laden" ist währenddessen nicht erreichbar
    await page.route('**/api/zvt/zahlung/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const jobId = new URL(route.request().url()).pathname.split('/').pop()!
      return route.fulfill({ json: {
        id: jobId, status: 'autorisiere', betragCent: 3150,
        meldung: 'Karte eingesteckt — PIN-Eingabe', gestartetAm: new Date().toISOString(),
      } })
    })
    await page.getByRole('button', { name: /^Karte \(/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await zuoberst(hinweis)).toBe(false)
    await page.getByRole('button', { name: 'Weiter →' }).click()
    await expect(page.getByText('Zahlung am Terminal')).toBeVisible()
    expect(await zuoberst(hinweis)).toBe(false)

    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await zuoberst(hinweis)).toBe(true)
  } finally {
    // Aufräumen — spätere Specs teilen sich die Instanz
    await request.patch(`/api/kassen/${kasseId}/zvt`, { headers: authHeader, data: { zvtAktiv: false, zvtIp: null } })
    for (const a of artikel) await request.delete(`/api/artikel/${a.id}`, { headers: authHeader })
  }
})

test('Tablet hochkant: die Kopfleiste bricht nicht um, wenn „Neu laden" erscheint', async ({ page, request }) => {
  // Voll ausgebautes Admin-Menü → die Navigation steht in mehreren Zeilen;
  // der Knopf braucht dennoch keinen Platz, den das Badge nicht schon hatte.
  await page.setViewportSize({ width: 768, height: 1024 })
  const login  = await adminLogin(request)
  const server = await steuereInstallierteVersion(page)
  await anmelden(page, login)
  await page.clock.install()
  await page.goto('/kasse')

  const kopfleiste = page.getByRole('banner')
  await expect(kopfleiste.getByRole('link', { name: /^⟳ v\d/ })).toBeVisible()
  const hoeheVorher = (await kopfleiste.boundingBox())?.height

  server.installiert = '99.0.0'
  await page.clock.fastForward('05:30')
  await expect(kopfleiste.getByRole('button', { name: 'Neu laden' })).toBeVisible()
  expect((await kopfleiste.boundingBox())?.height).toBe(hoeheVorher)
})

test('„Neu laden" lädt neu — danach passen Bundle und Backend, das Versions-Badge ist zurück', async ({ page, request }) => {
  const login  = await adminLogin(request)
  const server = await steuereInstallierteVersion(page)
  server.installiert = '99.0.0'
  await anmelden(page, login)
  await page.goto('/kasse')

  const kopfleiste = page.getByRole('banner')
  const hinweis    = kopfleiste.getByRole('button', { name: 'Neu laden' })
  await expect(hinweis).toBeVisible()
  await expect(kopfleiste.getByRole('link', { name: /^⟳ v\d/ })).toHaveCount(0)

  server.installiert = null
  await page.evaluate(() => { (window as { vorDemNeuladen?: boolean }).vorDemNeuladen = true })
  await Promise.all([page.waitForEvent('load'), hinweis.click()])
  expect(await page.evaluate(() => (window as { vorDemNeuladen?: boolean }).vorDemNeuladen)).toBeUndefined()

  await expect(kopfleiste.getByRole('link', { name: /^⟳ v\d/ })).toBeVisible()
  await expect(kopfleiste.getByRole('button', { name: /laden$/ })).toHaveCount(0)
})

})
