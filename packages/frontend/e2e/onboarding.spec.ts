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

/**
 * Rabatt- + Modifikator-Flow: Artikel mit Pflicht-Modifikator (Aufschlag) in den
 * Warenkorb, dann Gesamt-Rabatt (10 %) anwenden und bar bezahlen.
 *
 * Treibt die UI-Geldlogik (lib/warenkorb: positionsPreisCent, rabattBetragCent,
 * zahlungsAufteilung) durch den echten Browser inkl. RKSV-Signierung. Der
 * Rabattbetrag 0,35 € beweist die gesamte Kette: 10 % auf den MODIFIZIERTEN
 * Preis 350 (= 300 Basis + 50 Aufschlag). Wäre der Aufschlag nicht geflossen,
 * stünden hier 0,30 €.
 */
test('Rabatt + Modifikator: Aufschlag und 10%-Rabatt fließen korrekt in den signierten Beleg', async ({ page, request }) => {
  // Login + Seed via API (Kasse stammt aus dem Onboarding-Test oben)
  const login = await (await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })).json()
  const token      = login.token as string
  const mandantId  = login.mandant.id as string
  const kasseId    = login.kassen[0].id as string
  const authHeader = { Authorization: `Bearer ${token}` }

  // Kategorie + Artikel "Cola" (3,00 €)
  const kat = await (await request.post('/api/kategorien', {
    headers: authHeader,
    data: { name: 'Kaltgetränke', farbe: 'blau', reihenfolge: 1 },
  })).json()
  const artikel = await (await request.post('/api/artikel', {
    headers: authHeader,
    data: { bezeichnung: 'Cola', preisBruttoCent: 300, mwstSatz: 'normal', kategorieId: kat.id },
  })).json()

  // Modifikator-Gruppe "Größe" (Pflicht, max. 1) mit Option "Groß" (+0,50 €)
  const gruppe = await (await request.post('/api/modifikator-gruppen', {
    headers: authHeader,
    data: { name: 'Größe', typ: 'pflicht', maxAuswahl: 1, reihenfolge: 0 },
  })).json()
  await request.post(`/api/modifikator-gruppen/${gruppe.id}/modifikatoren`, {
    headers: authHeader,
    data: { name: 'Groß', aufschlagCent: 50, reihenfolge: 0 },
  })
  await request.put(`/api/artikel/${artikel.id}/modifikator-gruppen`, {
    headers: authHeader,
    data: { gruppenIds: [gruppe.id] },
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

  // Cola-Kachel anklicken -> Modifikator-Dialog (Artikel hat eine Pflicht-Gruppe)
  await page.getByRole('button', { name: /Cola/ }).first().click()

  // Pflicht-Option "Groß" (+0,50) waehlen, dann hinzufuegen
  await page.getByRole('button', { name: /Groß/ }).click()
  await page.getByRole('button', { name: /Hinzufügen/ }).click()

  // Gesamtrabatt hinzufuegen (Modal oeffnet mit Default 10 %) und anwenden
  await page.getByRole('button', { name: '+ Rabatt hinzufügen' }).click()
  await page.getByRole('button', { name: 'Rabatt anwenden' }).click()

  // Beweis der Geldkette: Rabattzeile zeigt "Rabatt (10%)" und -0,35 EUR
  // (10 % auf 350 = 35 Cent; bei fehlendem Aufschlag waeren es 0,30 EUR)
  await expect(page.getByText(/Rabatt \(10%\)/)).toBeVisible()
  await expect(page.getByText(/0,35/)).toBeVisible()

  // Bar exakt (= 3,15 EUR nach Rabatt) und signierten Beleg erstellen
  await page.getByRole('button', { name: 'Exakt' }).click()
  await page.getByRole('button', { name: 'Bon erstellen' }).click()

  await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
})

/**
 * SEE-Ausfall-Bedienung: über die Einstellungen einen Ausfall melden → Warn-
 * banner erscheint app-weit → über die Einstellungen wieder in Betrieb nehmen
 * (signierter Sammelbeleg) → Banner verschwindet, Status „In Betrieb".
 */
test('SEE-Ausfall: melden zeigt Warnbanner, Wiederinbetriebnahme räumt ihn', async ({ page, request }) => {
  const login = await (await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })).json()
  const token     = login.token as string
  const mandantId = login.mandant.id as string
  const kasseId   = login.kassen[0].id as string

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

  // Bestätigungsdialoge (confirm) automatisch annehmen
  page.on('dialog', (d) => d.accept())

  // SEE-Sektion liegt im RKSV-Bereich der Einstellungen (?bereich=rksv)
  await page.goto('/einstellungen?bereich=rksv')

  // SEE-Sektion: Ausgangszustand „In Betrieb"
  await expect(page.getByRole('heading', { name: 'Signatureinrichtung (SEE)' })).toBeVisible()

  // Die SEE-Einstellungs-Sektion (Banner trägt dieselben Button-Labels → scopen)
  const seeSektion = page.locator('section', {
    has: page.getByRole('heading', { name: 'Signatureinrichtung (SEE)' }),
  })

  // Ausfall melden → Warnbanner erscheint app-weit
  await seeSektion.getByRole('button', { name: 'SEE-Ausfall melden' }).click()
  await expect(page.getByTestId('see-banner')).toBeVisible({ timeout: 10_000 })

  // Über die Sektion wieder in Betrieb nehmen → signierter Sammelbeleg
  await seeSektion.getByRole('button', { name: 'Wieder in Betrieb nehmen' }).click()
  await expect(page.getByText(/Sammelbeleg #\d+ signiert/)).toBeVisible({ timeout: 15_000 })

  // Banner ist wieder weg
  await expect(page.getByTestId('see-banner')).toHaveCount(0)
})

})
