import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Signatur-Selbsttest (Einstellungen → RKSV) und bestehende Ketten (Befund A der RKSV-Prüfstrecke).
 *
 * Belege aus Programmversionen vor der Korrektur tragen ab dem 2. Beleg die Verkettung der „Altform" (Hash des QR-Codes statt der
 * JWS-Form). Das Backend erkennt sie aus den Daten (Integrationstest rksv-selbsttest-altkette); hier geht es nur darum, was die
 * Seite daraus macht: die Altstrecke steht blau und mit Belegbereich da statt als rotes „Kette unterbrochen", eine ältere
 * Programmversion nach dem Umstieg fällt gelb auf, ein echter Bruch bleibt rot und nennt den Beleg.
 *
 * Die Antwort des Selbsttests ersetzt page.route; Gegen das gebaute Bundle im Kiosk-Format 1280×800.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({
  viewport: { width: 1280, height: 800 },
  // page.route sieht keine Anfragen, die ein Service Worker kontrolliert
  serviceWorkers: 'block',
})

type Login = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }

// Einmal je Datei anmelden: /api/auth/login ist je IP begrenzt, und die ganze Suite teilt sich 127.0.0.1.
let gemerkterLogin: Login | null = null

async function adminLogin(request: APIRequestContext): Promise<Login> {
  gemerkterLogin ??= await neuerAdminLogin(request)
  return gemerkterLogin
}

async function neuerAdminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Selbsttest GmbH',
        uid:        'ATU87654377',
        kassenId:   'E2E-SELBSTTEST-001',
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

/** Antwort des Selbsttests wie das Backend sie liefert; `ueberschreibe` setzt den Fall. */
function ergebnis(kasseId: string, ueberschreibe: Record<string, unknown> = {}) {
  return {
    kasseId, kassenId: 'E2E-SELBSTTEST-001', geprueft: 10, gueltig: 10, ausfall: 0, derAltformat: 0, zeitAltformat: 0, ungueltig: 0,
    ketteOk: true, ketteAltformat: 0, ketteAltformatVon: null, ketteAltformatBis: null, ketteGemischt: false, ketteBruchBeleg: null,
    nummernLueckenlos: true, dauerMs: 12, details: [], detailsGekappt: false,
    ...ueberschreibe,
  }
}

async function selbsttestMit(page: Page, login: Login, antwort: Record<string, unknown>) {
  await page.route('**/api/rksv/signatur-selbsttest?*', route => route.fulfill({ json: ergebnis(login.kassen[0]!.id, antwort) }))
  await anmelden(page, login)
  await page.goto('/einstellungen?bereich=rksv')
  await page.getByRole('button', { name: 'Selbsttest starten' }).click()
  await expect(page.getByText('Dauer: 12 ms')).toBeVisible()
}

test.describe('Signatur-Selbsttest: Verkettung', () => {
  test('saubere Kette: „Alles in Ordnung", kein CSV-Protokoll nötig', async ({ page, request }) => {
    await selbsttestMit(page, await adminLogin(request), {})
    await expect(page.getByText('Alles in Ordnung')).toBeVisible()
    await expect(page.getByText('✓ Signaturkette geschlossen', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /CSV-Protokoll/ })).toHaveCount(0)
  })

  test('Bestandskasse nach dem Update: Altstrecke mit Belegbereich, blau statt rot, CSV-Protokoll angeboten', async ({ page, request }) => {
    await selbsttestMit(page, await adminLogin(request), { ketteAltformat: 6, ketteAltformatVon: 2, ketteAltformatBis: 7 })
    const hinweis = page.locator('div.border-sky-200', { hasText: 'Verkettung im Altformat' })
    await expect(hinweis).toBeVisible()
    await expect(hinweis).toContainText('Belege 2–7')
    await expect(hinweis).toContainText('6 Belege')
    await expect(hinweis).toContainText('Neue Belege werden richtig verkettet')
    await expect(page.getByText('✓ Signaturkette geschlossen (Belege 2–7 im Altformat)')).toBeVisible()
    await expect(page.getByText('Kettenprüfung auffällig')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /CSV-Protokoll/ })).toBeVisible()
  })

  test('Altformat nach dem Umstieg (ältere Programmversion): gelber Hinweis, die Kette bleibt geschlossen', async ({ page, request }) => {
    await selbsttestMit(page, await adminLogin(request), { ketteAltformat: 7, ketteAltformatVon: 2, ketteAltformatBis: 10, ketteGemischt: true })
    const hinweis = page.locator('div.border-amber-200', { hasText: 'Verkettung im Altformat' })
    await expect(hinweis).toBeVisible()
    await expect(hinweis).toContainText('ältere Programmversion')
    await expect(hinweis).not.toContainText('Neue Belege werden richtig verkettet')
    await expect(page.getByText('✓ Signaturkette geschlossen (Belege 2–10 im Altformat)')).toBeVisible()
  })

  test('echter Kettenbruch bleibt rot und nennt den Beleg', async ({ page, request }) => {
    await selbsttestMit(page, await adminLogin(request), {
      ketteOk: false, ketteAltformat: 2, ketteAltformatVon: 2, ketteAltformatBis: 3, ketteBruchBeleg: 5, nummernLueckenlos: false,
    })
    const hinweis = page.locator('div.border-red-200', { hasText: 'Kettenprüfung auffällig' })
    await expect(hinweis).toBeVisible()
    await expect(hinweis).toContainText('die Verkettung ist unterbrochen (bei Beleg 5)')
    await expect(page.getByText('✗ Signaturkette unterbrochen bei Beleg 5')).toBeVisible()
    await expect(page.getByRole('button', { name: /CSV-Protokoll/ })).toBeVisible()
  })
})
