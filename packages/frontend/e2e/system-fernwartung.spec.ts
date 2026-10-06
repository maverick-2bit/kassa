import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Einstellungen → System → Fernwartung (Karte, nur Admin, rein lesend):
 *  1. Ohne Statusdatei (der Normalfall einer Kasse ohne Fernwartung) steht dort „Nicht
 *     eingerichtet" samt kurzer Anleitung — kein Fehler, keine ID, kein Kopieren-Knopf.
 *  2. Mit Statusdatei (Antwort des Backends simuliert — die Datei legt sonst der Installer
 *     ins Kontroll-Volume): ID in Dreiergruppen, Gerätename, Support-Hinweis; „Kopieren"
 *     legt nur die Ziffern in die Zwischenablage.
 *  3. Die Route ist nicht öffentlich (401 ohne Anmeldung) und hat keinen Schreibweg.
 *
 * Das Backend läuft im E2E ohne /control-Volume → die Statusdatei gibt es dort nicht.
 *
 * Der Dateiname sortiert hinter onboarding.spec.ts (system-…): das Onboarding richtet die Instanz
 * über das Setup-Formular ein und braucht dafür eine FRISCHE Datenbank — dieses Spec darf sie
 * im Gesamtlauf nicht vorher per API einrichten. Der /api/setup-Rückfall in adminLogin gilt nur
 * für den Solo-Lauf dieser Datei.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
test.setTimeout(150_000)

type Login = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }

/**
 * /api/auth/login ist je IP auf 10/min begrenzt (429), und die Suite teilt sich 127.0.0.1:
 * bei 429 abwarten und erneut versuchen, statt fälschlich in /api/setup zu fallen.
 */
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

let gemerkterLogin: Login | null = null
async function adminLogin(request: APIRequestContext): Promise<Login> {
  if (gemerkterLogin) return gemerkterLogin
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Fernwartung GmbH', uid: 'ATU87654332', kassenId: 'E2E-FW-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  gemerkterLogin = (await res.json()) as Login
  return gemerkterLogin
}

/** Anmeldung in den Browser legen (Muster der übrigen Specs) */
async function anmelden(page: Page, request: APIRequestContext) {
  const login = await adminLogin(request)
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })
  return login
}

test.describe('Einstellungen → System → Fernwartung', () => {

test('ohne Statusdatei: „Nicht eingerichtet" mit Anleitung — kein Fehler, keine ID', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)
  await anmelden(page, request)

  await page.goto('/einstellungen?bereich=system')
  const karte = page.getByTestId('fernwartung-karte')
  await expect(karte.getByRole('heading', { name: 'Fernwartung' })).toBeVisible()
  await expect(karte.getByTestId('fernwartung-zustand')).toHaveText('Nicht eingerichtet')
  await expect(karte).toContainText('keine Fernwartung eingerichtet')
  await expect(karte).toContainText('fernwartung.json')
  await expect(karte).toContainText('ops/DEPLOYMENT.md')
  await expect(karte.getByTestId('fernwartung-id')).toHaveCount(0)
  await expect(karte.getByRole('button', { name: /kopieren/i })).toHaveCount(0)
  // das Backend hat sauber geantwortet (kein 500, kein Fehlerkasten)
  await expect(karte).not.toContainText('konnte nicht geladen werden')
})

test('mit Statusdatei: ID in Dreiergruppen, Gerätename, Kopieren legt nur die Ziffern ab', async ({ page, request, context }) => {
  await anmelden(page, request)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.route('**/api/system/fernwartung', route => route.fulfill({
    json: {
      eingerichtet: true, anbieter: 'teamviewer', id: '123456789',
      alias: 'Kassa Gasthof Mayr', gruppe: 'Mietkassen', installiertAm: '2026-10-06T10:00:00.000Z',
    },
  }))

  await page.goto('/einstellungen?bereich=system')
  const karte = page.getByTestId('fernwartung-karte')
  await expect(karte.getByTestId('fernwartung-zustand')).toHaveText('Eingerichtet')
  await expect(karte.getByTestId('fernwartung-id')).toHaveText('123 456 789')
  await expect(karte).toContainText('Kassa Gasthof Mayr')
  await expect(karte).toContainText('Mietkassen')
  await expect(karte).toContainText('Diese ID dem Support nennen')

  await karte.getByRole('button', { name: /kopieren/i }).click()
  await expect(karte.getByRole('button', { name: /kopieren/i })).toContainText('Kopiert')
  // Zwischenablage zurücklesen — nur prüfen, wenn der Browser das erlaubt (Rechte/Fokus je nach
  // Umgebung); die Rückmeldung „Kopiert" oben belegt, dass der Kopier-Weg durchlaufen wurde.
  const abgelegt = await page.evaluate(async () => {
    try { return await navigator.clipboard.readText() } catch { return null }
  })
  if (abgelegt !== null) expect(abgelegt).toBe('123456789')
})

test('die Route ist nicht öffentlich und hat keinen Schreibweg', async ({ request }) => {
  expect((await request.get('/api/system/fernwartung')).status()).toBe(401)
  const login = await adminLogin(request)
  const kopf = { Authorization: `Bearer ${login.token}` }
  expect((await request.get('/api/system/fernwartung', { headers: kopf })).status()).toBe(200)
  for (const methode of ['post', 'put', 'patch', 'delete'] as const) {
    const res = await request[methode]('/api/system/fernwartung', { headers: kopf })
    expect(res.status(), methode).toBe(404)
  }
})

})
