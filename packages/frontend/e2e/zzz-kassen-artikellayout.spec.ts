import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * Kachel-Anordnung je Kasse (POS-Konfiguration → Reiter Artikel):
 *
 *  - Editor startet mit der EFFEKTIVEN Anordnung (Standard-Layout, solange die Kasse keine eigene hat), im Raster der
 *    Kasse (4 Spalten) mit den Untergruppen als feste Kacheln vorn, leere Zellen als Ablageziel
 *  - Bedienung per Knöpfen: ← → ↑ ↓ (tauschen/verschieben), ✕ ausblenden → Ablage, Platzieren, Lücken entfernen,
 *    Änderungen verwerfen, Speichern; Zeilen kommen genau so beim Server an
 *  - Kasse UND Tisch zeigen sie in 4 Spalten (Untergruppen-Kacheln vorn, Lücken, ausgeblendeter Artikel fehlt im
 *    Raster, per Suche aber auffindbar), die Kellner-App folgt der Reihenfolge ohne Lücken und ohne den ausgeblendeten
 *  - Eine ANDERE Kasse bleibt unberührt (kein Eintrag, Standard-Layout); ungespeicherte Änderungen gehen bei Gruppen-
 *    und Kassenwechsel nicht still verloren
 *  - „Standard für alle Kassen" schreibt raster_position + reihenfolge (die andere Kasse folgt dem neuen Standard),
 *    „Auf Standard zurücksetzen" (mit Rückfrage) bringt die Kasse zurück auf den Standard
 *
 * Liegt am Ende der Suite (zzz-): setzt die Spaltenzahl und die Warengruppen-Sichtbarkeit der ersten Kasse und legt eine
 * zweite Kasse an. Eigene Daten tragen einen eindeutigen Präfix (Datei-Retries) und werden am Ende deaktiviert.
 */

const KELLNER_URL    = 'http://127.0.0.1:5178'
const APP_URL        = 'http://127.0.0.1:5173'
const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const KELLNER_EMAIL  = 'anordnung-kellner@test.at'
const KELLNER_PIN    = '1357'

test.use({ serviceWorkers: 'block' })

type Login = { token: string; user: { id: string }; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }

/**
 * /api/auth/login ist auf 10 Anmeldungen je Minute und IP begrenzt (429). Die Suite meldet sich
 * gerade am Ende oft an — bei 429 daher abwarten und erneut versuchen, statt fälschlich in
 * /api/setup zu fallen („E-Mail bereits vergeben").
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
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-ANL-001',
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

async function anmelden(page: Page, login: Login, kasseId: string) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId,
  })
}

async function post<T>(request: APIRequestContext, token: string, url: string, data: object): Promise<T> {
  const res = await request.post(url, { headers: { Authorization: `Bearer ${token}` }, data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Kasse / Tisch: Raster in Dokumentreihenfolge
// ---------------------------------------------------------------------------

const KACHEL = '[data-testid="untergruppe-kachel"], [data-testid="artikel-kachel"], [data-testid="raster-leer"]'
const KURZ: Record<string, string> = { 'untergruppe-kachel': 'G', 'artikel-kachel': 'A', 'raster-leer': '_' }

/** Je Zelle: Typ (G = Untergruppe, A = Artikel, _ = leer) + Text */
async function raster(page: Page) {
  const zellen = await page.locator(KACHEL).evaluateAll(els => els.map(el => ({
    typ: el.getAttribute('data-testid')!,
    text: ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim(),
  })))
  return zellen.map(z => ({ typ: KURZ[z.typ]!, text: z.text }))
}
const typen = (z: { typ: string }[]) => z.map(c => c.typ).join('')

async function spaltenImRaster(page: Page): Promise<number> {
  return page.locator('[data-testid="artikel-kachel"]').first().evaluate(
    el => getComputedStyle(el.parentElement!).gridTemplateColumns.split(' ').length)
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const tile = (page: Page, name: string) => page.locator('[data-testid="anordnung-artikel"]', { hasText: name })

/** Name → Slot der platzierten Artikel im Editor */
async function slots(page: Page): Promise<Record<string, number>> {
  return page.locator('[data-testid="anordnung-artikel"]').evaluateAll(els =>
    Object.fromEntries(els.map(el => [el.getAttribute('aria-label')!, Number(el.getAttribute('data-slot'))])))
}

const knopf = (page: Page, name: string, label: string) => tile(page, name).getByRole('button', { name: label, exact: true })

async function oeffneArtikelReiter(page: Page) {
  await page.goto('/pos-konfiguration')
  await page.getByRole('button', { name: 'Artikel', exact: true }).click()
  await expect(page.getByTestId('anordnung-raster')).toBeVisible({ timeout: 20_000 })
}

test('Kachel-Anordnung je Kasse: Editor per Knöpfen, Kasse/Tisch/Kellner-App folgen, andere Kasse unberührt, Standard-Ebene, Zurücksetzen', async ({ page, request, browser }) => {
  test.setTimeout(240_000)
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const token = login.token
  const auth = { Authorization: `Bearer ${token}` }
  const kasse1 = login.kassen[0]!.id
  const ts = Date.now()
  const p = `Anl${ts % 1_000_000}`
  const n = (name: string) => `${p} ${name}`

  // ---- Daten: Gruppe mit 2 Untergruppen (feste Kacheln) und 6 Artikeln im Import-Layout für 3 Spalten ------------------
  const gruppe = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Gruppe`, farbe: 'grau', reihenfolge: 7000 })
  const sub1 = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Sub1`, farbe: 'blau', reihenfolge: 0, parentId: gruppe.id })
  const sub2 = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Sub2`, farbe: 'gruen', reihenfolge: 1, parentId: gruppe.id })
  const zweite = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Zweite`, farbe: 'rot', reihenfolge: 7001 })
  const artikelIds = new Map<string, string>()
  const artikel = async (name: string, kategorieId: string, rasterPosition: number | null) => {
    const a = await post<{ id: string }>(request, token, '/api/artikel', {
      bezeichnung: n(name), preisBruttoCent: 350, mwstSatz: 'normal', kategorieId, ...(rasterPosition ? { rasterPosition } : {}),
    })
    artikelIds.set(name, a.id)
  }
  // Standard: Alpha 1, Beta 2, Gamma 3, (4 leer), Delta 5, Epsilon 6, Zeta ohne Slot → hinten (7)
  await artikel('Alpha', gruppe.id, 1)
  await artikel('Beta', gruppe.id, 2)
  await artikel('Gamma', gruppe.id, 3)
  await artikel('Delta', gruppe.id, 5)
  await artikel('Epsilon', gruppe.id, 6)
  await artikel('Zeta', gruppe.id, null)
  await artikel('Eta', zweite.id, 1)
  await artikel('Theta', zweite.id, 2)
  const id = (name: string) => artikelIds.get(name)!

  // zweite Kasse (bleibt ohne eigene Anordnung) + Kasse 1 auf 4 Spalten, alle Warengruppen sichtbar
  const kasse2 = (await post<{ kasseId: string }>(request, token, '/api/kassen', { kassenId: `E2E-ANL-${ts}`, bezeichnung: `${p} Bar`, umgebung: 'test' })).kasseId
  const konfigVorher = (await (await request.get(`/api/kassen/${kasse1}/pos-config`, { headers: auth })).json()) as { artikelProZeile: number; sichtbareKategorieIds: string[] }
  const putKonfig = async (kasseId: string, data: object) =>
    expect((await request.put(`/api/kassen/${kasseId}/pos-config`, { headers: auth, data })).status()).toBe(204)
  await putKonfig(kasse1, { artikelProZeile: 4, sichtbareKategorieIds: [] })

  // Nur die Warengruppen dieses Versuchs: frühere Versuche (Datei-Retries) hinterlassen Zeilen an Kasse 1
  const eigeneGruppen = new Set([gruppe.id, zweite.id])
  const layouts = async (kasseId: string) =>
    ((await (await request.get(`/api/kassen/${kasseId}/artikel-layouts`, { headers: auth })).json()) as
      { kategorieId: string; eintraege: { artikelId: string; position: number | null; ausgeblendet: boolean }[] }[])
      .filter(l => eigeneGruppen.has(l.kategorieId))
  const alleArtikel = async () =>
    (await (await request.get('/api/artikel?nurAktive=true', { headers: auth })).json()) as
      { id: string; bezeichnung: string; rasterPosition: number | null; reihenfolge: number }[]

  const aufraeumen: (() => Promise<void>)[] = []
  const kontexte: BrowserContext[] = []
  try {
    await anmelden(page, login, kasse1)

    // =====================================================================================================
    // 1. Editor startet mit dem Standard-Layout, im 4-Spalten-Raster der Kasse, Untergruppen als feste Kacheln
    // =====================================================================================================
    await oeffneArtikelReiter(page)
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${gruppe.id}"]`).click()
    const raum = page.getByTestId('anordnung-raster')
    await expect(raum).toHaveAttribute('data-spalten', '4')
    await expect(page.getByTestId('anordnung-untergruppe')).toHaveCount(2)
    await expect(page.getByTestId('anordnung-untergruppe').nth(0)).toContainText(`${p} Sub1`)
    await expect(page.getByTestId('anordnung-untergruppe').nth(1)).toContainText(`${p} Sub2`)
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'false')
    await expect(page.getByTestId('anordnung-status')).toContainText('Noch keine eigene Anordnung')
    const standard = { [n('Alpha')]: 1, [n('Beta')]: 2, [n('Gamma')]: 3, [n('Delta')]: 5, [n('Epsilon')]: 6, [n('Zeta')]: 7 }
    await expect.poll(() => slots(page)).toEqual(standard)
    await expect(page.locator('[data-testid="anordnung-leer"][data-slot="4"]')).toBeVisible()
    // mindestens eine ganz leere Zeile am Ende: der letzte Slot-Platz liegt in einer Zeile ohne Artikel
    const letzteLeere = page.locator('[data-testid="anordnung-leer"]').last()
    const yLetzte = (await letzteLeere.boundingBox())!.y
    const yZeta = (await tile(page, n('Zeta')).boundingBox())!.y
    expect(yLetzte).toBeGreaterThan(yZeta + 10)
    // Rasterlage: 2 Untergruppen + Alpha + Beta in Zeile 1, Gamma darunter in Spalte 1
    const box = async (loc: ReturnType<typeof tile>) => (await loc.boundingBox())!
    const kachel1 = await box(page.getByTestId('anordnung-untergruppe').nth(0))
    const kachel2 = await box(page.getByTestId('anordnung-untergruppe').nth(1))
    const alpha = await box(tile(page, n('Alpha')))
    const gamma = await box(tile(page, n('Gamma')))
    expect(Math.abs(alpha.y - kachel1.y)).toBeLessThan(3)
    expect(alpha.x).toBeGreaterThan(kachel2.x + kachel2.width / 2)
    expect(Math.abs(gamma.x - kachel1.x)).toBeLessThan(3)
    expect(gamma.y).toBeGreaterThan(alpha.y + alpha.height / 2)
    // ohne Änderung: nichts zu verwerfen, Speichern hält den Standard für diese Kasse fest
    await expect(page.getByTestId('anordnung-verwerfen')).toBeDisabled()
    await expect(page.getByTestId('anordnung-speichern')).toBeEnabled()
    await expect(page.getByTestId('anordnung-zuruecksetzen')).toBeDisabled()

    // =====================================================================================================
    // 2. Bedienen per Knöpfen
    // =====================================================================================================
    // Alpha → rechts: tauscht mit Beta
    await knopf(page, n('Alpha'), 'Nach rechts').click()
    await expect.poll(() => slots(page)).toEqual({ ...standard, [n('Alpha')]: 2, [n('Beta')]: 1 })
    await expect(page.getByTestId('anordnung-verwerfen')).toBeEnabled()
    // verwerfen → wie vorher
    await page.getByTestId('anordnung-verwerfen').click()
    await expect.poll(() => slots(page)).toEqual(standard)
    await expect(page.getByTestId('anordnung-verwerfen')).toBeDisabled()
    // Ränder: Alpha steht in Slot 1 → ← gesperrt; ↑ in der ersten Zeile gesperrt
    await expect(knopf(page, n('Alpha'), 'Nach links')).toBeDisabled()
    await expect(knopf(page, n('Alpha'), 'Eine Zeile nach oben')).toBeDisabled()
    await expect(knopf(page, n('Delta'), 'Eine Zeile nach oben')).toBeEnabled()

    await knopf(page, n('Alpha'), 'Nach rechts').click()                     // B1 A2 G3 _4 D5 E6 Z7
    await knopf(page, n('Delta'), 'Eine Zeile nach oben').click()            // Slot 5 → 1: tauscht mit Beta → D1 A2 G3 _4 B5 E6 Z7
    await expect.poll(() => slots(page)).toEqual({
      [n('Delta')]: 1, [n('Alpha')]: 2, [n('Gamma')]: 3, [n('Beta')]: 5, [n('Epsilon')]: 6, [n('Zeta')]: 7,
    })
    // Epsilon ausblenden → Ablage, sein Platz bleibt als leeres Feld
    await knopf(page, n('Epsilon'), 'Ausblenden').click()                    // D1 A2 G3 _4 B5 _6 Z7
    const ablage = page.getByTestId('anordnung-ablage')
    await expect(ablage.getByTestId('anordnung-ablage-artikel')).toHaveCount(1)
    await expect(ablage.getByTestId('anordnung-ablage-artikel')).toContainText(n('Epsilon'))
    await expect(page.locator('[data-testid="anordnung-leer"][data-slot="6"]')).toBeVisible()
    // Zeta ← : in das freie Feld 6
    await knopf(page, n('Zeta'), 'Nach links').click()                       // D1 A2 G3 _4 B5 Z6
    await expect.poll(() => slots(page)).toEqual({
      [n('Delta')]: 1, [n('Alpha')]: 2, [n('Gamma')]: 3, [n('Beta')]: 5, [n('Zeta')]: 6,
    })
    // Lücken entfernen: verdichtet lückenlos in aktueller Reihenfolge
    await expect(page.getByTestId('anordnung-luecken')).toBeEnabled()
    await page.getByTestId('anordnung-luecken').click()                      // D1 A2 G3 B4 Z5
    await expect.poll(() => slots(page)).toEqual({
      [n('Delta')]: 1, [n('Alpha')]: 2, [n('Gamma')]: 3, [n('Beta')]: 4, [n('Zeta')]: 5,
    })
    await expect(page.getByTestId('anordnung-luecken')).toBeDisabled()
    // Platzieren: Epsilon in die erste freie Zelle — keine Lücke mehr, also hinten
    await ablage.getByRole('button', { name: /platzieren/i }).click()        // D1 A2 G3 B4 Z5 E6
    await expect.poll(() => slots(page)).toEqual({
      [n('Delta')]: 1, [n('Alpha')]: 2, [n('Gamma')]: 3, [n('Beta')]: 4, [n('Zeta')]: 5, [n('Epsilon')]: 6,
    })
    await expect(ablage.getByTestId('anordnung-ablage-artikel')).toHaveCount(0)
    // Gamma ausblenden → Lücke in Slot 3, Gamma in der Ablage
    await knopf(page, n('Gamma'), 'Ausblenden').click()                      // D1 A2 _3 B4 Z5 E6
    await expect(ablage.getByTestId('anordnung-ablage-artikel')).toContainText(n('Gamma'))

    // =====================================================================================================
    // 3. Speichern: Zeilen kommen genau so beim Server an
    // =====================================================================================================
    await page.getByTestId('anordnung-speichern').click()
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'true', { timeout: 15_000 })
    await expect(page.getByTestId('anordnung-meldung')).toHaveText('Gespeichert.')
    await expect(page.getByTestId('anordnung-speichern')).toBeDisabled()
    await expect(page.getByTestId('anordnung-verwerfen')).toBeDisabled()
    await expect(page.getByTestId('anordnung-zuruecksetzen')).toBeEnabled()
    const gespeichert = (await layouts(kasse1)).find(l => l.kategorieId === gruppe.id)!
    expect(gespeichert.eintraege).toEqual([
      { artikelId: id('Delta'), position: 1, ausgeblendet: false },
      { artikelId: id('Alpha'), position: 2, ausgeblendet: false },
      { artikelId: id('Beta'), position: 4, ausgeblendet: false },
      { artikelId: id('Zeta'), position: 5, ausgeblendet: false },
      { artikelId: id('Epsilon'), position: 6, ausgeblendet: false },
      { artikelId: id('Gamma'), position: null, ausgeblendet: true },
    ])
    // andere Warengruppe derselben Kasse unberührt
    expect((await layouts(kasse1)).some(l => l.kategorieId === zweite.id)).toBe(false)
    await expect(page.locator(`[data-testid="wg-chip"][data-kategorie-id="${gruppe.id}"]`)).toHaveAttribute('data-eigene', 'true')
    await expect(page.locator(`[data-testid="wg-chip"][data-kategorie-id="${zweite.id}"]`)).toHaveAttribute('data-eigene', 'false')

    // Neu laden: die Anordnung ist gespeichert
    await oeffneArtikelReiter(page)
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${gruppe.id}"]`).click()
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'true')
    await expect.poll(() => slots(page)).toEqual({
      [n('Delta')]: 1, [n('Alpha')]: 2, [n('Beta')]: 4, [n('Zeta')]: 5, [n('Epsilon')]: 6,
    })
    await expect(page.getByTestId('anordnung-ablage').getByTestId('anordnung-ablage-artikel')).toContainText(n('Gamma'))

    // =====================================================================================================
    // 4. Kasse: 4 Spalten, Untergruppen vorn, Anordnung mit Lücke, Gamma nicht im Raster (aber per Suche da)
    // =====================================================================================================
    const pruefeKassenRaster = async (seite: Page) => {
      await seite.getByRole('button', { name: new RegExp(`^${p} Gruppe`) }).click()
      await expect.poll(async () => typen(await raster(seite))).toBe('GGAA_AAA')
      const z = await raster(seite)
      expect(z[0]!.text).toContain(`${p} Sub1`)
      expect(z[1]!.text).toContain(`${p} Sub2`)
      expect(z[2]!.text).toContain(n('Delta'))
      expect(z[3]!.text).toContain(n('Alpha'))
      expect(z[5]!.text).toContain(n('Beta'))
      expect(z[6]!.text).toContain(n('Zeta'))
      expect(z[7]!.text).toContain(n('Epsilon'))
      expect(await spaltenImRaster(seite)).toBe(4)
      // der ausgeblendete Artikel fehlt im Raster und im Zähler des Reiters (6 − 1), die Suche findet ihn
      await expect(seite.locator('[data-testid="artikel-kachel"]', { hasText: n('Gamma') })).toHaveCount(0)
      await expect(seite.getByRole('button', { name: new RegExp(`^${p} Gruppe\\s*5$`) })).toBeVisible()
      await seite.getByPlaceholder(/Artikel suchen/).fill(n('Gamma'))
      await expect(seite.locator('[data-testid="artikel-kachel"]', { hasText: n('Gamma') })).toHaveCount(1)
      await seite.getByPlaceholder(/Artikel suchen/).fill('')
    }
    await page.goto('/kasse')
    await pruefeKassenRaster(page)

    // =====================================================================================================
    // 5. Tisch: dasselbe Raster
    // =====================================================================================================
    const tab = await post<{ id: string }>(request, token, '/api/tisch-tabs', { kasseId: kasse1, tischNummer: `A${ts % 100000}`, kellner: 'E2E' })
    aufraeumen.push(async () => { await request.post(`/api/tisch-tabs/${tab.id}/verwerfen`, { headers: auth, data: {} }) })
    await page.goto(`/tische/${tab.id}`)
    await pruefeKassenRaster(page)

    // =====================================================================================================
    // 6. Kellner-App: Reihenfolge der Anordnung ohne Lücken, ohne den ausgeblendeten Artikel
    // =====================================================================================================
    const vorhandene = (await (await request.get('/api/users', { headers: auth })).json()) as { email: string }[]
    if (!vorhandene.some(u => u.email === KELLNER_EMAIL)) {
      const anlage = await request.post('/api/users', {
        headers: auth,
        data: { name: 'Anordnung Kellner', email: KELLNER_EMAIL, passwort: 'kellner-passwort-123', rolle: 'kellner', berechtigungen: ['tische'], kassenIds: [kasse1], pin: KELLNER_PIN },
      })
      if (!anlage.ok()) throw new Error(`Kellner-Anlage fehlgeschlagen (${anlage.status()}): ${await anlage.text()}`)
    }
    const kellnerKontext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    kontexte.push(kellnerKontext)
    await kellnerKontext.addInitScript((d: { mandantId: string; kasseId: string }) => {
      localStorage.setItem('kellner:mandantId', d.mandantId)
      localStorage.setItem('kellner:kasseId', d.kasseId)
    }, { mandantId: login.mandant.id, kasseId: kasse1 })
    const kellner = await kellnerKontext.newPage()
    await expect.poll(async () => (await kellner.request.get(`${KELLNER_URL}/api/health`)).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
    await kellner.goto(`${KELLNER_URL}/login`)
    await expect(kellner.getByText('PIN eingeben')).toBeVisible({ timeout: 15_000 })
    for (const ziffer of KELLNER_PIN) await kellner.getByRole('button', { name: ziffer, exact: true }).click()
    await expect(kellner.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 15_000 })
    const kellnerTisch = `K${ts % 100000}`
    await kellner.getByRole('button', { name: '+ Tisch' }).click()
    await kellner.getByPlaceholder(/Tisch 3 oder Bar/).fill(kellnerTisch)
    await kellner.getByRole('button', { name: 'Öffnen' }).click()
    await expect(kellner.getByRole('heading', { name: `Tisch ${kellnerTisch}` })).toBeVisible({ timeout: 10_000 })
    aufraeumen.push(async () => {
      const tabs = (await (await request.get(`/api/tisch-tabs?kasseId=${kasse1}`, { headers: auth })).json()) as { id: string; tischNummer: string }[]
      for (const t of tabs.filter(x => x.tischNummer === kellnerTisch)) await request.post(`/api/tisch-tabs/${t.id}/verwerfen`, { headers: auth, data: {} })
    })
    await kellner.getByRole('button', { name: `${p} Gruppe`, exact: true }).click()
    const kellnerNamen = () => kellner.locator('[data-testid="artikel-kachel"]').evaluateAll(els => els.map(el => el.querySelector('p')!.textContent!.trim()))
    // Standard wäre alphabetisch (Alpha, Beta, Delta, Epsilon, Gamma, Zeta) — hier gilt die Anordnung der Kasse
    await expect.poll(kellnerNamen).toEqual([n('Delta'), n('Alpha'), n('Beta'), n('Zeta'), n('Epsilon')])
    await expect(kellner.getByTestId('artikel-platzhalter')).toHaveCount(0)

    // =====================================================================================================
    // 7. Die andere Kasse bleibt unberührt
    // =====================================================================================================
    expect(await layouts(kasse2)).toEqual([])
    await oeffneArtikelReiter(page)
    await page.getByRole('button', { name: `${p} Bar`, exact: true }).click()        // Kasse wählen
    await expect(page.getByTestId('anordnung-tab')).toBeVisible()
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${gruppe.id}"]`).click()
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'false')
    await expect.poll(() => slots(page)).toEqual(standard)

    // ---- ungespeicherte Änderungen gehen nie still verloren --------------------------------------------------
    await knopf(page, n('Alpha'), 'Nach rechts').click()
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${zweite.id}"]`).click()
    const hinweis = page.getByTestId('anordnung-wechsel-hinweis')
    await expect(hinweis).toBeVisible()
    await expect(hinweis).toContainText('ungespeicherte Änderungen')
    await hinweis.getByRole('button', { name: 'Hier bleiben' }).click()
    await expect(hinweis).toHaveCount(0)
    await expect.poll(() => slots(page)).toEqual({ ...standard, [n('Alpha')]: 2, [n('Beta')]: 1 })     // Änderung steht noch
    // Kassenwechsel fragt die Seite
    await page.getByRole('button', { name: new RegExp('diese$') }).click()
    await expect(page.getByTestId('anordnung-wechsel-hinweis')).toBeVisible()
    await page.getByTestId('anordnung-wechsel-hinweis').getByRole('button', { name: 'Hier bleiben' }).click()
    await expect.poll(() => slots(page)).toEqual({ ...standard, [n('Alpha')]: 2, [n('Beta')]: 1 })
    // Gruppenwechsel: verwerfen und wechseln
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${zweite.id}"]`).click()
    await page.getByTestId('anordnung-wechsel-hinweis').getByRole('button', { name: 'Verwerfen und wechseln' }).click()
    await expect.poll(() => slots(page)).toEqual({ [n('Eta')]: 1, [n('Theta')]: 2 })
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${gruppe.id}"]`).click()           // nichts geändert → kein Hinweis
    await expect(page.getByTestId('anordnung-wechsel-hinweis')).toHaveCount(0)
    await expect.poll(() => slots(page)).toEqual(standard)

    // =====================================================================================================
    // 8. Standard für alle Kassen: schreibt raster_position + reihenfolge; die andere Kasse folgt dem neuen Standard
    // =====================================================================================================
    await page.getByTestId('anordnung-modus-standard').click()
    await expect(page.getByTestId('anordnung-raster')).toHaveAttribute('data-spalten', '3')
    await expect(page.getByTestId('anordnung-status')).toContainText('Standard-Layout')
    await expect(page.getByRole('button', { name: 'Ausblenden', exact: true })).toHaveCount(0)             // im Standard gibt es kein Ausblenden
    await expect.poll(() => slots(page)).toEqual(standard)
    await knopf(page, n('Zeta'), 'Nach links').click()                                                    // tauscht mit Epsilon: Z6 E7
    await expect.poll(() => slots(page)).toEqual({ ...standard, [n('Zeta')]: 6, [n('Epsilon')]: 7 })
    await page.getByTestId('anordnung-speichern').click()
    await expect(page.getByTestId('anordnung-meldung')).toHaveText('Standard-Layout gespeichert.', { timeout: 15_000 })
    const artikelNach = new Map((await alleArtikel()).map(a => [a.bezeichnung, a] as const))
    for (const [name, slot] of Object.entries({ Alpha: 1, Beta: 2, Gamma: 3, Delta: 5, Zeta: 6, Epsilon: 7 })) {
      expect(artikelNach.get(n(name)), name).toMatchObject({ rasterPosition: slot, reihenfolge: slot })
    }
    // die Anordnung von Kasse 1 und die der anderen Gruppe sind davon unberührt
    expect((await layouts(kasse1)).find(l => l.kategorieId === gruppe.id)!.eintraege).toEqual(gespeichert.eintraege)
    expect(artikelNach.get(n('Eta'))).toMatchObject({ rasterPosition: 1 })
    expect(await layouts(kasse2)).toEqual([])

    // Kasse 2 (eigene Sitzung mit ihrer Kassen-Identität): neuer Standard in 4 Spalten
    const kasse2Kontext = await browser.newContext({ baseURL: APP_URL, serviceWorkers: 'block' })
    kontexte.push(kasse2Kontext)
    const seite2 = await kasse2Kontext.newPage()
    await anmelden(seite2, login, kasse2)
    await seite2.goto('/kasse')
    await seite2.getByRole('button', { name: new RegExp(`^${p} Gruppe`) }).click()
    // G G | Alpha Beta | Gamma _ Delta Zeta | Epsilon  (Slot 4 leer, Standard-Layout)
    await expect.poll(async () => typen(await raster(seite2))).toBe('GGAAA_AAA')
    const z2 = await raster(seite2)
    expect(z2[7]!.text).toContain(n('Zeta'))
    expect(z2[8]!.text).toContain(n('Epsilon'))
    expect(await spaltenImRaster(seite2)).toBe(4)
    await expect(seite2.getByRole('button', { name: new RegExp(`^${p} Gruppe\\s*6$`) })).toBeVisible()        // nichts ausgeblendet

    // =====================================================================================================
    // 9. Zurücksetzen (mit Rückfrage): Kasse 1 folgt wieder dem Standard
    // =====================================================================================================
    await page.getByRole('button', { name: new RegExp('diese$') }).click()                                // zurück zu Kasse 1
    await page.getByTestId('anordnung-modus-kasse').click()
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${gruppe.id}"]`).click()
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'true')
    await page.getByTestId('anordnung-zuruecksetzen').click()
    const frage = page.getByTestId('anordnung-zuruecksetzen-frage')
    await expect(frage).toBeVisible()
    await frage.getByRole('button', { name: 'Abbrechen' }).click()                                        // erst abbrechen: nichts passiert
    await expect(frage).toHaveCount(0)
    expect((await layouts(kasse1)).some(l => l.kategorieId === gruppe.id)).toBe(true)
    await page.getByTestId('anordnung-zuruecksetzen').click()
    await page.getByTestId('anordnung-zuruecksetzen-ja').click()
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'false', { timeout: 15_000 })
    expect(await layouts(kasse1)).toEqual([])
    // Editor zeigt jetzt den (neuen) Standard im 4er-Raster; die Kasse ebenso
    await expect.poll(() => slots(page)).toEqual({ ...standard, [n('Zeta')]: 6, [n('Epsilon')]: 7 })
    await page.goto('/kasse')
    await page.getByRole('button', { name: new RegExp(`^${p} Gruppe`) }).click()
    await expect.poll(async () => typen(await raster(page))).toBe('GGAAA_AAA')
    await expect(page.locator('[data-testid="artikel-kachel"]', { hasText: n('Gamma') })).toHaveCount(1)  // Gamma ist wieder im Raster
  } finally {
    for (const k of kontexte) await k.close().catch(() => undefined)
    for (const a of aufraeumen) await a().catch(() => undefined)
    // eigene Daten deaktivieren, Kasse 1 zurücksetzen (spätere Specs teilen die Instanz)
    for (const aid of artikelIds.values()) await request.delete(`/api/artikel/${aid}`, { headers: auth }).catch(() => undefined)
    for (const kid of [sub1.id, sub2.id, zweite.id, gruppe.id]) await request.delete(`/api/kategorien/${kid}`, { headers: auth }).catch(() => undefined)
    await request.put(`/api/kassen/${kasse1}/pos-config`, { headers: auth, data: { artikelProZeile: konfigVorher.artikelProZeile, sichtbareKategorieIds: konfigVorher.sichtbareKategorieIds } }).catch(() => undefined)
  }
})

// ---------------------------------------------------------------------------
// Ziehen (dnd-kit): freie Zelle, belegte Zelle (tauscht), Ablage, aus der Ablage zurück
// ---------------------------------------------------------------------------

test('Kachel-Anordnung: Ziehen auf eine freie Zelle, auf eine belegte (tauscht), auf die Ablage und aus der Ablage zurück', async ({ page, request }) => {
  test.setTimeout(180_000)
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const token = login.token
  const auth = { Authorization: `Bearer ${token}` }
  const kasse1 = login.kassen[0]!.id
  const p = `Zug${Date.now() % 1_000_000}`
  const n = (name: string) => `${p} ${name}`

  const gruppe = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Gruppe`, farbe: 'grau', reihenfolge: 7100 })
  const artikelIds: string[] = []
  for (const [name, slot] of [['Eins', 1], ['Zwei', 2], ['Drei', 4]] as const) {
    const a = await post<{ id: string }>(request, token, '/api/artikel', {
      bezeichnung: n(name), preisBruttoCent: 250, mwstSatz: 'normal', kategorieId: gruppe.id, rasterPosition: slot,
    })
    artikelIds.push(a.id)
  }
  const konfigVorher = (await (await request.get(`/api/kassen/${kasse1}/pos-config`, { headers: auth })).json()) as { artikelProZeile: number; sichtbareKategorieIds: string[] }
  expect((await request.put(`/api/kassen/${kasse1}/pos-config`, { headers: auth, data: { artikelProZeile: 4, sichtbareKategorieIds: [] } })).status()).toBe(204)

  /** Maus-Ziehen mit Zwischenschritten (dnd-kit aktiviert erst nach 8 px) vom oberen Teil der Kachel — dort liegen keine Knöpfe */
  const ziehe = async (von: ReturnType<typeof tile>, ziel: ReturnType<typeof tile>) => {
    const a = (await von.boundingBox())!
    const b = (await ziel.boundingBox())!
    const startX = a.x + Math.min(a.width / 2, 40)      // links im Namen: weder auf einem Knopf noch am Rand
    const startY = a.y + Math.min(a.height / 3, 30)
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 14, startY + 14, { steps: 4 })
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 })
    await page.mouse.up()
    // dnd-kit verschluckt nach dem Loslassen noch 50 ms lang alle Klicks am Dokument (capture-Listener, damit der
    // Zieh-Abschluss keinen Klick auf das Ziel auslöst). Ein Klick direkt danach — etwa auf „Speichern" — ginge
    // verloren (gemessen: Klick nach 8 ms wirkungslos, nach 100 ms normal). Ein Mensch ist nie so schnell,
    // der Test schon → kurz warten.
    await page.waitForTimeout(120)
  }

  try {
    await page.setViewportSize({ width: 1280, height: 1300 })
    await anmelden(page, login, kasse1)
    await oeffneArtikelReiter(page)
    await page.locator(`[data-testid="wg-chip"][data-kategorie-id="${gruppe.id}"]`).click()
    await expect.poll(() => slots(page)).toEqual({ [n('Eins')]: 1, [n('Zwei')]: 2, [n('Drei')]: 4 })

    // 1. Eins auf die freie Zelle 3
    await ziehe(tile(page, n('Eins')), page.locator('[data-testid="anordnung-leer"][data-slot="3"]'))
    await expect.poll(() => slots(page)).toEqual({ [n('Zwei')]: 2, [n('Eins')]: 3, [n('Drei')]: 4 })
    await expect(page.getByTestId('anordnung-verwerfen')).toBeEnabled()

    // 2. Eins (Slot 3) auf Zwei (Slot 2): die beiden tauschen
    await ziehe(tile(page, n('Eins')), tile(page, n('Zwei')))
    await expect.poll(() => slots(page)).toEqual({ [n('Eins')]: 2, [n('Zwei')]: 3, [n('Drei')]: 4 })

    // 3. Drei auf die Ablage → ausgeblendet
    await ziehe(tile(page, n('Drei')), page.getByTestId('anordnung-ablage'))
    await expect.poll(() => slots(page)).toEqual({ [n('Eins')]: 2, [n('Zwei')]: 3 })
    await expect(page.getByTestId('anordnung-ablage').getByTestId('anordnung-ablage-artikel')).toContainText(n('Drei'))

    // 4. aus der Ablage auf eine freie Zelle (Slot 6); auf eine belegte Zelle passiert nichts
    const ablageEintrag = page.getByTestId('anordnung-ablage').getByTestId('anordnung-ablage-artikel')
    await ziehe(ablageEintrag, tile(page, n('Eins')))
    await expect.poll(() => slots(page)).toEqual({ [n('Eins')]: 2, [n('Zwei')]: 3 })
    await ziehe(ablageEintrag, page.locator('[data-testid="anordnung-leer"][data-slot="6"]'))
    await expect.poll(() => slots(page)).toEqual({ [n('Eins')]: 2, [n('Zwei')]: 3, [n('Drei')]: 6 })
    await expect(page.getByTestId('anordnung-ablage').getByTestId('anordnung-ablage-artikel')).toHaveCount(0)

    // gezogen ist nur im Editor — gespeichert wird erst mit „Speichern"
    expect((await (await request.get(`/api/kassen/${kasse1}/artikel-layouts`, { headers: auth })).json() as { kategorieId: string }[]).some(l => l.kategorieId === gruppe.id)).toBe(false)
    await page.getByTestId('anordnung-speichern').click()
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'true', { timeout: 15_000 })
    const gespeichert = ((await (await request.get(`/api/kassen/${kasse1}/artikel-layouts`, { headers: auth })).json()) as
      { kategorieId: string; eintraege: { artikelId: string; position: number | null; ausgeblendet: boolean }[] }[]).find(l => l.kategorieId === gruppe.id)!
    expect(gespeichert.eintraege.map(e => [e.artikelId, e.position])).toEqual([[artikelIds[0], 2], [artikelIds[1], 3], [artikelIds[2], 6]])
    // aufräumen: Anordnung weg, damit die Gruppe sauber deaktiviert werden kann
    expect((await request.delete(`/api/kassen/${kasse1}/artikel-layouts/${gruppe.id}`, { headers: auth })).status()).toBe(204)
  } finally {
    for (const aid of artikelIds) await request.delete(`/api/artikel/${aid}`, { headers: auth }).catch(() => undefined)
    await request.delete(`/api/kategorien/${gruppe.id}`, { headers: auth }).catch(() => undefined)
    await request.put(`/api/kassen/${kasse1}/pos-config`, { headers: auth, data: { artikelProZeile: konfigVorher.artikelProZeile, sichtbareKategorieIds: konfigVorher.sichtbareKategorieIds } }).catch(() => undefined)
  }
})
