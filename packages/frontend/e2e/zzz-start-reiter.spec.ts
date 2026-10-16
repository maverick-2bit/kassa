import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Start-Reiter der Artikelwahl je Kasse: Favoriten oder eine bestimmte Warengruppe beim Öffnen — einstellbar in
 * Einstellungen → Kassen & Drucker (Spalte „Artikelwahl startet mit") — und: hat eine Kasse nur EINE Warengruppe,
 * öffnet sich die von selbst, auch wenn es Favoriten gibt.
 *
 *  - Tabelle: Auswahl Favoriten / Erste Warengruppe / Warengruppe wird gespeichert (POS-Konfiguration der Kasse);
 *    bei einer Kasse mit nur einer Warengruppe steht stattdessen „öffnet … automatisch" (nichts zu wählen)
 *  - Kasse (Direktverkauf): Kasse mit einer Warengruppe startet mit ihr (Favoriten vorhanden, aber nicht aktiv);
 *    Kasse mit zwei Warengruppen startet mit den Favoriten bzw. der eingestellten Warengruppe
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript — es wird kein Passwort in die Maske getippt.
 * Legt zwei Kassen, zwei Warengruppen und Artikel an — alles wird am Ende stillgelegt bzw. deaktiviert.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ serviceWorkers: 'block' })
test.setTimeout(180_000)

interface Login { token: string; user: unknown; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }
// (Die Anmeldung kommt aus /api/auth/login; hier zählen nur diese Felder.)

/** /api/auth/login ist auf 10 Anmeldungen je Minute begrenzt (429): abwarten statt fälschlich in /api/setup zu fallen. */
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

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-START-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
  }
  return (await res.json()) as Login
}

/** Meldet die Seite an und stellt sie auf die Kasse `kasseId` ein (Init-Skript: nur beim ersten Laden je Tab). */
async function anmelden(page: Page, login: Login, kasseId: string) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    if (sessionStorage.getItem('e2e:angemeldet')) return
    sessionStorage.setItem('e2e:angemeldet', '1')
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId,
  })
}

test('Start-Reiter: einstellen in der Kassen-Tabelle, und eine einzige Warengruppe öffnet sich von selbst', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const p     = `St${Date.now() % 1_000_000}`

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const putOk = async (url: string, data: unknown) => {
    const res = await request.put(url, { headers: auth, data })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  }
  const posKonfig = async (kasseId: string) =>
    (await (await request.get(`/api/kassen/${kasseId}/pos-config`, { headers: auth })).json()) as { startFavoriten: boolean; startKategorieId: string | null }

  // ---- Testdaten: zwei Warengruppen mit Artikeln (je ein Favorit), zwei Kassen: eine mit beiden Gruppen, eine nur mit „Getränke" ----
  const getraenke = await post('/api/kategorien', { name: `${p} Getränke`, farbe: 'blau', reihenfolge: 7101 })
  const speisen   = await post('/api/kategorien', { name: `${p} Speisen`,  farbe: 'rot',  reihenfolge: 7102 })
  const artikel = [
    await post('/api/artikel', { bezeichnung: `${p} Cola`,      preisBruttoCent: 320,  mwstSatz: 'normal', kategorieId: getraenke.id, istFavorit: true }),
    await post('/api/artikel', { bezeichnung: `${p} Wasser`,    preisBruttoCent: 290,  mwstSatz: 'normal', kategorieId: getraenke.id }),
    await post('/api/artikel', { bezeichnung: `${p} Schnitzel`, preisBruttoCent: 1450, mwstSatz: 'normal', kategorieId: speisen.id,   istFavorit: true }),
  ]
  const zwei = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-ST2-${p}`, bezeichnung: `${p} Zwei Gruppen`, umgebung: 'test' })
  const eine = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-ST1-${p}`, bezeichnung: `${p} Eine Gruppe`,  umgebung: 'test' })
  await putOk(`/api/kassen/${zwei.kasseId}/pos-config`, { sichtbareKategorieIds: [getraenke.id, speisen.id] })
  await putOk(`/api/kassen/${eine.kasseId}/pos-config`, { sichtbareKategorieIds: [getraenke.id] })

  const reiter = (name: string) => page.getByRole('button', { name: new RegExp(`^(⭐ )?${name}`) })

  try {
    await anmelden(page, login, zwei.kasseId)

    // =================================================================================
    // 1. Kassen-Tabelle: Auswahl „Artikelwahl startet mit"
    // =================================================================================
    await test.step('Tabelle: Favoriten / Erste Warengruppe / bestimmte Warengruppe — wird gespeichert', async () => {
      await page.goto('/einstellungen?bereich=kassen')
      const zeileZwei = page.getByTestId(`kasse-zeile-E2E-ST2-${p}`)
      const wahl = zeileZwei.getByLabel(`Artikelwahl startet mit ${p} Zwei Gruppen`)
      await expect(wahl).toHaveValue('favoriten')                                                // Standard
      await expect(wahl.getByRole('option')).toHaveText(['⭐ Favoriten', 'Erste Warengruppe', `${p} Getränke`, `${p} Speisen`])

      await wahl.selectOption({ label: `${p} Speisen` })
      await expect.poll(() => posKonfig(zwei.kasseId)).toMatchObject({ startFavoriten: false, startKategorieId: speisen.id })

      await wahl.selectOption('erste')
      await expect.poll(() => posKonfig(zwei.kasseId)).toMatchObject({ startFavoriten: false, startKategorieId: null })

      await wahl.selectOption('favoriten')
      await expect.poll(() => posKonfig(zwei.kasseId)).toMatchObject({ startFavoriten: true, startKategorieId: null })
      await wahl.selectOption({ label: `${p} Speisen` })
      await expect.poll(() => posKonfig(zwei.kasseId)).toMatchObject({ startFavoriten: false, startKategorieId: speisen.id })
    })

    await test.step('Tabelle: bei nur einer Warengruppe gibt es nichts zu wählen — sie öffnet automatisch', async () => {
      const zeileEine = page.getByTestId(`kasse-zeile-E2E-ST1-${p}`)
      await expect(zeileEine.getByTestId(`start-reiter-einzige-E2E-ST1-${p}`)).toContainText(`${p} Getränke`)
      await expect(zeileEine.getByTestId(`start-reiter-einzige-E2E-ST1-${p}`)).toContainText('automatisch')
      await expect(zeileEine.getByLabel(`Artikelwahl startet mit ${p} Eine Gruppe`)).toHaveCount(0)
    })

    // =================================================================================
    // 2. Kasse: womit öffnet die Artikelwahl wirklich?
    // =================================================================================
    await test.step('Kasse mit zwei Warengruppen: öffnet mit der eingestellten Warengruppe', async () => {
      await page.goto('/kasse')
      await expect(reiter(`${p} Speisen`)).toHaveAttribute('aria-pressed', 'true')
      await expect(reiter('Favoriten')).toHaveAttribute('aria-pressed', 'false')
      await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'false')
    })

    await test.step('Kasse mit zwei Warengruppen und „Favoriten": öffnet mit den Favoriten', async () => {
      await putOk(`/api/kassen/${zwei.kasseId}/pos-config`, { startFavoriten: true, startKategorieId: null })
      await page.reload()
      await expect(reiter('Favoriten')).toHaveAttribute('aria-pressed', 'true')
      await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'false')
    })

    await test.step('Kasse mit nur EINER Warengruppe: öffnet mit ihr — trotz Favoriten und der Einstellung „Favoriten"', async () => {
      expect(await posKonfig(eine.kasseId)).toMatchObject({ startFavoriten: true })               // Standard: Favoriten
      await page.evaluate((id: string) => localStorage.setItem('kassa:kasseId', id), eine.kasseId)
      await page.goto('/kasse')
      await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'true')
      await expect(reiter('Favoriten')).toHaveAttribute('aria-pressed', 'false')                   // der Reiter ist da, aber nicht aktiv
      // Der Inhalt der Warengruppe steht da (Wasser ist kein Favorit — es erscheint nur, weil die Gruppe offen ist)
      await expect(page.getByTestId('artikel-kachel').filter({ hasText: `${p} Cola` })).toBeVisible()
      await expect(page.getByTestId('artikel-kachel').filter({ hasText: `${p} Wasser` })).toBeVisible()
    })
  } finally {
    // ---- aufräumen ----
    for (const id of [zwei.kasseId, eine.kasseId]) await request.post(`/api/kassen/${id}/ausser-betrieb`, { headers: auth, data: {} })
    for (const a of artikel) await request.delete(`/api/artikel/${a.id}`, { headers: auth })
    for (const g of [getraenke, speisen]) await request.delete(`/api/kategorien/${g.id}`, { headers: auth })
  }
})

test('Start-Reiter in der Kellner-App: bei nur einer Warengruppe öffnet sie sich von selbst — trotz Favoriten', async ({ request, browser }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const p     = `Kl${Date.now() % 1_000_000}`
  const KELLNER_PIN = '8642'
  const KELLNER_URL = 'http://127.0.0.1:5178'

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }

  // Eine Kasse mit genau EINER Warengruppe (Cola = Favorit, Wasser nicht) und eingeschalteten Kellner-Favoriten
  const gruppe = await post('/api/kategorien', { name: `${p} Getränke`, farbe: 'blau', reihenfolge: 7201 })
  const cola   = await post('/api/artikel', { bezeichnung: `${p} Cola`,   preisBruttoCent: 320, mwstSatz: 'normal', kategorieId: gruppe.id, istFavorit: true })
  const wasser = await post('/api/artikel', { bezeichnung: `${p} Wasser`, preisBruttoCent: 290, mwstSatz: 'normal', kategorieId: gruppe.id })
  const kasse  = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-STK-${p}`, bezeichnung: `${p} Kellnerkasse`, umgebung: 'test' })
  const konfig = await request.put(`/api/kassen/${kasse.kasseId}/pos-config`, {
    headers: auth, data: { sichtbareKategorieIds: [gruppe.id], kellnerFavoritenAktiv: true },
  })
  expect(konfig.ok(), await konfig.text()).toBe(true)
  const kellnerUser = await post('/api/users', {
    name: 'Start Kellner', email: `start-kellner-${p}@test.at`, passwort: 'kellner-passwort-123', rolle: 'kellner',
    berechtigungen: ['tische'], kassenIds: [kasse.kasseId], pin: KELLNER_PIN,
  })
  const kontext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
  try {
    await kontext.addInitScript((d: { mandantId: string; kasseId: string }) => {
      localStorage.setItem('kellner:mandantId', d.mandantId)
      localStorage.setItem('kellner:kasseId', d.kasseId)
    }, { mandantId: login.mandant.id, kasseId: kasse.kasseId })
    const kellner = await kontext.newPage()
    await expect.poll(async () => (await kellner.request.get(`${KELLNER_URL}/api/health`)).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
    await kellner.goto(`${KELLNER_URL}/login`)
    await expect(kellner.getByText('PIN eingeben')).toBeVisible({ timeout: 15_000 })
    for (const ziffer of KELLNER_PIN) await kellner.getByRole('button', { name: ziffer, exact: true }).click()
    await expect(kellner.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 15_000 })
    await kellner.getByRole('button', { name: '+ Tisch' }).click()
    await kellner.getByPlaceholder(/Tisch 3 oder Bar/).fill(`S${p}`)
    await kellner.getByRole('button', { name: 'Öffnen' }).click()
    await expect(kellner.getByRole('heading', { name: `Tisch S${p}` })).toBeVisible({ timeout: 10_000 })

    // Ohne einen Klick auf einen Reiter: die Warengruppe ist offen — Wasser ist kein Favorit und stünde sonst nicht da
    const kacheln = kellner.locator('[data-testid="artikel-kachel"]')
    await expect(kacheln.filter({ hasText: `${p} Wasser` })).toBeVisible({ timeout: 10_000 })
    await expect(kacheln.filter({ hasText: `${p} Cola` })).toBeVisible()
    await expect(kellner.getByRole('button', { name: '★ Favoriten' })).toBeVisible()               // der Favoriten-Reiter ist trotzdem da
  } finally {
    await kontext.close()
    const tabs = (await (await request.get(`/api/tisch-tabs?kasseId=${kasse.kasseId}`, { headers: auth })).json()) as { id: string; tischNummer: string }[]
    for (const t of tabs.filter(x => x.tischNummer === `S${p}`)) await request.post(`/api/tisch-tabs/${t.id}/verwerfen`, { headers: auth, data: {} })
    await request.delete(`/api/users/${kellnerUser.id}`, { headers: auth })
    await request.post(`/api/kassen/${kasse.kasseId}/ausser-betrieb`, { headers: auth, data: {} })
    for (const a of [cola, wasser]) await request.delete(`/api/artikel/${a.id}`, { headers: auth })
    await request.delete(`/api/kategorien/${gruppe.id}`, { headers: auth })
  }
})
