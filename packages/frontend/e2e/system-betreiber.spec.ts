import { test, expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Betreiber der Installation (Sicherheitsprüfung 2026-11).
 *
 * Eine Installation hostet mehrere Mandanten. Datenbank-Sicherung (die GANZE Datenbank), Update, Systemwerte und
 * weitere Mandanten sind Sache des Betreibers — der erste Admin der Installation (hier der aus dem Onboarding) —
 * und nicht jedes Mandanten-Admins. Und die Einrichtungsseite legt auf einer eingerichteten Installation nur noch
 * für den angemeldeten Betreiber einen weiteren Mandanten an.
 *
 *  1. Betreiber: sieht in Einstellungen → System Datenbank-Backups, Systemwerte und „Weiteren Mandanten anlegen"
 *  2. Zweiter Admin desselben Mandanten (kein Betreiber): sieht das alles nicht, die Einrichtungsseite sagt warum
 *  3. Ohne Anmeldung: die Einrichtungsseite ist gesperrt, die Anmeldung bietet keine „Kasse einrichten" mehr an;
 *     die API antwortet 403 (ohne Einrichtungs-Schlüssel — dafür ein eigener Kontext ohne den Header der Testläufe)
 *  4. Der Betreiber legt über die Seite einen weiteren Mandanten an; das Gerät bleibt bei seinem Mandanten
 *
 * Der Dateiname sortiert hinter onboarding.spec.ts: das Onboarding richtet die Instanz über das Setup-Formular ein
 * (frische Datenbank nötig) und macht ihren Admin zum Betreiber.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const ZWEITER_EMAIL  = 'e2e-kein-betreiber@test.at'

test.use({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
test.setTimeout(150_000)

type Login = { token: string; user: { id: string; istBetreiber: boolean }; mandant: { id: string }; kassen: { id: string }[] }

/** /api/auth/login ist je IP auf 10/min begrenzt (429) — abwarten statt scheitern. */
async function loginAbwarten(request: APIRequestContext, email: string, passwort: string) {
  const body = { data: { email, passwort } }
  for (let versuch = 0; versuch < 6; versuch++) {
    const res = await request.post('/api/auth/login', body)
    if (res.status() !== 429) return res
    const sekunden = Math.min(Math.max(Number(res.headers()['retry-after']) || 10, 2), 65)
    await new Promise(r => setTimeout(r, sekunden * 1000))
  }
  return request.post('/api/auth/login', body)
}

const gemerkt: Record<string, Login> = {}
async function login(request: APIRequestContext, email: string, passwort: string): Promise<Login> {
  if (gemerkt[email]) return gemerkt[email]!
  let res = await loginAbwarten(request, email, passwort)
  if (!res.ok() && email === ADMIN_EMAIL) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true); ihr erster Admin ist der Betreiber
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Betreiber GmbH', uid: 'ATU87654335', kassenId: 'E2E-BT-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request, email, passwort)
  }
  if (!res.ok()) throw new Error(`Login ${email} fehlgeschlagen (${res.status()}): ${await res.text()}`)
  gemerkt[email] = (await res.json()) as Login
  return gemerkt[email]!
}

/** Zweiter Admin im Mandanten des Betreibers — vom Betreiber angelegt, selbst kein Betreiber. */
async function zweiterAdmin(request: APIRequestContext): Promise<Login> {
  const betreiber = await login(request, ADMIN_EMAIL, ADMIN_PASSWORT)
  const res = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${betreiber.token}` },
    data: { name: 'E2E Zweiter Admin', email: ZWEITER_EMAIL, passwort: ADMIN_PASSWORT, rolle: 'admin', berechtigungen: [], kassenIds: [] },
  })
  if (!res.ok() && res.status() !== 409) throw new Error(`Benutzer anlegen fehlgeschlagen (${res.status()}): ${await res.text()}`)
  return login(request, ZWEITER_EMAIL, ADMIN_PASSWORT)
}

/** Anmeldung in den Browser legen (Muster der übrigen Specs) */
async function anmelden(page: Page, l: Login) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: l.token, authJson: JSON.stringify({ user: l.user, mandant: l.mandant, kassen: l.kassen }),
    mandantId: l.mandant.id, kasseId: l.kassen[0]!.id,
  })
}

/** Gültige Einrichtungs-Eingabe für die API (eindeutige UID/E-Mail je Lauf — Wiederholungen derselben Datei bleiben möglich) */
function einrichtung(zusatz = '') {
  const nr = String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
  return {
    firmenname: `E2E Zweitbetrieb ${zusatz}${nr}`, uid: `ATU${nr}`, kassenId: `E2E-BT-${nr.slice(-4)}`, umgebung: 'test',
    finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
    admin: { name: 'E2E Zweitbetrieb', email: `e2e-zweitbetrieb-${nr}@test.at`, passwort: 'e2e-passwort-12345' },
  }
}

test.describe.serial('Betreiber der Installation', () => {

  test('Betreiber: Einstellungen → System zeigt Datenbank-Backups, Systemwerte und „Weiteren Mandanten anlegen"', async ({ page, request }) => {
    await expect.poll(
      async () => (await request.get('/api/health')).status(),
      { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
    ).toBe(200)
    const betreiber = await login(request, ADMIN_EMAIL, ADMIN_PASSWORT)
    expect(betreiber.user.istBetreiber).toBe(true)
    await anmelden(page, betreiber)

    await page.goto('/einstellungen?bereich=system')
    await expect(page.getByRole('heading', { name: 'Datenbank-Backups' })).toBeVisible()
    await expect(page.getByTestId('mandant-anlegen')).toBeVisible()
    await expect(page.getByTestId('uebergabe-import-datei')).toBeVisible()
    await expect(page.getByText('Prozess-Speicher')).toBeVisible()
  })

  test('zweiter Admin (kein Betreiber): sieht Sicherung, Systemwerte und Mandanten-Anlage nicht', async ({ page, request }) => {
    const zweiter = await zweiterAdmin(request)
    expect(zweiter.user.istBetreiber).toBe(false)
    await anmelden(page, zweiter)

    await page.goto('/einstellungen?bereich=system')
    await expect(page.getByRole('heading', { name: 'Systeminfo' })).toBeVisible()   // die Seite ist da
    await expect(page.getByRole('heading', { name: 'Datenbank-Backups' })).toHaveCount(0)
    await expect(page.getByTestId('mandant-anlegen')).toHaveCount(0)
    await expect(page.getByText('Prozess-Speicher')).toHaveCount(0)
    // Mandant übertragen: Exportieren des eigenen Mandanten bleibt, Einspielen ist Sache des Betreibers
    await expect(page.getByTestId('uebergabe-export')).toBeVisible()
    await expect(page.getByTestId('uebergabe-import-nur-betreiber')).toBeVisible()
    await expect(page.getByTestId('uebergabe-import-datei')).toHaveCount(0)

    // Der Betreiber ist in der Benutzerverwaltung gekennzeichnet, der zweite Admin nicht
    await page.goto('/benutzer')
    await expect(page.getByTestId('betreiber-markierung')).toHaveCount(1)
  })

  test('die Einrichtungsseite sagt dem zweiten Admin, dass nur der Betreiber Mandanten anlegt', async ({ page, request }) => {
    await anmelden(page, await zweiterAdmin(request))

    await page.goto('/setup')
    const hinweis = page.getByTestId('setup-gesperrt')
    await expect(hinweis).toContainText('Nur der Betreiber legt weitere Mandanten an')
    await expect(page.locator('#firmenname')).toHaveCount(0)   // kein Formular
  })

  test('ohne Anmeldung: Einrichtungsseite gesperrt, Anmeldung bietet keine Einrichtung an, API sagt 403', async ({ page, request }) => {
    // Seite
    await page.goto('/setup')
    await expect(page.getByTestId('setup-gesperrt')).toContainText('bereits eingerichtet')
    await expect(page.getByRole('link', { name: 'Zur Anmeldung' })).toBeVisible()
    await expect(page.locator('#firmenname')).toHaveCount(0)

    // Anmeldeseite: kein „Noch keine Kasse? Kasse einrichten" auf einer eingerichteten Installation
    await page.goto('/login?konto=neu')
    await expect(page.getByLabel('E-Mail')).toBeVisible()
    await expect(page.getByText('Noch keine Kasse?')).toHaveCount(0)

    // API: ein Kontext OHNE den Einrichtungs-Schlüssel der Testläufe. Weder anonym noch mit dem Token eines
    // normalen Admins wird irgendetwas angelegt. (Auch playwright.request.newContext() erbt die
    // extraHTTPHeaders der Konfiguration — ein leerer Wert überschreibt den Schlüssel; ohne das legte dieser
    // "anonyme" Aufruf mit dem Schlüssel des Testlaufs tatsächlich einen Mandanten an: 201.)
    const ohneSchluessel = await playwrightRequest.newContext({
      baseURL: 'http://127.0.0.1:5173', extraHTTPHeaders: { 'x-setup-token': '' },
    })
    try {
      const anonym = await ohneSchluessel.post('/api/setup', { data: einrichtung() })
      expect(anonym.status()).toBe(403)
      expect((await anonym.json()).fehler).toMatch(/Betreiber/)

      const zweiter = await zweiterAdmin(request)
      const normaler = await ohneSchluessel.post('/api/setup', {
        headers: { Authorization: `Bearer ${zweiter.token}` }, data: einrichtung(),
      })
      expect(normaler.status()).toBe(403)

      // falscher Schlüssel
      const falsch = await ohneSchluessel.post('/api/setup', {
        headers: { 'x-setup-token': 'e2e-falscher-schluessel-0123456789' }, data: einrichtung(),
      })
      expect(falsch.status()).toBe(403)
    } finally {
      await ohneSchluessel.dispose()
    }
  })

  test('Betreiber legt über die Einrichtungsseite einen weiteren Mandanten an — das Gerät bleibt bei seinem Mandanten', async ({ page, request }) => {
    const betreiber = await login(request, ADMIN_EMAIL, ADMIN_PASSWORT)
    await anmelden(page, betreiber)
    const neu = einrichtung('UI ')

    await page.goto('/einstellungen?bereich=system')
    await page.getByTestId('mandant-anlegen-oeffnen').click()
    await expect(page.getByRole('heading', { name: 'Weiteren Mandanten anlegen' })).toBeVisible()
    await expect(page.locator('#firmenname')).toBeVisible()

    await page.fill('#firmenname', neu.firmenname)
    await page.fill('#uid', neu.uid)
    await page.fill('#kassenId', neu.kassenId)
    await page.fill('#admin-name', neu.admin.name)
    await page.fill('#admin-email', neu.admin.email)
    await page.fill('#admin-passwort', neu.admin.passwort)
    await page.getByRole('button', { name: 'Kasse einrichten' }).click()

    await expect(page.getByRole('heading', { name: 'Kasse erfolgreich eingerichtet' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /Am neuen Mandanten anmelden/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Zur Kasse/ })).toHaveCount(0)

    // Das Gerät gehört weiter dem ersten Mandanten (sonst meldete es sich plötzlich am neuen an)
    const identitaet = await page.evaluate(() => localStorage.getItem('kassa:mandantId'))
    expect(identitaet).toBe(betreiber.mandant.id)

    // Der neue Admin kann sich anmelden — und ist KEIN Betreiber
    const res = await loginAbwarten(request, neu.admin.email, neu.admin.passwort)
    expect(res.ok()).toBe(true)
    const neuerAdmin = (await res.json()) as Login
    expect(neuerAdmin.user.istBetreiber).toBe(false)
    expect(neuerAdmin.mandant.id).not.toBe(betreiber.mandant.id)
  })
})
