import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Kellner-App: Zuordnung des Handys zur Kassa (Einrichtungs-QR) und Anmeldung — gegen das gebaute
 * Kellner-Bundle (vite preview, Port 5178) mit echtem Backend.
 *
 *  1. Läuft die Anmeldung ab (Token 8 h), fragt das Handy wieder nach der PIN. Früher löschte schon
 *     das erste 401 auch die Zuordnung zur Kassa, und jedes Handy verlangte nach einer Nacht den
 *     Geräte-QR neu.
 *  2. Der Einrichtungs-QR eines ANDEREN Betriebs ersetzt die alte Zuordnung. Früher blieb das Handy
 *     bei der alten Kasse hängen: jede PIN meldete „PIN ungültig", der neue QR änderte nichts.
 *  3. Kennt die Kassa die Kasse des Handys nicht mehr (Datenbank neu aufgesetzt), wird die Zuordnung
 *     verworfen und der QR verlangt — statt endlos „PIN ungültig".
 *
 * Dateiname mit zz-Präfix: Spec-Dateien laufen bei workers:1 alphabetisch — die Instanz richtet das
 * Onboarding ein; für Solo-Läufe legt adminLogin() sie notfalls selbst per API an (FO_STUB).
 */

const KELLNER_URL    = 'http://127.0.0.1:5178'
const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({
  viewport: { width: 390, height: 844 }, // iPhone 13
  hasTouch: true,
  isMobile: true,
})

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Kellner GmbH',
        uid:        'ATU87654321',
        kassenId:   'E2E-KELLNER-001',
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
  return res.json() as Promise<{
    token: string
    user: unknown
    mandant: { id: string }
    kassen: { id: string }[]
  }>
}

/** Erste Verbindung Kellner-Preview-Proxy → Backend absichern (Windows: erster Connect kann ~21 s hängen). */
async function warmup(page: import('@playwright/test').Page) {
  await expect.poll(
    async () => (await page.request.get(`${KELLNER_URL}/api/health`)).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)
}

const lokal = (page: import('@playwright/test').Page, schluessel: string) =>
  page.evaluate((k) => localStorage.getItem(k), schluessel)

test('abgelaufene Anmeldung: das Handy fragt wieder nach der PIN — die Zuordnung zur Kassa bleibt', async ({ page, request }) => {
  const login     = await adminLogin(request)
  const mandantId = login.mandant.id
  const kasseId   = login.kassen[0]!.id

  // Ein Token, das das Backend mit 401 beantwortet, plus die Zuordnung eines eingerichteten Handys.
  // addInitScript läuft bei jedem Laden — hier gibt es genau eines (der Wechsel zur Login-Seite ist clientseitig).
  await page.addInitScript((d: { auth: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kellner:token', 'abgelaufen')
    localStorage.setItem('kellner:auth', d.auth)
    localStorage.setItem('kellner:mandantId', d.mandantId)
    localStorage.setItem('kellner:kasseId', d.kasseId)
  }, { auth: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }), mandantId, kasseId })

  await warmup(page)
  await page.goto(`${KELLNER_URL}/`)

  await expect(page.getByText('PIN eingeben')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('noch nicht eingerichtet')).toHaveCount(0)
  expect(await lokal(page, 'kellner:kasseId')).toBe(kasseId)
  expect(await lokal(page, 'kellner:mandantId')).toBe(mandantId)
  expect(await lokal(page, 'kellner:token')).toBeNull()
})

test('QR eines anderen Betriebs: die alte Zuordnung weicht, das Handy richtet sich neu ein', async ({ page, request }) => {
  const login     = await adminLogin(request)
  const mandantId = login.mandant.id
  const kasseId   = login.kassen[0]!.id
  const anderer   = '99999999-9999-4999-8999-999999999999'

  await page.addInitScript((d: { token: string; auth: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kellner:token', d.token)
    localStorage.setItem('kellner:auth', d.auth)
    localStorage.setItem('kellner:mandantId', d.mandantId)
    localStorage.setItem('kellner:kasseId', d.kasseId)
  }, { token: login.token, auth: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }), mandantId, kasseId })

  await warmup(page)
  await page.goto(`${KELLNER_URL}/?mandantId=${anderer}`)

  // Einrichtungsschritt des neuen Betriebs statt der Tische des alten: Zuordnung und Anmeldung des alten sind weg
  // (der neue Betrieb wird erst mit der Kassenwahl gemerkt)
  await expect(page.getByText('Kasse auswählen')).toBeVisible({ timeout: 15_000 })
  expect(await lokal(page, 'kellner:mandantId')).toBeNull()
  expect(await lokal(page, 'kellner:kasseId')).toBeNull()
  expect(await lokal(page, 'kellner:token')).toBeNull()
})

test('Kassa kennt die Kasse des Handys nicht mehr: Zuordnung wird verworfen, der QR verlangt', async ({ page, request }) => {
  const login     = await adminLogin(request)
  const unbekannt = '88888888-8888-4888-8888-888888888888'

  await page.addInitScript((d: { mandantId: string; kasseId: string }) => {
    localStorage.setItem('kellner:mandantId', d.mandantId)
    localStorage.setItem('kellner:kasseId', d.kasseId)
  }, { mandantId: login.mandant.id, kasseId: unbekannt })

  await warmup(page)
  await page.goto(`${KELLNER_URL}/login`)

  await expect(page.getByText('noch nicht eingerichtet')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('passt nicht mehr zur Kassa')).toBeVisible()
  expect(await lokal(page, 'kellner:kasseId')).toBeNull()
})
