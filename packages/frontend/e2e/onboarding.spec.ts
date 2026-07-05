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

/**
 * Multi-Kassen-Journey durch die Einstellungen: weitere Kasse anlegen (eigene
 * SEE + Startbeleg), auf sie wechseln (Reload, aktive Kasse wandert), zurück-
 * wechseln und die zweite Kasse RKSV-konform stilllegen (Schlussbeleg,
 * Badge „außer Betrieb", kein Wechseln mehr — DEP-Export bleibt).
 */
test('Multi-Kassen: anlegen, wechseln, außer Betrieb nehmen', async ({ page, request }) => {
  const login = await (await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })).json()
  const token     = login.token as string
  const mandantId = login.mandant.id as string
  const kasseId   = login.kassen[0].id as string

  // WICHTIG: nur beim ERSTEN Laden injizieren. addInitScript läuft bei jedem
  // Reload erneut — der Kassen-Wechsel in dieser Journey ändert kasseId im
  // LocalStorage und lädt neu; ein unbedingtes Setzen würde den Wechsel
  // rückgängig machen.
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    if (localStorage.getItem('kassa:token')) return
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

  await page.goto('/einstellungen?bereich=kassen')

  // Bestehende Kasse ist die aktive
  const zeile01 = page.getByTestId('kasse-zeile-E2E-KASSE-01')
  await expect(zeile01).toContainText('● aktiv')

  // ---- Anlegen: eigene SEE + Startbeleg (provisorisch, ohne FinanzOnline) ----
  await page.getByRole('button', { name: '+ Weitere Kasse anlegen' }).click()
  await page.getByPlaceholder('KASSE-002').fill('E2E-KASSE-02')
  await page.getByPlaceholder('Bar Terrasse').fill('E2E Zweitkasse')
  await page.getByRole('button', { name: 'Kasse anlegen' }).click()

  // SEE-Keygen + Startbeleg-Signierung dauern → großzügiges Timeout
  await expect(page.getByText(/angelegt \(Startbeleg #\d+\)/)).toBeVisible({ timeout: 30_000 })

  const zeile02 = page.getByTestId('kasse-zeile-E2E-KASSE-02')
  await expect(zeile02).toContainText('provisorisch')

  // ---- Wechseln auf die neue Kasse (löst einen Reload aus) ----
  await zeile02.getByRole('button', { name: 'Wechseln' }).click()
  await expect(page.getByTestId('kasse-zeile-E2E-KASSE-02')).toContainText('● aktiv', { timeout: 15_000 })

  // ---- Zurück auf Kasse 1 (nur nicht-aktive Kassen sind stilllegbar) ----
  await page.getByTestId('kasse-zeile-E2E-KASSE-01').getByRole('button', { name: 'Wechseln' }).click()
  await expect(page.getByTestId('kasse-zeile-E2E-KASSE-01')).toContainText('● aktiv', { timeout: 15_000 })

  // ---- Stilllegen: Inline-Bestätigung → Schlussbeleg → Badge ----
  await page.getByTestId('kasse-zeile-E2E-KASSE-02')
    .getByRole('button', { name: 'Außer Betrieb nehmen' }).click()
  await expect(page.getByText(/endgültig außer Betrieb nehmen\?/)).toBeVisible()

  await page.getByRole('button', { name: 'Endgültig außer Betrieb nehmen' }).click()
  await expect(page.getByText(/Schlussbeleg #\d+ signiert/)).toBeVisible({ timeout: 20_000 })

  // Zeile zeigt den Stilllegungs-Badge, Wechseln ist weg — DEP-Export bleibt
  const zeile02Danach = page.getByTestId('kasse-zeile-E2E-KASSE-02')
  await expect(zeile02Danach).toContainText('außer Betrieb')
  await expect(zeile02Danach.getByRole('button', { name: 'Wechseln' })).toHaveCount(0)
  await expect(zeile02Danach.getByRole('button', { name: 'DEP7' })).toBeVisible()
})

/**
 * Warengruppen-Verteilung wirkt im Kassen-Raster: In der Verteilungs-Matrix
 * (Einstellungen → Kassen) eine Warengruppe für die aktive Kasse anhaken →
 * das Kassen-Raster zeigt nur noch deren Tab; die anderen Gruppen-Tabs
 * verschwinden. Danach Reset (leer = alle sichtbar) via API.
 */
test('Warengruppen-Verteilung: Auswahl in der Matrix filtert die Tabs im Kassen-Raster', async ({ page, request }) => {
  const login = await (await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })).json()
  const token      = login.token as string
  const mandantId  = login.mandant.id as string
  const kasseId    = login.kassen[0].id as string
  const authHeader = { Authorization: `Bearer ${token}` }

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

  // Ausgangslage: ohne Auswahl zeigt das Raster ALLE Gruppen-Tabs
  // (Kategorien „Heißgetränke"/„Kaltgetränke" stammen aus den Tests oben).
  // Erst auf eine Artikelkachel warten → Raster (inkl. Tabs) sicher geladen.
  await page.goto('/kasse')
  await expect(page.getByRole('button', { name: 'Kaffee' }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Heißgetränke' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kaltgetränke' })).toBeVisible()

  // In der Verteilungs-Matrix „Heißgetränke" für die aktive (erste) Kasse anhaken
  await page.goto('/einstellungen?bereich=kassen')
  const matrix = page.locator('section', {
    has: page.getByRole('heading', { name: 'Warengruppen-Verteilung' }),
  })
  await expect(matrix.getByText('alle sichtbar').first()).toBeVisible()
  // click() statt check(): die Checkbox ist React-kontrolliert und flippt erst,
  // wenn die pos-config-Query geladen ist — check() würde den sofortigen
  // Zustandswechsel erzwingen und im Ladefenster scheitern. Das belastbare
  // Erfolgssignal ist der Spaltenkopf („1 gewählt") nach dem Server-Refetch.
  await matrix.locator('tr', { hasText: 'Heißgetränke' })
    .locator('input[type="checkbox"]').first().click()

  // Spaltenkopf bestätigt die gespeicherte Auswahl (Server-Refetch abgeschlossen)
  await expect(matrix.getByText('1 gewählt')).toBeVisible({ timeout: 10_000 })

  // Kassen-Raster zeigt nur noch die gewählte Gruppe
  await page.goto('/kasse')
  await expect(page.getByRole('button', { name: 'Kaffee' }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Heißgetränke' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kaltgetränke' })).toHaveCount(0)

  // Reset: leere Auswahl = wieder alle Gruppen sichtbar (Folgetests unbeeinflusst)
  const reset = await request.put(`/api/kassen/${kasseId}/pos-config`, {
    headers: authHeader,
    data: { sichtbareKategorieIds: [] },
  })
  expect(reset.status()).toBe(204)
})

/**
 * Tisch-Split-Journey: Tisch eröffnen → 2× Kaffee auf den Tab (nur speichern,
 * ohne Bonieren — kein KDS/Drucker nötig) → Rechnung auf 2 Zahler teilen
 * (je 1× Kaffee, bar) → 2 signierte Bons entstehen, der Tab wird geschlossen.
 * Treibt die Split-Geldlogik (lib/tischtab: splitValidierung, Subtotals) durch
 * den echten Browser inkl. Backend-Split (2 Belege, RKSV-Signierung).
 */
test('Tisch-Split: Rechnung auf 2 Zahler teilen schließt den Tab mit 2 Bons', async ({ page, request }) => {
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

  // ---- Tisch eröffnen ----
  await page.goto('/tische')
  await page.getByRole('button', { name: '+ Neuer Tisch' }).click()
  await page.getByPlaceholder('z. B. 1, Terrasse 3, Bar …').fill('E2E-SPLIT')
  await page.getByRole('button', { name: 'Tisch öffnen' }).click()

  // Tab-Seite ist geladen
  await expect(page.getByText('Laufende Bestellung')).toBeVisible({ timeout: 10_000 })

  // ---- 2× Kaffee in den Korb (Doppelklick auf die Kachel erhöht die Menge) ----
  await page.getByRole('button', { name: 'Kaffee' }).first().click()
  await page.getByRole('button', { name: 'Kaffee' }).first().click()

  // Ohne Bonieren speichern (kein KDS/Bonierdrucker konfiguriert)
  await page.getByRole('button', { name: 'Nur speichern' }).click()
  await expect(page.getByText('2× Kaffee')).toBeVisible({ timeout: 10_000 })

  // ---- Rechnung teilen: Zahler 1 startet mit allem → 1× zu Zahler 2 schieben ----
  await page.getByRole('button', { name: 'Rechnung teilen' }).click()
  await expect(page.getByText(/Rechnung teilen — Tisch E2E-SPLIT/)).toBeVisible()

  const splitZeile = page.locator('tr', { hasText: 'Kaffee' })
  // Mengen-Buttons je Zahler-Spalte: [− +] Zahler 1, [− +] Zahler 2
  await splitZeile.getByRole('button').filter({ hasText: '−' }).first().click()  // Zahler 1: 2 → 1
  await splitZeile.getByRole('button').filter({ hasText: '+' }).nth(1).click()   // Zahler 2: 0 → 1

  // Beide Zahler bar mit exakt ihrem Subtotal (je € 2,50) — Quick-Buttons
  const barQuick = page.getByRole('button', { name: 'Bar = € 2,50' })
  await barQuick.first().click()
  await barQuick.nth(1).click()

  // Abschicken: 2 Bons entstehen, der Tab schließt, zurück zur Tischübersicht
  await page.getByRole('button', { name: '2 Bons erstellen' }).click()
  await expect(page).toHaveURL(/\/tische$/, { timeout: 20_000 })
  await expect(page.getByText('E2E-SPLIT')).toHaveCount(0)
})

})
