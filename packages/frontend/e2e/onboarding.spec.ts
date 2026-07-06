import { test, expect, type APIRequestContext } from '@playwright/test'

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

/**
 * Login-Antwort für die ganze Datei einmal cachen und wiederverwenden.
 *
 * `/api/auth/login` ist auf 10 Logins/Minute pro IP rate-limitiert
 * (Brute-Force-Schutz). Würde jeder Test einzeln einloggen, risse die Suite
 * bei genügend Journeys dieses Limit (429 → kein mandant). Der Login ist erst
 * NACH dem Onboarding-Test möglich (der die Kasse anlegt), daher lazy statt
 * beforeAll. Das JWT gilt 1 h — für einen Suite-Lauf mehr als genug.
 */
let sharedLogin: { token: string; user: unknown; mandant: { id: string; firmenname: string }; kassen: { id: string }[] } | null = null
async function ensureAuth(request: APIRequestContext) {
  if (!sharedLogin) {
    const res = await request.post('/api/auth/login', {
      data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    if (!res.ok()) throw new Error(`Login fehlgeschlagen (${res.status()}): ${await res.text()}`)
    sharedLogin = await res.json()
  }
  return sharedLogin!
}

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
  const login = await ensureAuth(request)
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
  const login = await ensureAuth(request)
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
  const login = await ensureAuth(request)
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
  const login = await ensureAuth(request)
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
  const login = await ensureAuth(request)
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
  const login = await ensureAuth(request)
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

/**
 * Gutschein-Journey: Gutschein (2,50 €) per API anlegen, in der Kasse einen
 * Kaffee (2,50 €) bonieren, den Gutschein einlösen (deckt die Rechnung voll) und
 * einen signierten Beleg erstellen. Treibt Gutschein-Suche/-Einlösung + die
 * Zahlungslogik (Gutschein als „Sonstige") durch den echten Browser.
 */
test('Gutschein: einlösen deckt die Rechnung voll, signierter Beleg entsteht', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token     = login.token as string
  const mandantId = login.mandant.id as string
  const kasseId   = login.kassen[0].id as string
  const authHeader = { Authorization: `Bearer ${token}` }

  // Gutschein 2,50 € mit festem Code anlegen (Kaffee-Artikel stammt aus dem Kassier-Test)
  const gs = await request.post('/api/gutscheine', {
    headers: authHeader,
    data: { betragCent: 250, code: 'E2EGS01' },
  })
  expect(gs.status()).toBe(201)

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
  await page.getByRole('button', { name: 'Kaffee' }).first().click()

  // Gutschein einlösen
  await page.getByRole('button', { name: '+ Gutschein einlösen' }).click()
  await page.getByPlaceholder('Code, EAN oder QR scannen …').fill('E2EGS01')
  await page.getByRole('button', { name: 'Prüfen' }).click()
  // Gutschein gefunden (Restwert sichtbar) → einlösen (Vorschlag deckt die 2,50 €)
  await expect(page.getByText('E2EGS01').first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Einlösen', exact: true }).click()

  // Zu zahlen ist 0 € (Gutschein deckt voll) → signierter Beleg
  await page.getByRole('button', { name: 'Bon erstellen' }).click()
  await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })

  // Gutschein ist danach eingelöst (Restwert 0)
  const gsNachher = await (await request.get('/api/gutscheine/code/E2EGS01', { headers: authHeader })).json()
  expect(gsNachher.restCent).toBe(0)
})

/**
 * Wareneingang-Journey: einen Lager-Artikel (Startbestand 10) per API anlegen,
 * auf der Wareneingang-Seite +7 Zugang buchen und prüfen, dass der Bestand
 * danach 17 ist. Treibt die Lagerstand-Bulk-Pflege durch den echten Browser.
 */
test('Wareneingang: Zugang buchen erhöht den Lagerbestand', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token     = login.token as string
  const mandantId = login.mandant.id as string
  const kasseId   = login.kassen[0].id as string
  const authHeader = { Authorization: `Bearer ${token}` }

  // Lager-Artikel mit eindeutigem Namen + Startbestand 10 anlegen
  const art = await (await request.post('/api/artikel', {
    headers: authHeader,
    data: {
      bezeichnung: 'E2E-LAGER-XYZ', preisBruttoCent: 199, mwstSatz: 'normal',
      lagerstandAktiv: true, lagerstandMenge: 10, mindestbestand: 5,
    },
  })).json()
  const artId = art.id as string

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

  await page.goto('/wareneingang')

  // Nach dem eindeutigen Namen filtern → nur diese Zeile bleibt übrig
  await page.getByPlaceholder('Artikel oder Variante suchen …').fill('E2E-LAGER-XYZ')
  await expect(page.getByText('E2E-LAGER-XYZ').first()).toBeVisible({ timeout: 10_000 })

  // +7 Zugang in das Mengenfeld der (einzigen) Zeile eintragen und buchen
  await page.locator('input[type="number"]').first().fill('7')
  await page.getByRole('button', { name: /Zugang buchen/ }).click()
  await expect(page.getByText('✓ Gespeichert')).toBeVisible({ timeout: 10_000 })

  // Bestand ist jetzt 10 + 7 = 17
  const liste = await (await request.get(`/api/artikel?mandantId=${mandantId}&nurAktive=true`, { headers: authHeader })).json()
  const artNachher = (liste as { id: string; lagerstandMenge: number }[]).find(a => a.id === artId)
  expect(artNachher?.lagerstandMenge).toBe(17)
})

/**
 * Offene-Posten-Journey: Kredit-Kunden + offenen Posten (5,00 €) per API anlegen,
 * auf der Offene-Posten-Seite die Zahlung erfassen (voller Betrag) und prüfen,
 * dass der Posten danach beglichen ist (Restbetrag 0).
 */
test('Offene Posten: Zahlung erfassen begleicht den Posten', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token     = login.token as string
  const mandantId = login.mandant.id as string
  const kasseId   = login.kassen[0].id as string
  const authHeader = { Authorization: `Bearer ${token}` }

  // Kredit-Kunde + offener Posten (5,00 €) anlegen
  const kunde = await (await request.post('/api/kunden', {
    headers: authHeader,
    data: { nachname: 'E2E-Kredit-Kunde', kreditAktiv: true },
  })).json()
  const op = await (await request.post('/api/offene-posten', {
    headers: authHeader,
    data: { kundeId: kunde.id, betragCent: 500 },
  })).json()
  const opId = op.id as string

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

  await page.goto('/offene-posten')
  await expect(page.getByText('E2E-Kredit-Kunde').first()).toBeVisible({ timeout: 10_000 })

  // Zahlung erfassen → Modal (Betrag ist auf den Restbetrag vorbelegt) → bestätigen
  await page.getByRole('button', { name: 'Zahlung', exact: true }).first().click()
  await page.getByRole('button', { name: 'Zahlung erfassen' }).click()

  // Posten ist beglichen (Restbetrag 0)
  await expect.poll(async () => {
    const alle = await (await request.get('/api/offene-posten', { headers: authHeader })).json()
    return (alle as { id: string; restCent: number }[]).find(p => p.id === opId)?.restCent
  }, { timeout: 10_000 }).toBe(0)
})

/**
 * RKSV-Kontrollbeleg-Journey: auf der Belegseite einen Kontrollbeleg (Nullbeleg)
 * erstellen — wird signiert, in die Belegkette eingereiht und im Erstell-Dialog
 * angezeigt. Deckt den RKSV-§8-Kontrollbeleg durch die echte UI ab.
 */
test('RKSV-Kontrollbeleg: Nullbeleg erstellen erzeugt einen signierten Beleg', async ({ page, request }) => {
  const login = await ensureAuth(request)
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

  await page.goto('/belege')
  await page.getByRole('button', { name: 'Kontrollbeleg erstellen' }).click()
  await expect(page.getByText(/Nullbeleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
})

/**
 * Storno-Journey: einen frischen Barzahlungsbeleg per API anlegen, auf der
 * Belegseite stornieren (Bestätigungsdialog) und prüfen, dass ein signierter
 * Stornobeleg entsteht. Treibt den RKSV-Stornopfad durch die echte UI.
 */
test('Storno: Barzahlungsbeleg stornieren erzeugt einen Stornobeleg', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token     = login.token as string
  const mandantId = login.mandant.id as string
  const kasseId   = login.kassen[0].id as string
  const authHeader = { Authorization: `Bearer ${token}` }

  // Frischen stornierbaren Barzahlungsbeleg anlegen (Kaffee-Artikel stammt aus dem Kassier-Test)
  const bar = await request.post('/api/belege/barzahlung', {
    headers: authHeader,
    data: {
      kasseId,
      positionen: [{ bezeichnung: 'Kaffee', preisBruttoCent: 250, mwstSatz: 'ermaessigt1', menge: 1 }],
      zahlung: { barCent: 250, karteCent: 0, sonstigeCent: 0 },
    },
  })
  expect(bar.status()).toBe(201)

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

  await page.goto('/belege')
  // Ersten stornierbaren Beleg stornieren → Bestätigungsdialog → bestätigen
  await page.getByRole('button', { name: 'Stornieren' }).first().click()
  await expect(page.getByText(/stornieren\?/)).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Storno bestätigen' }).click()
  await expect(page.getByText(/Stornobeleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
})

/**
 * Kartenzahlung-Journey: einen Kaffee in der Kasse per Karte bezahlen (ohne ZVT
 * → direkter Beleg, kein Terminal-Modal) und prüfen, dass ein Beleg mit vollem
 * Kartenumsatz (250) und 0 bar entsteht. Deckt den Karten-Zahlungspfad ab.
 */
test('Kartenzahlung: per Karte bezahlen erzeugt einen Beleg mit Kartenumsatz', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
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

  await page.goto('/kasse')
  await page.getByRole('button', { name: 'Kaffee' }).first().click()
  // „Karte": leert den Bar-Betrag → der volle Betrag läuft auf Karte
  await page.getByRole('button', { name: 'Karte', exact: true }).click()
  await page.getByRole('button', { name: 'Bon erstellen' }).click()
  await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })

  // Es existiert ein Beleg mit vollem Kartenumsatz (250) und 0 bar
  const belege = await (await request.get(`/api/belege?kasseId=${kasseId}`, { headers: authHeader })).json()
  expect((belege as { summeKarteCent: number; summeBarCent: number }[])
    .some(b => b.summeKarteCent === 250 && b.summeBarCent === 0)).toBe(true)
})

/**
 * RKSV Monats- + Jahresbeleg-Journey: beide Spezialbelege auf der Belegseite
 * erstellen — werden signiert und in die Belegkette eingereiht.
 */
test('RKSV Monats-/Jahresbeleg: erstellen erzeugt signierte Belege', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id

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

  await page.goto('/belege')

  await page.getByRole('button', { name: 'Monatsbeleg erstellen' }).click()
  await expect(page.getByText(/Monatsbeleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')  // Erstell-Dialog schließen

  await page.getByRole('button', { name: 'Jahresbeleg erstellen' }).click()
  await expect(page.getByText(/Jahresbeleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
})

/**
 * Kassenbuch-Journey: eine Bar-Einlage (50,00 €) über das Formular buchen und
 * prüfen, dass sie in der Buchungsliste erscheint. Deckt die nicht-umsatz-
 * bezogene Bargeldpflege ab.
 */
test('Kassenbuch: Einlage buchen erscheint in der Buchungsliste', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id

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

  await page.goto('/kassenbuch')
  await page.getByRole('button', { name: '+ Neue Buchung' }).click()
  // Einlage ist Standard-Art; Betrag setzen und buchen
  await page.getByPlaceholder('0,00').fill('50,00')
  await page.getByRole('button', { name: 'Einlage buchen' }).click()

  // Buchung erscheint (50,00 € Einlage) — Modal ist geschlossen
  await expect(page.getByText(/50,00/).first()).toBeVisible({ timeout: 10_000 })
})

/**
 * Gast-Bestellsystem-Journey: über die öffentliche Gast-API (kein Login, wie beim
 * QR-Scan am Tisch) eine Bestellung aufgeben und prüfen, dass daraus ein Tisch-Tab
 * (Kellner „Gast") auf der Tische-Seite entsteht. Deckt die Gast→Kasse-Integration ab.
 */
test('Gast-Bestellung: öffentliche Bestellung erzeugt einen Tisch-Tab', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Kaffee-Artikel-ID holen (stammt aus dem Kassier-Test)
  const artikel = await (await request.get(`/api/artikel?mandantId=${mandantId}&nurAktive=true`, { headers: authHeader })).json()
  const kaffee = (artikel as { id: string; bezeichnung: string }[]).find(a => a.bezeichnung === 'Kaffee')!

  // Öffentliche Gast-Bestellung (ohne Auth — wie der QR-Gast)
  const best = await request.post('/api/gast/bestellung', {
    data: { kasseId, tischNummer: 'GAST-TISCH-9', positionen: [{ artikelId: kaffee.id, menge: 2 }] },
  })
  expect(best.ok()).toBe(true)

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

  // Auf der Tische-Seite erscheint der Gast-Tab
  await page.goto('/tische')
  await expect(page.getByText('GAST-TISCH-9')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Gast').first()).toBeVisible()
})

/**
 * Kunde-auf-Beleg-Journey: in der Kasse einen Kunden auswählen (KundePicker) und
 * einen Kaffee bar verkaufen; der Kunden-Snapshot muss auf dem erzeugten Bon
 * erscheinen. Deckt Kundenzuordnung + Snapshot-auf-Beleg ab.
 */
test('Kunde auf Beleg: gewählter Kunde erscheint auf dem Bon', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  await request.post('/api/kunden', { headers: authHeader, data: { nachname: 'E2E-Beleg-Kunde' } })

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
  await page.getByRole('button', { name: 'Kaffee' }).first().click()

  // Kunde suchen + aus dem Dropdown wählen
  await page.getByPlaceholder('Kunde suchen…').fill('E2E-Beleg-Kunde')
  await page.getByRole('button', { name: /E2E-Beleg-Kunde/ }).click()

  // Bar exakt bezahlen → Bon
  await page.getByRole('button', { name: 'Exakt' }).click()
  await page.getByRole('button', { name: 'Bon erstellen' }).click()

  // Der Bon zeigt den Kunden
  await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('E2E-Beleg-Kunde').first()).toBeVisible()
})

/**
 * Kassensturz-Journey: auf der Kassensturz-Seite die Stückelung eingeben
 * (1× 500 €) und prüfen, dass der gezählte Betrag live berechnet wird. Deckt
 * den Bargeld-Zähl-Rechner ab.
 */
test('Kassensturz: Stückelung eingeben berechnet den gezählten Betrag', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id

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

  await page.goto('/kassensturz')
  // Erste Stückelungs-Zeile ist der 500-€-Schein → 1 Stück eingeben
  await page.locator('input[type="number"]').first().fill('1')
  // Der berechnete Betrag (500,00) erscheint (Zeilensumme + Ergebnis)
  await expect(page.getByText(/500,00/).first()).toBeVisible({ timeout: 10_000 })
})

/**
 * Modifikator-Lagerstand-via-Bonieren-Journey: eine lagergeführte Option (Bestand
 * 5) auf einem Tisch-Tab bonieren/speichern und prüfen, dass der Varianten-Bestand
 * auf 4 sinkt. Deckt die Lagerführung auf Modifikator-Ebene über den KORREKTEN
 * Pfad ab (Barzahlung zieht Modifikator-Bestand bewusst nicht ab — nur der
 * Tisch-Tab/Bonier-Pfad).
 */
test('Modifikator-Lagerstand: bonierte Option zieht den Varianten-Bestand ab', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  const uid = `${Date.now()}`
  const artName = `BonArt-${uid}`
  const optName = `BonOpt-${uid}`

  const art = await (await request.post('/api/artikel', {
    headers: authHeader,
    data: { bezeichnung: artName, preisBruttoCent: 300, mwstSatz: 'normal' },
  })).json()
  const gruppe = await (await request.post('/api/modifikator-gruppen', {
    headers: authHeader,
    data: { name: `BonVar-${uid}`, typ: 'pflicht', maxAuswahl: 1, reihenfolge: 0 },
  })).json()
  await request.post(`/api/modifikator-gruppen/${gruppe.id}/modifikatoren`, {
    headers: authHeader,
    data: { name: optName, aufschlagCent: 0, reihenfolge: 0, lagerstandMenge: 5 },
  })
  await request.put(`/api/artikel/${art.id}/modifikator-gruppen`, {
    headers: authHeader,
    data: { gruppenIds: [gruppe.id] },
  })

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

  // Tisch öffnen
  await page.goto('/tische')
  await page.getByRole('button', { name: '+ Neuer Tisch' }).click()
  await page.getByPlaceholder('z. B. 1, Terrasse 3, Bar …').fill(`MOD-${uid}`)
  await page.getByRole('button', { name: 'Tisch öffnen' }).click()
  await expect(page.getByText('Laufende Bestellung')).toBeVisible({ timeout: 10_000 })

  // Artikel mit Pflicht-Option auf den Tab: Option wählen → hinzufügen
  await page.getByRole('button', { name: new RegExp(artName) }).first().click()
  await page.getByRole('button', { name: new RegExp(optName) }).click()
  await page.getByRole('button', { name: /Hinzufügen/ }).click()

  // Positionen speichern → Tisch-Tab-Service zieht den Modifikator-Bestand ab
  await page.getByRole('button', { name: 'Nur speichern' }).click()

  // Varianten-Bestand ist von 5 auf 4 gesunken
  await expect.poll(async () => {
    try {
      const gruppen = await (await request.get('/api/modifikator-gruppen', { headers: authHeader })).json()
      const g = (gruppen as { id: string; modifikatoren: { name: string; lagerstandMenge: number | null }[] }[]).find(x => x.id === gruppe.id)
      return g?.modifikatoren.find(m => m.name === optName)?.lagerstandMenge
    } catch { return undefined }
  }, { timeout: 15_000 }).toBe(4)
})

/**
 * Reservierungs-Modul-Journey: das Modul „reservierungen" aktivieren und prüfen,
 * dass die (zuvor durch den hasModul-Bug dauerhaft gesperrte) Reservierungen-Seite
 * jetzt erreichbar ist. Verifiziert den Modul-Gating-Fix end-to-end.
 */
test('Reservierungs-Modul: nach Aktivierung ist die Reservierungen-Seite erreichbar', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Modul „reservierungen" aktivieren (PATCH braucht alle Flags)
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  const patch = await request.patch('/api/mandanten/module', {
    headers: authHeader,
    data: { ...module, modulReservierungenAktiv: true },
  })
  expect(patch.ok()).toBe(true)

  // Auth mit aktiviertem Modul injizieren (hasModul liest aus dem LocalStorage)
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulReservierungenAktiv: true },
      kassen: login.kassen,
    }),
    mandantId,
    kasseId,
  })

  // Vor dem Fix wäre die Route gesperrt (Redirect); jetzt lädt die Seite
  await page.goto('/reservierungen')
  await expect(page.getByRole('heading', { name: 'Reservierungen' })).toBeVisible({ timeout: 10_000 })
})

/**
 * Angebot-Journey: Modul „angebote" aktivieren, ein Angebot per API seeden und
 * die komplexe Verwaltungs-UI durch den echten Browser prüfen — Liste, Detail,
 * Status-Wechsel (offen→angenommen), Lieferschein-Erzeugung und Sammelrechnung
 * (schließt die Lieferscheine ab). Deckt den letzten großen ungetesteten
 * Feature-Pfad ab. Druck-Popups (window.open) laufen im Hintergrund ins Leere
 * — die Query-Invalidierung passiert davor, daher irrelevant fürs Ergebnis.
 */
test('Angebot: Liste, Status-Wechsel, Lieferschein und Sammelrechnung durch die UI', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Modul „angebote" aktivieren (default aus; PATCH braucht alle Flags)
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  const patch = await request.patch('/api/mandanten/module', {
    headers: authHeader,
    data: { ...module, modulAngeboteAktiv: true },
  })
  expect(patch.ok()).toBe(true)

  // Angebot seeden: 2 × 50,00 = 100,00 € (Bezeichnung eindeutig pro Lauf)
  const bezeichnung = `Catering-Paket ${Date.now()}`
  const createRes = await request.post('/api/angebote', {
    headers: authHeader,
    data: {
      kasseId,
      positionen: [{ bezeichnung, menge: 2, einzelpreisBreutto: 5000, mwstSatz: 'normal' }],
      notiz: 'E2E-Angebot',
    },
  })
  expect(createRes.ok()).toBe(true)
  const angebot = await createRes.json()
  const nr = `A-${String(angebot.nummer).padStart(4, '0')}`

  // Auth mit aktiviertem Modul injizieren (hasModul liest aus dem LocalStorage)
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulAngeboteAktiv: true },
      kassen: login.kassen,
    }),
    mandantId,
    kasseId,
  })

  // Liste: Angebot erscheint (verifiziert zugleich das Modul-Gating für angebote)
  await page.goto('/angebote')
  await expect(page.getByRole('heading', { name: 'Angebote' })).toBeVisible({ timeout: 10_000 })
  const zeile = page.locator('tr', { hasText: nr })
  await expect(zeile).toBeVisible()
  await expect(zeile).toContainText('100,00')

  // Detail öffnen
  await zeile.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(bezeichnung)).toBeVisible()
  await expect(dialog.getByText('Angebotssumme')).toBeVisible()

  // Status offen → angenommen (Status ist offen → nur der Auswahl-Button trägt „Angenommen")
  await dialog.getByRole('button', { name: 'Angenommen', exact: true }).click()
  await dialog.getByRole('button', { name: /Status auf/ }).click()
  // Bestätigungsbutton verschwindet, sobald neuerStatus == angebot.status → Status übernommen
  await expect(dialog.getByRole('button', { name: /Status auf/ })).toHaveCount(0)

  // Lieferschein erzeugen → Zeile L-XXXX erscheint in der Lieferschein-Tabelle
  await dialog.getByRole('button', { name: '+ Neuer Lieferschein' }).click()
  await expect(dialog.getByText(/L-\d{4}/)).toBeVisible()

  // Sammelrechnung aus dem offenen Lieferschein → LS wird abgeschlossen, Button verschwindet
  await dialog.getByRole('button', { name: /Sammelrechnung aus/ }).click()
  await expect(dialog.getByText('Abgeschlossen')).toBeVisible()
  await expect(dialog.getByRole('button', { name: /Sammelrechnung aus/ })).toHaveCount(0)

  // Modal schließen (Escape) → Liste spiegelt den neuen Status
  await page.keyboard.press('Escape')
  await expect(page.locator('tr', { hasText: nr }).getByText('Angenommen')).toBeVisible()
})

/**
 * Reservierungs-Journey: eine Reservierung durch das echte Kalender-Modal anlegen
 * (nicht per API-Seed), im Wochengitter wiederfinden und den Status über das
 * Detail-Modal weiterschalten. Interne Reservierungen starten als „Bestätigt"
 * (nur Online-Buchungen sind „Anfrage"/wartend), daher bestätigt→erschienen.
 * Das Datum bleibt auf dem Formular-Default (heuteISO) — dieselbe Funktion baut
 * die Wochenspalten, daher liegt die Reservierung garantiert in der ersten
 * Spalte, unabhängig von der Zeitzone.
 */
test('Reservierung: Anlage über das Kalender-Modal, im Wochengitter + Status-Wechsel', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Modul „reservierungen" aktivieren (default aus; PATCH braucht alle Flags)
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  const patch = await request.patch('/api/mandanten/module', {
    headers: authHeader,
    data: { ...module, modulReservierungenAktiv: true },
  })
  expect(patch.ok()).toBe(true)

  // Auth mit aktiviertem Modul injizieren
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulReservierungenAktiv: true },
      kassen: login.kassen,
    }),
    mandantId,
    kasseId,
  })

  await page.goto('/reservierungen')
  await expect(page.getByRole('heading', { name: 'Reservierungen' })).toBeVisible({ timeout: 10_000 })

  // Anlage über das echte Kalender-Modal (Datum-Default = heute)
  const name = `Reservierung E2E ${Date.now()}`
  await page.getByRole('button', { name: '+ Neu', exact: true }).click()
  const form = page.getByRole('dialog')
  await expect(form.getByText('Neue Reservierung')).toBeVisible()
  await form.locator('input[type="time"]').fill('19:45')
  await form.locator('input[type="number"]').fill('4')
  await form.getByPlaceholder('Mustermann').fill(name)
  await form.getByRole('button', { name: 'Anlegen' }).click()

  // Reservierung erscheint als Kachel im Wochengitter (Zeit + Name)
  const kachel = page.getByRole('button', { name: new RegExp(`19:45 .*${name}`) })
  await expect(kachel).toBeVisible({ timeout: 10_000 })

  // Detail öffnen: intern angelegte Reservierung startet als „Bestätigt" → auf „Erschienen" schalten
  await kachel.click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByText('Bestätigt', { exact: true })).toBeVisible()
  await detail.getByRole('button', { name: /→ Erschienen/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)  // Modal schließt bei Erfolg

  // Erneut öffnen → Status ist jetzt persistent „Erschienen"
  await kachel.click()
  await expect(page.getByRole('dialog').getByText('Erschienen', { exact: true })).toBeVisible()
})

/**
 * Zeiterfassungs-Journey: Modul aktivieren, einen Mitarbeiter mit PIN anlegen und
 * über das echte PIN-Numpad ein- und wieder ausstempeln (die operative Signature-
 * Funktion), danach in der Übersicht wiederfinden. PIN & Name sind pro Lauf
 * eindeutig (aus Date.now()), damit Retries auf der geteilten DB nicht am PIN
 * eines Vorlaufs hängenbleiben. Der Stempel-Endpoint ist modul-gated
 * (zeiterfassung.service.ts:58) → Modul muss vorher aktiv sein.
 */
test('Zeiterfassung: über das PIN-Numpad ein- und ausstempeln + Übersicht', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Modul „zeiterfassung" aktivieren (default aus; PATCH braucht alle Flags)
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  const patch = await request.patch('/api/mandanten/module', {
    headers: authHeader,
    data: { ...module, modulZeiterfassungAktiv: true },
  })
  expect(patch.ok()).toBe(true)

  // Mitarbeiter mit PIN anlegen (PIN/Name pro Lauf eindeutig)
  const ts   = Date.now()
  const pin  = String(ts).slice(-4)
  const name = `Stempel Tester ${ts}`
  const userRes = await request.post('/api/users', {
    headers: authHeader,
    data: {
      name,
      email:          `stempel-${ts}@e2e.at`,
      passwort:       'e2e-passwort-123',
      rolle:          'kellner',
      berechtigungen: [],
      kassenIds:      [kasseId],
      pin,
    },
  })
  expect(userRes.ok()).toBe(true)

  // Auth mit aktiviertem Modul injizieren
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulZeiterfassungAktiv: true },
      kassen: login.kassen,
    }),
    mandantId,
    kasseId,
  })

  await page.goto('/zeiterfassung')
  await expect(page.getByRole('heading', { name: 'Zeiterfassung' })).toBeVisible({ timeout: 10_000 })

  // PIN über das Numpad eintippen und bestätigen
  const stempeln = async () => {
    for (const ziffer of pin) await page.getByRole('button', { name: ziffer, exact: true }).click()
    await page.getByRole('button', { name: '✓', exact: true }).click()
  }

  // Einstempeln → Erfolgsmeldung
  await stempeln()
  await expect(page.getByText(/— Eingestempelt/)).toBeVisible()

  // Ausstempeln → Erfolgsmeldung
  await stempeln()
  await expect(page.getByText(/— Ausgestempelt/)).toBeVisible()

  // Übersicht: der Mitarbeiter mit erfasster Zeit erscheint
  await page.getByRole('button', { name: 'Übersicht' }).click()
  await expect(page.getByText(name)).toBeVisible()
})

/**
 * Modul-Verwaltung: die Module-Seite (/module) zeigt jetzt alle fünf Module —
 * inkl. Tischreservierungen und Personalzeiterfassung, die zuvor gar nicht
 * umschaltbar waren (MODULE_LISTE hatte nur 3, modulKey mappte den Rest falsch
 * auf mergeport). Die Journey belegt: (a) alle fünf Karten sind da, (b) das
 * Umschalten von Reservierungen bzw. Zeiterfassung wirkt jeweils NUR auf die
 * eigene Karte und lässt die mergeport-Karte unberührt — das fängt den
 * modulKey-Fehlmapping-Bug ab (mit Bug hätte ein Reservierungs-Klick mergeport
 * umgeschaltet) und beweist zugleich die Unabhängigkeit beider Module. Einseitig
 * (keine Navigationen) → race-frei gegenüber refetchOnWindowFocus. Die Route-
 * Erreichbarkeit je Modul deckt bereits die Reservierungs-Modul-/Zeiterfassungs-
 * Journey ab; hier geht es um das Umschalt-UI.
 */
test('Module: Tischreservierung und Zeiterfassung sind unabhängig zuschaltbar', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  // Beide Module deterministisch aktivieren (unabhängig von vorherigen Journeys)
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  await request.patch('/api/mandanten/module', {
    headers: authHeader,
    data: { ...module, modulReservierungenAktiv: true, modulZeiterfassungAktiv: true },
  })

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:     login.token,
    authJson:  JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id,
    kasseId:   login.kassen[0].id,
  })

  await page.goto('/module')
  await expect(page.getByRole('heading', { name: 'Module' })).toBeVisible({ timeout: 10_000 })

  // Alle fünf Modul-Karten sind vorhanden (Reservierungen + Zeiterfassung fehlten vorher)
  for (const label of [
    'Gastro & Tischverwaltung', 'Tischreservierungen', 'Angebote & Lieferscheine',
    'Lieferservice-Integration', 'Personalzeiterfassung',
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible()
  }

  const sw = (modul: string) => page.getByTestId(`modul-karte-${modul}`).getByRole('switch')

  // Beide zeigen „an" (Zustand aus GET /module = DB); mergeport-Ausgangswert merken
  await expect(sw('reservierungen')).toHaveAttribute('aria-checked', 'true')
  await expect(sw('zeiterfassung')).toHaveAttribute('aria-checked', 'true')
  const mergeportVorher = await sw('mergeport').getAttribute('aria-checked')

  // Reservierungen ausschalten wirkt NUR auf die Reservierungen-Karte (mergeport unberührt)
  await sw('reservierungen').click()
  await expect(sw('reservierungen')).toHaveAttribute('aria-checked', 'false')
  await expect(sw('mergeport')).toHaveAttribute('aria-checked', mergeportVorher!)

  // Zeiterfassung ausschalten wirkt NUR auf die Zeiterfassung-Karte; Reservierungen bleibt aus (Unabhängigkeit)
  await sw('zeiterfassung').click()
  await expect(sw('zeiterfassung')).toHaveAttribute('aria-checked', 'false')
  await expect(sw('reservierungen')).toHaveAttribute('aria-checked', 'false')
  await expect(sw('mergeport')).toHaveAttribute('aria-checked', mergeportVorher!)
})

/**
 * Online-Reservierungs-Journey: die öffentliche Buchungsseite (/buchung?kasseId=…,
 * kein Login) durchspielen und intern als Anfrage wiederfinden. Ergänzt die interne
 * Reservierung (die als „Bestätigt" startet) um den Gast-Weg: Online-Buchungen
 * landen als quelle='online' / status='wartend' („Anfrage"). Voraussetzung
 * (buchung.route → erstelleOnlineReservierung): Kasse `onlineBuchungAktiv` UND
 * Mandant `modulReservierungenAktiv` — beide per API vorbereiten.
 */
test('Online-Reservierung: öffentliche Buchung landet intern als Anfrage', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Modul + Online-Buchung an der Kasse aktivieren
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  await request.patch('/api/mandanten/module', {
    headers: authHeader, data: { ...module, modulReservierungenAktiv: true },
  })
  const bok = await request.patch(`/api/kassen/${kasseId}/online-buchung`, {
    headers: authHeader, data: { aktiv: true },
  })
  expect(bok.ok()).toBe(true)

  // Auth mit aktivem Modul injizieren (für den internen Cross-Check; die öffentliche Seite ignoriert es)
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulReservierungenAktiv: true },
      kassen: login.kassen,
    }),
    mandantId,
    kasseId,
  })

  // Öffentliche Buchungsseite (ohne Login) ausfüllen und absenden
  const name = `Online Gast ${Date.now()}`
  await page.goto(`/buchung?kasseId=${kasseId}`)
  await expect(page.getByText('Online-Tischreservierung')).toBeVisible({ timeout: 10_000 })
  await page.locator('input[type="time"]').fill('18:30')
  await page.locator('select').selectOption('3')
  await page.getByPlaceholder('Vor- und Nachname').fill(name)
  await page.getByRole('button', { name: /Reservierungsanfrage senden/ }).click()

  // Öffentliche Bestätigung
  await expect(page.getByText('Anfrage erhalten!')).toBeVisible()
  await expect(page.getByText(name)).toBeVisible()

  // Intern: erscheint im Wochengitter; Detail zeigt Status „Anfrage" + Online-Buchung
  await page.goto('/reservierungen')
  const kachel = page.getByRole('button', { name: new RegExp(`18:30 .*${name}`) })
  await expect(kachel).toBeVisible({ timeout: 10_000 })
  await kachel.click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByText('Anfrage')).toBeVisible()
  await expect(detail.getByText('Online-Buchung')).toBeVisible()
})

/**
 * Dienstplan-Journey: eine Schicht über das echte Schicht-Modal eintragen und im
 * Wochenkalender wiederfinden. Der Dienstplan hängt am selben Modul wie die
 * Zeiterfassung (m="zeiterfassung"). Ein eigener Mitarbeiter mit eindeutigem
 * Namen wird angelegt, damit die Assertion nicht mit dem angemeldeten Admin
 * („E2E Admin" im Header) kollidiert. Datum bleibt Default (heute) → liegt in
 * der angezeigten Woche. Das Modal ist kein role=dialog (eigenes Overlay) →
 * über Überschrift „Neue Schicht" und die Felder angesprochen.
 */
test('Dienstplan: Schicht über das Modal eintragen erscheint im Wochenkalender', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Zeiterfassungs-Modul aktivieren (gated /dienstplan) + Mitarbeiter mit eindeutigem Namen anlegen
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  await request.patch('/api/mandanten/module', {
    headers: authHeader, data: { ...module, modulZeiterfassungAktiv: true },
  })
  const ts = Date.now()
  const mitarbeiter = `Dienst Planer ${ts}`
  const userRes = await request.post('/api/users', {
    headers: authHeader,
    data: {
      name: mitarbeiter, email: `dienst-${ts}@e2e.at`, passwort: 'e2e-passwort-123',
      rolle: 'kellner', berechtigungen: [], kassenIds: [kasseId],
    },
  })
  expect(userRes.ok()).toBe(true)

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulZeiterfassungAktiv: true },
      kassen: login.kassen,
    }),
    mandantId,
    kasseId,
  })

  await page.goto('/dienstplan')
  await expect(page.getByRole('heading', { name: 'Dienstplan' })).toBeVisible({ timeout: 10_000 })

  // Schicht über das Modal eintragen (Datum-Default heute, Beginn/Ende 09:00–17:00)
  await page.getByRole('button', { name: 'Schicht eintragen' }).click()
  await expect(page.getByText('Neue Schicht')).toBeVisible()
  await page.getByRole('combobox').selectOption({ label: mitarbeiter })
  await page.getByRole('button', { name: /Speichern/ }).click()

  // Schicht-Karte erscheint im Wochenkalender (Mitarbeiter + geplante Zeit)
  await expect(page.getByText(/09:00.*17:00/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(mitarbeiter).first()).toBeVisible()
})

/**
 * Angebot-über-die-Kasse-Journey: der Erzeugungs-Weg, den die AngebotePage NICHT
 * bietet — Angebote entstehen über die Schnellkasse im Angebot-Modus. Modul
 * aktivieren → /kasse → auf „Angebot" umschalten (setzt Modus + leert den Korb,
 * daher ERST umschalten, DANN Artikel) → Artikel-Kachel in den Korb → „Angebot
 * erstellen" → Erfolgs-Modal „Angebot A-XXXX erstellt". Ergänzt die bestehende
 * Angebot-Verwaltungs-Journey (Liste/Status/Lieferschein) um die Anlage.
 */
test('Angebot über die Kasse: im Angebot-Modus aus dem Warenkorb erstellen', async ({ page, request }) => {
  const login = await ensureAuth(request)
  const token = login.token, mandantId = login.mandant.id, kasseId = login.kassen[0].id
  const authHeader = { Authorization: `Bearer ${token}` }

  // Modul aktivieren + Artikel mit eindeutigem Namen seeden
  const module = await (await request.get('/api/mandanten/module', { headers: authHeader })).json()
  await request.patch('/api/mandanten/module', {
    headers: authHeader, data: { ...module, modulAngeboteAktiv: true },
  })
  const ts  = Date.now()
  const art = `Beratungsleistung ${ts}`
  const kat = await (await request.post('/api/kategorien', {
    headers: authHeader, data: { name: `Dienstleistung ${ts}`, farbe: 'blau', reihenfolge: 0 },
  })).json()
  await request.post('/api/artikel', {
    headers: authHeader,
    data: { bezeichnung: art, preisBruttoCent: 5000, mwstSatz: 'normal', kategorieId: kat.id },
  })

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token,
    authJson: JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulAngeboteAktiv: true },
      kassen: login.kassen,
    }),
    mandantId,
    kasseId,
  })

  await page.goto('/kasse')

  // Erst auf Angebot-Modus umschalten (leert den Korb), DANN Artikel hinzufügen
  await page.getByRole('button', { name: 'Angebot', exact: true }).click()
  await expect(page.getByText('Angebotssumme')).toBeVisible()
  await page.getByRole('button', { name: art }).first().click()

  // Angebot aus dem Warenkorb erstellen → Erfolgs-Modal
  await page.getByRole('button', { name: 'Angebot erstellen' }).click()
  await expect(page.getByText(/Angebot A-\d+ erstellt/)).toBeVisible({ timeout: 15_000 })
})

})
