import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Kellner-App-Journey im Mobil-Viewport (iPhone-13-Maße) gegen das gebaute
 * Kellner-Bundle (vite preview, Port 5178) — die Gänge-Steuerung wird laut
 * Einsatzprofil hauptsächlich auf den mobilen Kassen bedient.
 *
 * Dateiname mit zz-Präfix: Playwright führt Spec-Dateien bei workers:1
 * alphabetisch aus — die Journey braucht die vom Onboarding (onboarding.spec.ts)
 * eingerichtete Instanz. Für Solo-Läufe (-g / einzelne Datei gegen frische DB)
 * richtet adminLogin() die Instanz notfalls selbst per API ein (FO_STUB).
 */

const KELLNER_URL    = 'http://127.0.0.1:5178'
const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const KELLNER_NAME   = 'E2E Kellner'
const KELLNER_EMAIL  = 'kellner-e2e@test.at'
const KELLNER_PIN    = '2468'

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

test.describe.serial('Kellner-App mobil', () => {

test('PIN-Login → Tisch öffnen → Gänge buchen → Gang für Gang abrufen → bar abrechnen', async ({ page, request }) => {
  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }
  const mandantId  = login.mandant.id
  const kasseId    = login.kassen[0]!.id

  // Gänge-Modul aktivieren (3 Gänge)
  await request.patch('/api/mandanten/module', {
    headers: authHeader, data: { modulGaengeAktiv: true, gaengeAnzahl: 3 },
  })

  // Kellner-User mit PIN — nur anlegen, wenn er noch fehlt (Datei-Retries!)
  const vorhandene = await (await request.get('/api/users', { headers: authHeader })).json() as Array<{ email: string }>
  if (!vorhandene.some(u => u.email === KELLNER_EMAIL)) {
    const anlage = await request.post('/api/users', {
      headers: authHeader,
      data: {
        name:           KELLNER_NAME,
        email:          KELLNER_EMAIL,
        passwort:       'kellner-passwort-123',
        rolle:          'kellner',
        berechtigungen: ['tische'],
        kassenIds:      [kasseId],
        pin:            KELLNER_PIN,
      },
    })
    if (!anlage.ok()) throw new Error(`Kellner-Anlage fehlgeschlagen (${anlage.status()}): ${await anlage.text()}`)
  }

  // Artikel seeden (eindeutig je Versuch)
  const ts        = Date.now()
  const vorspeise = `Mobil-Suppe ${ts}`
  const hauptgang = `Mobil-Steak ${ts}`
  const kat = await (await request.post('/api/kategorien', {
    headers: authHeader, data: { name: `Mobil-Kat ${ts}`, farbe: 'rot', reihenfolge: 0 },
  })).json() as { id: string }
  await request.post('/api/artikel', {
    headers: authHeader, data: { bezeichnung: vorspeise, preisBruttoCent: 450, mwstSatz: 'ermaessigt1', kategorieId: kat.id },
  })
  await request.post('/api/artikel', {
    headers: authHeader, data: { bezeichnung: hauptgang, preisBruttoCent: 1890, mwstSatz: 'ermaessigt1', kategorieId: kat.id },
  })

  // Kassen-Identität vorbelegen — der Kasse-Wähler ist Einrichtungs-Komfort,
  // getestet wird der PIN-Login selbst.
  await page.addInitScript((d: { mandantId: string; kasseId: string }) => {
    localStorage.setItem('kellner:mandantId', d.mandantId)
    localStorage.setItem('kellner:kasseId',   d.kasseId)
  }, { mandantId, kasseId })

  // Warmup: erste Verbindung Kellner-Preview-Proxy → Backend absichern (auf
  // Windows kann der allererste TCP-Connect bis ~21 s hängen; Muster onboarding).
  await expect.poll(
    async () => (await page.request.get(`${KELLNER_URL}/api/health`)).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  // ---- PIN-Login über das Numpad ----
  await page.goto(`${KELLNER_URL}/login`)
  await expect(page.getByText('PIN eingeben')).toBeVisible({ timeout: 15_000 })
  for (const ziffer of KELLNER_PIN) {
    await page.getByRole('button', { name: ziffer, exact: true }).click()
  }
  // 4. Ziffer submittet automatisch → Tischübersicht
  await expect(page.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 15_000 })
  // Nur der Header trägt „<Name> · N offen" — der Kellnername steht auch auf Tab-Karten
  await expect(page.getByText(new RegExp(`${KELLNER_NAME} · \\d+ offen`))).toBeVisible()

  // ---- Tisch öffnen ----
  const tisch = `M${ts % 100000}`
  await page.getByRole('button', { name: '+ Tisch' }).click()
  await page.getByPlaceholder(/Tisch 3 oder Bar/).fill(tisch)
  await page.getByRole('button', { name: 'Öffnen' }).click()
  await expect(page.getByRole('heading', { name: tisch })).toBeVisible({ timeout: 10_000 })

  // ---- Artikel wählen: Gang-Wähler, Artikel erben den aktiven Gang ----
  await page.getByRole('button', { name: '+ Artikel' }).click()
  await expect(page.getByRole('heading', { name: 'Artikel wählen' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sofort',  exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '3. Gang', exact: true })).toBeVisible()

  // Aktive Kategorie ist standardmäßig die ERSTE — bei Datei-Retries existieren
  // Kategorien früherer Versuche, daher explizit die eigene wählen.
  await page.getByRole('button', { name: `Mobil-Kat ${ts}` }).click()

  await page.getByRole('button', { name: '1. Gang', exact: true }).click()
  await page.locator('div.bg-panel').filter({ hasText: vorspeise }).getByRole('button', { name: '+', exact: true }).first().click()
  await page.getByRole('button', { name: '2. Gang', exact: true }).click()
  await page.locator('div.bg-panel').filter({ hasText: hauptgang }).getByRole('button', { name: '+', exact: true }).first().click()

  await page.getByRole('button', { name: /Zum Tab hinzufügen/ }).click()
  await expect(page.getByRole('heading', { name: tisch })).toBeVisible({ timeout: 10_000 })

  // ---- Tab: nach Gang gruppiert, nichts gesendet ----
  await expect(page.getByText(vorspeise)).toBeVisible()
  await expect(page.getByText(vorspeise)).not.toHaveClass(/line-through/)
  await expect(page.getByText(hauptgang)).not.toHaveClass(/line-through/)

  // ---- 1. Gang abrufen → Vorspeise durchgestrichen, ↻ nachschickbar ----
  await page.getByRole('button', { name: /1\. Gang abrufen/ }).click()
  await expect(page.getByText(vorspeise)).toHaveClass(/line-through/, { timeout: 10_000 })
  await expect(page.getByText(hauptgang)).not.toHaveClass(/line-through/)
  await expect(page.getByRole('button', { name: /2\. Gang abrufen/ })).toBeVisible()

  await page.getByRole('button', { name: '↻ nochmal schicken' }).first().click()
  await expect(page.getByText(vorspeise)).toHaveClass(/line-through/)

  // ---- 2. Gang abrufen → alles gesendet, kein Abruf-Button mehr ----
  await page.getByRole('button', { name: /2\. Gang abrufen/ }).click()
  await expect(page.getByText(hauptgang)).toHaveClass(/line-through/, { timeout: 10_000 })
  await expect(page.getByRole('button', { name: /Gang abrufen/ })).toHaveCount(0)

  // ---- Bar abrechnen → Bezahlt-Screen (RKSV-Beleg) → Fertig → Tischübersicht ----
  await page.getByRole('button', { name: /💶 Bar/ }).click()
  await expect(page.getByText('Bezahlt', { exact: true })).toBeVisible({ timeout: 15_000 })
  // Abschluss-Button heißt je nach Belegmodus „Fertig" (Druck) oder „Akzeptiert"
  // (digitaler Foto-Beleg — eine Frontend-Journey stellt den Modus um)
  await page.getByRole('button', { name: /^(Fertig|Akzeptiert)$/ }).click()
  await expect(page.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: tisch })).toHaveCount(0)

  // Aufräumen: Modul wieder aus (andere Journeys unbeeinflusst)
  await request.patch('/api/mandanten/module', { headers: authHeader, data: { modulGaengeAktiv: false } })
})

})
