import { test, expect } from '@playwright/test'

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

/**
 * End-to-End-Journey durch den echten Browser gegen eine frische E2E-DB und ein
 * Backend mit FO_STUB=true. Beide Tests teilen sich die DB (Setup ist einmalig),
 * daher serielle Reihenfolge: erst Onboarding (legt die Kasse an), dann der
 * Kassier-Flow (nutzt diese Kasse).
 */
test.describe.serial('Kassa E2E-Journey', () => {

/**
 * Onboarding: React-Formular → POST /api/setup → SEE-Keygen → FinanzOnline
 * (FO_STUB) → RKSV-Startbeleg-Signierung → PostgreSQL → Erfolgs-Screen.
 */
test('Onboarding: Setup-Formular richtet Kasse ein und signiert den Startbeleg', async ({ page }) => {
  // Warmup: erste Proxy->Backend-Verbindung absichern. Der allererste TCP-Connect
  // ueber den Vite-Proxy kann auf Windows vereinzelt ETIMEDOUTen; expect.poll
  // wiederholt, bis das Backend ueber den Proxy sauber antwortet.
  // Timeout > 21s, da ein fehlgeschlagener erster TCP-Connect auf Windows bis
  // ~21s (SYN-Retransmit) blockieren kann, bevor der Proxy ihn aufgibt.
  await expect.poll(
    async () => (await page.request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  await page.goto('/setup')

  await expect(page.getByRole('heading', { name: 'Kasse einrichten' })).toBeVisible()

  await page.fill('#firmenname', 'E2E Onboarding GmbH')
  await page.fill('#uid', 'ATU77777701')
  await page.fill('#kassenId', 'E2E-KASSE-01')
  await page.fill('#tid', 'TID-E2E')
  await page.fill('#benid', 'BID-E2E')
  await page.fill('#pin', 'PIN-E2E')
  await page.fill('#admin-name', 'E2E Admin')
  await page.fill('#admin-email', 'e2e-onboarding@test.at')
  await page.fill('#admin-passwort', 'e2e-passwort-12345')

  await page.getByRole('button', { name: 'Kasse einrichten' }).click()

  // Erfolg: Kasse registriert (FO-Stub) + Startbeleg geprueft. Grosszuegiges
  // Timeout fuer SEE-Keygen + Signierung + DB-Roundtrip.
  await expect(page.getByRole('heading', { name: 'Kasse erfolgreich eingerichtet' }))
    .toBeVisible({ timeout: 30_000 })

  // Startbeleg-Nummer wird angezeigt (Beweis, dass signiert + persistiert wurde)
  await expect(page.getByText('Startbeleg-Nr.')).toBeVisible()

  // Weiterleitung in die App steht bereit
  await expect(page.getByRole('button', { name: /Zur Kasse/ })).toBeVisible()
})

/**
 * Kassier-Flow: Artikel anlegen (API) → eingeloggt in die Kasse → Artikel in den
 * Warenkorb → Barzahlung → signierter Beleg. Treibt Warenkorb-Logik, RKSV-
 * Signierung des Barzahlungsbelegs und Beleg-Anzeige durch den Browser.
 */
test('Kassier-Flow: Artikel in den Warenkorb, Barzahlung erzeugt signierten Beleg', async ({ page, request }) => {
  // Login + Seed via API (die Kasse stammt aus dem Onboarding-Test oben)
  const login = await (await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })).json()
  const token     = login.token as string
  const kasseId   = login.kassen[0].id as string
  const mandantId = login.mandant.id as string
  const authHeader = { Authorization: `Bearer ${token}` }

  const kat = await (await request.post('/api/kategorien', {
    headers: authHeader,
    data: { name: 'Heißgetränke', farbe: 'rot', reihenfolge: 0 },
  })).json()
  await request.post('/api/artikel', {
    headers: authHeader,
    data: { bezeichnung: 'Kaffee', preisBruttoCent: 250, mwstSatz: 'ermaessigt1', kategorieId: kat.id },
  })

  // Auth + Kassen-Identitaet in den Browser injizieren (statt Login-UI)
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId,
    kasseId,
  })

  await page.goto('/kasse')

  // Artikel-Kachel anklicken → Warenkorb
  await page.getByRole('button', { name: 'Kaffee' }).first().click()

  // Bar-Betrag exakt auf die Summe setzen (Voll-Barzahlung, kein ZVT noetig)
  await page.getByRole('button', { name: 'Exakt' }).click()

  // Beleg erstellen → RKSV-Signierung
  await page.getByRole('button', { name: 'Bon erstellen' }).click()

  // Erfolg: signierter Barzahlungsbeleg (Startbeleg war #1 -> dieser #2+)
  await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
})

})
