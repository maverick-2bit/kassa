import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Einstellungen → Geräte: was die QR-Codes der Kassa tragen — Port der Docker-Betriebs, der Betrieb
 * für die Kellner-App und ein Geräte-Token, den das KDS wirklich annimmt. Gegen das gebaute Bundle
 * (vite preview) mit echtem Backend.
 *
 * Bisher prüfte das keine Spec: Die Seite hielt über Wochen QR-Codes mit Entwicklungs-Ports
 * (Kellner :5178, KDS :5175 …), wenn sie über „localhost" geöffnet wurde — das Handy kam nie an.
 * Das Host-Verhalten selbst sichert lib/geraeteAdressen.test.ts; diese Spec den Inhalt der Adressen.
 *
 * Dateiname mit zzz-Präfix: Spec-Dateien laufen bei workers:1 alphabetisch; für Solo-Läufe legt
 * adminLogin() die Instanz notfalls selbst per API an (FO_STUB).
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Geräte GmbH',
        uid:        'ATU87654321',
        kassenId:   'E2E-GERAETE-001',
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

test('Geräte-Seite: Docker-Ports, Betrieb für die Kellner-App, KDS-Token, den das KDS annimmt', async ({ page, request }) => {
  const login     = await adminLogin(request)
  const mandantId = login.mandant.id
  const kasseId   = login.kassen[0]!.id

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:    login.token,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId,
    kasseId,
  })

  await page.goto('/einstellungen?bereich=geraete')
  await expect(page.getByRole('heading', { name: 'Geräte verbinden' })).toBeVisible({ timeout: 15_000 })

  // Der KDS-Token wird nachgeladen — erst wenn der Link ihn trägt, ist die Seite fertig
  const adressen = page.locator('button[title="Klicken zum Kopieren"]')
  await expect(adressen.filter({ hasText: ':8080/?token=' })).toHaveCount(1, { timeout: 15_000 })
  const texte = await adressen.allTextContents()

  // Kein Entwicklungs-Port in einem gebauten Bundle (Kellner :5178, KDS :5175 …)
  for (const t of texte) expect(t, `Dev-Port in ${t}`).not.toMatch(/:51\d\d\//)

  // Kellner-App: Docker-Port 8083, der Betrieb steht im Link
  const kellner = texte.find(t => t.includes(':8083/'))
  expect(kellner, 'Kellner-App-Adresse fehlt').toBeDefined()
  expect(kellner).toMatch(new RegExp(`^http://[^/:]+:8083/\\?mandantId=${mandantId}$`))

  // KDS: Docker-Port 8080, Geräte-Token im Link
  const kds = texte.find(t => t.includes(':8080/'))
  expect(kds, 'KDS-Adresse fehlt').toBeDefined()
  const token = new URL(kds!).searchParams.get('token')
  expect(token, 'KDS-Link ohne token').toBeTruthy()

  // Der Token öffnet das KDS …
  const bons = await request.get('/api/kds/bons?station=kueche', { headers: { Authorization: `Bearer ${token}` } })
  expect(bons.status()).toBe(200)
  // … und sonst nichts: ein abfotografierter QR gibt nur Küchen-Bons frei, nie die Kassa
  const me = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  expect(me.status()).toBe(403)
})
