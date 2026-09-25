import { test, expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test'

/**
 * „Abbrechen" während der Kartenzahlung, wenn der Gast am Terminal schon
 * bezahlt hat: Das Backend lässt einen fertigen Job unverändert und schickt ihn
 * als Antwort auf den Abbruch zurück — mit „erfolg". Früher warf der Dialog diese
 * Antwort weg und meldete „Kartenzahlung abgebrochen — kein Beleg erstellt": Die
 * Karte war belastet, ein Beleg entstand nie. Jetzt zählt die Antwort: Die Kasse
 * erstellt den Beleg, Tisch und Kellner-App rechnen den Tisch ab, und der Kassier
 * erfährt, dass der Abbruch zu spät kam.
 *
 * Dazu die Rennen rund um den Abbruch: eine Abfrage, die beim Abbruch noch
 * unterwegs ist; eine späte Antwort der abgebrochenen Zahlung, die im Dialog der
 * nächsten landet; ein Abbruch, bevor die Zahlung überhaupt gestartet ist.
 *
 * Terminal = ZVT-Stub (≈3,5 s bis „erfolg"). Die Job-Abfrage des Browsers wird per
 * page.route auf „Zahlung am Terminal" gehalten — so zeigt der Dialog noch die
 * laufende Zahlung, während der Job im Backend längst bezahlt ist.
 */

const KELLNER_URL    = 'http://127.0.0.1:5178'
const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const ABGEBROCHEN    = 'Kartenzahlung abgebrochen — kein Beleg erstellt'
const ZU_SPAET       = /Abbruch kam zu spät/

test.use({
  viewport: { width: 1280, height: 800 },
  // page.route sieht keine Anfragen, die ein Service Worker kontrolliert
  serviceWorkers: 'block',
})

type Login  = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }
type Auth   = Record<string, string>
type ZvtJob = { id: string; status: string }
type Beleg  = { belegNummer: number; summeKarteCent: number }

// Einmal je Datei anmelden: /api/auth/login ist je IP auf 10/min begrenzt,
// und die ganze Suite teilt sich 127.0.0.1 (Muster toasts-unter-dialogen).
let gemerkterLogin: Login | null = null

async function adminLogin(request: APIRequestContext): Promise<Login> {
  gemerkterLogin ??= await neuerAdminLogin(request)
  return gemerkterLogin
}

async function neuerAdminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Kartenabbruch GmbH',
        uid:        'ATU87654333',
        kassenId:   'E2E-ZVT-ABBRUCH-001',
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
  return res.json() as Promise<Login>
}

/** Warmup: erste Verbindung Preview-Proxy → Backend absichern (Muster onboarding) */
async function warmup(request: APIRequestContext, url = '/api/health') {
  await expect.poll(
    async () => (await request.get(url)).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)
}

/** Kasse (Port 5173) angemeldet öffnen — Stammdaten frisch aus /api/auth/me */
async function kasseAnmelden(page: Page, request: APIRequestContext, login: Login) {
  const ich = await (await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${login.token}` },
  })).json() as { user: unknown; mandant: { id: string }; kassen: { id: string }[] }
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:     login.token,
    authJson:  JSON.stringify(ich),
    mandantId: ich.mandant.id,
    kasseId:   login.kassen[0]!.id,
  })
}

/** Kellner-App (Port 5178) mit dem Admin angemeldet — der PIN-Login ist hier nicht Thema */
async function kellnerAnmelden(page: Page, login: Login) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kellner:token', d.token)
    localStorage.setItem('kellner:auth', d.authJson)
    localStorage.setItem('kellner:mandantId', d.mandantId)
    localStorage.setItem('kellner:kasseId', d.kasseId)
  }, {
    token:     login.token,
    authJson:  JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id,
    kasseId:   login.kassen[0]!.id,
  })
}

/** ZVT-Stub an der Kasse einschalten — liefert die Funktion, die den alten Stand zurückstellt */
async function zvtStub(request: APIRequestContext, auth: Auth, kasseId: string) {
  const vorher = await (await request.get(`/api/kassen/${kasseId}/zvt`, { headers: auth })).json() as { zvtIp: string | null; zvtAktiv: boolean }
  expect((await request.patch(`/api/kassen/${kasseId}/zvt`, {
    headers: auth, data: { zvtIp: 'stub', zvtAktiv: true },
  })).ok()).toBe(true)
  return async () => {
    await request.patch(`/api/kassen/${kasseId}/zvt`, { headers: auth, data: { zvtIp: vorher.zvtIp, zvtAktiv: vorher.zvtAktiv } })
  }
}

/** Eindeutig je Versuch — Datei-Retries teilen sich die Instanz */
async function neuerArtikel(request: APIRequestContext, auth: Auth, name: string, preisBruttoCent: number) {
  return (await request.post('/api/artikel', {
    headers: auth,
    data: { bezeichnung: `${name} ${Date.now() % 100000}`, preisBruttoCent, mwstSatz: 'normal' },
  })).json() as Promise<{ id: string; bezeichnung: string }>
}

/** Offener Tisch mit einer Position */
async function neuerTisch(
  request: APIRequestContext, auth: Auth, kasseId: string,
  artikel: { id: string; bezeichnung: string }, preisBruttoCent: number,
) {
  const tischNummer = `A${Date.now() % 100000}`
  const tab = await (await request.post('/api/tisch-tabs', {
    headers: auth, data: { kasseId, tischNummer, kellner: 'E2E Service' },
  })).json() as { id: string }
  expect((await request.put(`/api/tisch-tabs/${tab.id}/positionen`, {
    headers: auth,
    data: { positionen: [{ artikelId: artikel.id, bezeichnung: artikel.bezeichnung, preisBruttoCent, menge: 1 }] },
  })).ok()).toBe(true)
  return { id: tab.id, tischNummer }
}

async function inDenWarenkorb(page: Page, bezeichnung: string) {
  const suche = page.getByPlaceholder(/Artikel suchen/)
  await suche.fill(bezeichnung)
  await page.getByRole('button', { name: bezeichnung }).first().click()
  await suche.fill('')
  await expect(page.getByTitle('Menge eingeben')).toHaveCount(1)
}

/** Belege der Kasse mitschreiben (POST /api/belege/barzahlung) */
function belegeMitschreiben(page: Page) {
  const belege: Beleg[] = []
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && r.url().endsWith('/api/belege/barzahlung') && r.ok()) {
      belege.push(await r.json() as Beleg)
    }
  })
  return belege
}

/**
 * Terminal „hält": Die Job-Abfrage des Browsers bekommt „Zahlung am Terminal",
 * egal wie weit der Stub-Job im Backend ist. `halteNaechste()` lässt die nächste
 * Abfrage ganz hängen (WLAN) — sie kommt erst mit `loslassen()` an, dann mit der
 * echten Antwort des Backends. `freigeben()` beendet das Halten.
 */
async function terminalHalten(page: Page) {
  const gehalten: Route[] = []
  let halten = false
  await page.route('**/api/zvt/zahlung/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (halten && gehalten.length === 0) { gehalten.push(route); return }
    const jobId = new URL(route.request().url()).pathname.split('/').pop()!
    return route.fulfill({ json: {
      id: jobId, status: 'autorisiere', betragCent: 100,
      meldung: 'Karte eingesteckt — PIN-Eingabe', gestartetAm: new Date().toISOString(),
    } })
  })
  return {
    async halteNaechste() {
      halten = true
      await expect.poll(() => gehalten.length).toBe(1)
    },
    async loslassen() {
      const route = gehalten[0]!
      await route.fulfill({ response: await route.fetch() })
    },
    async freigeben() {
      await page.unroute('**/api/zvt/zahlung/*')
    },
  }
}

/** Der Start der Terminal-Zahlung hängt — erst `loslassen()` legt den Job im Backend an */
async function startHalten(page: Page) {
  const gehalten: Route[] = []
  await page.route('**/api/zvt/zahlung', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    gehalten.push(route)
  })
  return {
    anzahl: () => gehalten.length,
    async loslassen(): Promise<string> {
      const route = gehalten[0]!
      const echt  = await route.fetch()
      const { jobId } = await echt.json() as { jobId: string }
      await route.fulfill({ response: echt })
      return jobId
    },
  }
}

/** Karte → Trinkgeld „Weiter" → Terminal: liefert die jobId */
async function starteKartenzahlung(page: Page, karte: Locator, weiter: Locator): Promise<string> {
  const start = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/zvt/zahlung'))
  await karte.click()
  await weiter.click()
  return ((await (await start).json()) as { jobId: string }).jobId
}

/** Status des Terminal-Jobs aus Sicht des Backends — am Browser (und page.route) vorbei */
async function warteAufJob(request: APIRequestContext, auth: Auth, jobId: string, status: string) {
  await expect.poll(
    async () => ((await (await request.get(`/api/zvt/zahlung/${jobId}`, { headers: auth })).json()) as ZvtJob).status,
    { timeout: 15_000 },
  ).toBe(status)
}

/** „Abbrechen" drücken und die Antwort des Backends auf den Abbruch abwarten */
async function brichAb(page: Page, knopf: Locator, jobId: string): Promise<ZvtJob> {
  const antwort = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().endsWith(`/api/zvt/zahlung/${jobId}/abbrechen`),
    { timeout: 10_000 },
  )
  await knopf.click()
  return (await antwort).json() as Promise<ZvtJob>
}

/** Antwort auf das Abrechnen des Tisches (Kasse wie Kellner-App) */
function bezahlAntwort(page: Page, tabId: string) {
  return page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().endsWith(`/api/tisch-tabs/${tabId}/bezahlen`),
    { timeout: 10_000 },
  )
}

/** Nächster Abbruch-Aufruf, egal für welchen Job */
function naechsterAbbruch(page: Page) {
  return page.waitForResponse(
    r => r.request().method() === 'POST' && /\/api\/zvt\/zahlung\/[^/]+\/abbrechen$/.test(r.url()),
    { timeout: 10_000 },
  )
}

test.describe('Kartenzahlung: „Abbrechen" nach der Zahlung am Terminal', () => {

test('Kasse: Gast hat schon bezahlt — die Antwort auf den Abbruch zählt, der Beleg entsteht', async ({ page, request }) => {
  await warmup(request)
  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const zurueck = await zvtStub(request, auth, kasseId)
  const artikel = await neuerArtikel(request, auth, 'Zu-spät-Kaffee', 420)

  try {
    await kasseAnmelden(page, request, login)
    await page.goto('/kasse')
    await inDenWarenkorb(page, artikel.bezeichnung)
    await terminalHalten(page)
    const belege = belegeMitschreiben(page)
    const dialog = page.getByRole('dialog')

    const jobId = await starteKartenzahlung(page, page.getByRole('button', { name: /^Karte \(/ }), page.getByRole('button', { name: 'Weiter →' }))
    await expect(dialog.getByText('Zahlung am Terminal')).toBeVisible()
    // Der Gast bezahlt — die Kasse zeigt weiter „Zahlung am Terminal"
    await warteAufJob(request, auth, jobId, 'erfolg')

    // Das Backend lässt den bezahlten Job stehen und sagt das auch
    expect((await brichAb(page, dialog.getByRole('button', { name: 'Abbrechen' }), jobId)).status).toBe('erfolg')

    await expect.poll(() => belege.length, { timeout: 10_000 }).toBe(1)
    expect(belege[0]!.summeKarteCent).toBe(420)
    await expect(page.getByText(ZU_SPAET)).toBeVisible()
    await expect(page.getByText(ABGEBROCHEN)).toHaveCount(0)
  } finally {
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    await zurueck()
  }
})

test('Kasse: Abfrage beim Abbruch noch unterwegs — gebucht wird sofort und genau einmal', async ({ page, request }) => {
  await warmup(request)
  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const zurueck = await zvtStub(request, auth, kasseId)
  const artikel = await neuerArtikel(request, auth, 'WLAN-Kaffee', 390)

  try {
    await kasseAnmelden(page, request, login)
    await page.goto('/kasse')
    await inDenWarenkorb(page, artikel.bezeichnung)
    const terminal = await terminalHalten(page)
    const belege   = belegeMitschreiben(page)
    const dialog   = page.getByRole('dialog')

    const jobId = await starteKartenzahlung(page, page.getByRole('button', { name: /^Karte \(/ }), page.getByRole('button', { name: 'Weiter →' }))
    await expect(dialog.getByText('Zahlung am Terminal')).toBeVisible()
    await warteAufJob(request, auth, jobId, 'erfolg')

    // Die nächste Abfrage hängt im WLAN — genau jetzt drückt der Kassier „Abbrechen"
    await terminal.halteNaechste()
    expect((await brichAb(page, dialog.getByRole('button', { name: 'Abbrechen' }), jobId)).status).toBe('erfolg')

    // Die Antwort auf den Abbruch genügt: der Beleg entsteht, ohne auf die hängende Abfrage zu warten
    await expect.poll(() => belege.length, { timeout: 10_000 }).toBe(1)
    await expect(page.getByText(ZU_SPAET)).toBeVisible()
    await expect(page.getByText(ABGEBROCHEN)).toHaveCount(0)

    // Die hängende Abfrage kommt doch noch an — auch mit „erfolg": kein zweiter Beleg
    await terminal.loslassen()
    await page.waitForTimeout(1_500)
    expect(belege).toHaveLength(1)
    await expect(page.getByText(ABGEBROCHEN)).toHaveCount(0)
  } finally {
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    await zurueck()
  }
})

test('Kasse: späte Antwort der abgebrochenen Zahlung stört die nächste nicht', async ({ page, request }) => {
  await warmup(request)
  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const zurueck = await zvtStub(request, auth, kasseId)
  const artikel = await neuerArtikel(request, auth, 'Zweiter-Versuch-Tee', 310)

  try {
    await kasseAnmelden(page, request, login)
    await page.goto('/kasse')
    await inDenWarenkorb(page, artikel.bezeichnung)
    const terminal = await terminalHalten(page)
    const belege   = belegeMitschreiben(page)
    const dialog   = page.getByRole('dialog')
    const karte    = page.getByRole('button', { name: /^Karte \(/ })
    const weiter   = page.getByRole('button', { name: 'Weiter →' })

    // 1. Zahlung: Das Terminal scheint zu hängen, der Kassier bricht ab — eine
    //    Abfrage steckt noch im WLAN
    const job1 = await starteKartenzahlung(page, karte, weiter)
    await expect(dialog.getByText('Zahlung am Terminal')).toBeVisible()
    await terminal.halteNaechste()
    expect((await brichAb(page, dialog.getByRole('button', { name: 'Abbrechen' }), job1)).status).toBe('abgebrochen')
    await expect(page.getByText(ABGEBROCHEN)).toBeVisible()
    await expect(dialog).toHaveCount(0)

    // 2. Zahlung gleich hinterher — erst jetzt kommt die hängende Antwort der ersten an
    const job2 = await starteKartenzahlung(page, karte, weiter)
    expect(job2).not.toBe(job1)
    await terminal.loslassen()   // echte Antwort: Job 1 „abgebrochen"

    // Der Dialog gehört der zweiten Zahlung: weiter „am Terminal", keine Fehlermeldung
    await expect(dialog.getByText('Zahlung am Terminal')).toBeVisible()
    await page.waitForTimeout(1_000)
    await expect(dialog.getByText('Zahlung am Terminal')).toBeVisible()
    await expect(dialog.getByText('Abgebrochen', { exact: true })).toHaveCount(0)

    // Der Gast zahlt die zweite Zahlung → genau ein Beleg, regulär (kein Hinweis)
    await terminal.freigeben()
    await expect.poll(() => belege.length, { timeout: 15_000 }).toBe(1)
    expect(belege[0]!.summeKarteCent).toBe(310)
    await page.waitForTimeout(1_000)
    expect(belege).toHaveLength(1)
    await expect(page.getByText(ZU_SPAET)).toHaveCount(0)
  } finally {
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    await zurueck()
  }
})

test('Kasse: zweite Zahlung noch im Start abgebrochen — der Terminal-Job wird abgebrochen, kein Beleg', async ({ page, request }) => {
  await warmup(request)
  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const zurueck = await zvtStub(request, auth, kasseId)
  const artikel = await neuerArtikel(request, auth, 'Start-Kakao', 280)

  try {
    await kasseAnmelden(page, request, login)
    await page.goto('/kasse')
    const belege = belegeMitschreiben(page)
    const dialog = page.getByRole('dialog')
    const karte  = page.getByRole('button', { name: /^Karte \(/ })
    const weiter = page.getByRole('button', { name: 'Weiter →' })

    // 1. Zahlung läuft regulär durch — der Dialog hat danach eine erledigte Zahlung hinter sich
    await inDenWarenkorb(page, artikel.bezeichnung)
    await starteKartenzahlung(page, karte, weiter)
    await expect.poll(() => belege.length, { timeout: 15_000 }).toBe(1)
    // Digital-Modus (Stand nach onboarding): Beleg-Dialog schließen
    if (await dialog.count() > 0) await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // 2. Zahlung: Der Start hängt im WLAN, der Kassier bricht per ✕ ab
    await inDenWarenkorb(page, artikel.bezeichnung)
    const start = await startHalten(page)
    await karte.click()
    await weiter.click()
    await expect.poll(() => start.anzahl()).toBe(1)
    await dialog.getByRole('button', { name: 'Schließen' }).click()

    // Jetzt kommt die jobId doch noch an — der Dialog holt den Abbruch nach
    const abbruch = naechsterAbbruch(page)
    const job2    = await start.loslassen()
    expect(await (await abbruch).json()).toMatchObject({ id: job2, status: 'abgebrochen' })
    await expect(page.getByText(ABGEBROCHEN)).toBeVisible()

    // Ohne Abbruch hätte der Stub nach ≈3,5 s „erfolg" gemeldet: bezahlt, ohne Beleg
    await page.waitForTimeout(4_000)
    await warteAufJob(request, auth, job2, 'abgebrochen')
    expect(belege).toHaveLength(1)
  } finally {
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    await zurueck()
  }
})

test('Tisch: Gast hat schon bezahlt — der Abbruch rechnet den Tisch trotzdem ab', async ({ page, request }) => {
  await warmup(request)
  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const zurueck = await zvtStub(request, auth, kasseId)
  const artikel = await neuerArtikel(request, auth, 'Tisch-Spritzer', 350)
  const tab     = await neuerTisch(request, auth, kasseId, artikel, 350)

  try {
    await kasseAnmelden(page, request, login)
    await page.goto(`/tische/${tab.id}`)
    await expect(page.getByRole('heading', { name: `Tisch ${tab.tischNummer}` })).toBeVisible()
    await terminalHalten(page)
    const dialog = page.getByRole('dialog')

    const jobId = await starteKartenzahlung(page, page.getByRole('button', { name: /^Karte \(/ }), page.getByRole('button', { name: 'Weiter →' }))
    await expect(dialog.getByText('Zahlung am Terminal')).toBeVisible()
    await warteAufJob(request, auth, jobId, 'erfolg')
    const bezahlt = bezahlAntwort(page, tab.id)
    expect((await brichAb(page, dialog.getByRole('button', { name: 'Abbrechen' }), jobId)).status).toBe('erfolg')

    const antwort = await bezahlt
    expect(antwort.ok()).toBe(true)
    expect(antwort.request().postDataJSON()).toMatchObject({ zahlung: { barCent: 0, karteCent: 350 } })
    // Druck-Modus: weiter in die Tischübersicht; Digital-Modus: Bon-Dialog am Tisch —
    // der Hinweis steht in beiden Fällen da
    await expect(page.getByText(ZU_SPAET)).toBeVisible()
    await expect(page.getByText(ABGEBROCHEN)).toHaveCount(0)
  } finally {
    // Nach dem Abrechnen gibt es nichts mehr zu verwerfen (409) — sonst schließt es den Tisch
    await request.post(`/api/tisch-tabs/${tab.id}/verwerfen`, { headers: auth, data: {} })
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    await zurueck()
  }
})

test.describe('Kellner-App', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('Gast hat schon bezahlt — der Abbruch rechnet den Tisch trotzdem ab', async ({ page, request }) => {
    await warmup(request)
    await warmup(page.request, `${KELLNER_URL}/api/health`)
    const login   = await adminLogin(request)
    const auth    = { Authorization: `Bearer ${login.token}` }
    const kasseId = login.kassen[0]!.id
    const zurueck = await zvtStub(request, auth, kasseId)
    const artikel = await neuerArtikel(request, auth, 'Handy-Radler', 350)
    const tab     = await neuerTisch(request, auth, kasseId, artikel, 350)

    try {
      await kellnerAnmelden(page, login)
      await page.goto(`${KELLNER_URL}/tab/${tab.id}`)
      await expect(page.getByRole('heading', { name: tab.tischNummer })).toBeVisible({ timeout: 15_000 })
      await terminalHalten(page)

      const jobId = await starteKartenzahlung(page, page.getByRole('button', { name: /💳 Karte/ }), page.getByRole('button', { name: 'Weiter → Terminal' }))
      await expect(page.getByText('Zahlung am Terminal')).toBeVisible()
      await warteAufJob(request, auth, jobId, 'erfolg')
      const bezahlt = bezahlAntwort(page, tab.id)
      expect((await brichAb(page, page.getByRole('button', { name: 'Abbrechen', exact: true }), jobId)).status).toBe('erfolg')

      const antwort = await bezahlt
      expect(antwort.ok()).toBe(true)
      expect(antwort.request().postDataJSON()).toMatchObject({ zahlung: { barCent: 0, karteCent: 350 } })
      await expect(page.getByText('Bezahlt', { exact: true })).toBeVisible()
      await expect(page.getByText(ZU_SPAET)).toBeVisible()
      await expect(page.getByText(ABGEBROCHEN)).toHaveCount(0)
    } finally {
      await request.post(`/api/tisch-tabs/${tab.id}/verwerfen`, { headers: auth, data: {} })
      await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
      await zurueck()
    }
  })

  test('„Abbrechen", solange die Zahlung noch startet — der Terminal-Job wird abgebrochen', async ({ page, request }) => {
    await warmup(request)
    await warmup(page.request, `${KELLNER_URL}/api/health`)
    const login   = await adminLogin(request)
    const auth    = { Authorization: `Bearer ${login.token}` }
    const kasseId = login.kassen[0]!.id
    const zurueck = await zvtStub(request, auth, kasseId)
    const artikel = await neuerArtikel(request, auth, 'Handy-Almdudler', 330)
    const tab     = await neuerTisch(request, auth, kasseId, artikel, 330)

    try {
      await kellnerAnmelden(page, login)
      await page.goto(`${KELLNER_URL}/tab/${tab.id}`)
      await expect(page.getByRole('heading', { name: tab.tischNummer })).toBeVisible({ timeout: 15_000 })
      let bezahlVersuche = 0
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().endsWith(`/api/tisch-tabs/${tab.id}/bezahlen`)) bezahlVersuche++
      })

      // Der Start hängt im WLAN, der Kellner tippt „Abbrechen"
      const start = await startHalten(page)
      await page.getByRole('button', { name: /💳 Karte/ }).click()
      await page.getByRole('button', { name: 'Weiter → Terminal' }).click()
      await expect.poll(() => start.anzahl()).toBe(1)
      await expect(page.getByText('Starte Zahlung…')).toBeVisible()
      await page.getByRole('button', { name: 'Abbrechen', exact: true }).click()

      // Jetzt kommt die jobId doch noch an — die App holt den Abbruch nach
      const abbruch = naechsterAbbruch(page)
      const jobId   = await start.loslassen()
      expect(await (await abbruch).json()).toMatchObject({ id: jobId, status: 'abgebrochen' })
      await expect(page.getByText(ABGEBROCHEN)).toBeVisible()

      // Ohne Abbruch hätte der Stub nach ≈3,5 s „erfolg" gemeldet: bezahlt, ohne Beleg
      await page.waitForTimeout(4_000)
      await warteAufJob(request, auth, jobId, 'abgebrochen')
      expect(bezahlVersuche).toBe(0)
    } finally {
      await request.post(`/api/tisch-tabs/${tab.id}/verwerfen`, { headers: auth, data: {} })
      await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
      await zurueck()
    }
  })
})

})
