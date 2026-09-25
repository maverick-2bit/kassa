import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

/**
 * Kasse und offener Tisch füllen ab lg genau den Bildschirm: „Bar", „Karte",
 * „Leeren" und „Bonieren" (am Tisch „Parken" und die Tisch-Aktionen) liegen
 * ohne Scrollen im Bild und sind bedienbar — für den Admin mit voll
 * ausgebautem Menü (die Kopfleiste bricht bis 1366 px zweizeilig um) wie für
 * den Kassier mit nur `kasse`. Scrollen schiebt nichts unter die Kopfleiste,
 * und viele Warengruppen mit langen Namen machen die Seite nicht breiter als
 * den Bildschirm.
 *
 * Früher rechneten die Spalten fest mit einer einzeiligen Kopfleiste (sticky
 * top-20, max-h 100vh−6rem): Bei 1024×768 lagen „Leeren"/„Bonieren" auf
 * y 782–824, beim Scrollen glitten die Spalten unter die Kopfleiste. Und
 * `grid-cols-[1fr_400px]` ließ die Warengruppen-Leiste die Mindestbreite der
 * Artikel-Spalte bestimmen — die Seite wurde über 3600 px breit, der Warenkorb
 * lag rechts außerhalb des Bildes.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({
  // page.route sieht keine Anfragen, die ein Service Worker kontrolliert
  serviceWorkers: 'block',
})

const QUERFORMATE = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]

const KASSE_KNOEPFE = [/^Bar \(/, /^Karte \(/, /^Leeren$/, /^Bonieren$/]
const TISCH_KNOEPFE = [/^Bar \(/, /^Karte \(/, /^Parken$/, /Tisch wechseln$/, /Rechnung teilen$/, /Verwerfen$/, /Artikel-Rabatte$/]

type Login = {
  token:   string
  user:    { id: string }
  mandant: { id: string } & Record<string, unknown>
  kassen:  { id: string }[]
}

// Einmal je Datei anmelden: /api/auth/login ist je IP begrenzt, und die ganze
// Suite teilt sich 127.0.0.1 (Muster ensureAuth in onboarding).
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
        firmenname: 'E2E Onboarding GmbH',
        uid:        'ATU87654331',
        kassenId:   'E2E-FALZ-001',
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

/** Eigener Browser-Kontext mit injizierter Anmeldung (kein Login-Formular) */
async function angemeldeteSeite(browser: Browser, login: Login, mandant = login.mandant): Promise<Page> {
  const kontext = await browser.newContext({
    baseURL:        test.info().project.use.baseURL,
    serviceWorkers: 'block',
  })
  const page = await kontext.newPage()
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:     login.token,
    authJson:  JSON.stringify({ user: login.user, mandant, kassen: login.kassen }),
    mandantId: login.mandant.id,
    kasseId:   login.kassen[0]!.id,
  })
  return page
}

/**
 * Je Knopf: liegt er ganz im Bild (unter der Kopfleiste, über der Unterkante,
 * nicht seitlich hinaus) und ist er an seinem Mittelpunkt zuoberst? Zurück
 * kommen nur die Knöpfe, bei denen etwas nicht stimmt — leer = alles gut.
 */
async function problemKnoepfe(page: Page, knoepfe: RegExp[]) {
  return page.evaluate((quellen) => {
    const kopf  = document.querySelector('header')!.getBoundingClientRect()
    const text  = (el: Element) => ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim()
    const probleme: string[] = []
    for (const quelle of quellen) {
      const muster = new RegExp(quelle)
      const knopf  = [...document.querySelectorAll('button')].find(b => muster.test(text(b)))
      if (!knopf) { probleme.push(`${quelle}: fehlt`); continue }
      const r = knopf.getBoundingClientRect()
      const imBild = r.top >= kopf.bottom - 1 && r.bottom <= window.innerHeight + 1
        && r.left >= -1 && r.right <= window.innerWidth + 1
      const oben = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!imBild || !oben || !knopf.contains(oben)) {
        probleme.push(`${text(knopf)}: y ${Math.round(r.top)}–${Math.round(r.bottom)}, x ${Math.round(r.left)}–${Math.round(r.right)}` +
          ` (Bild ${window.innerWidth}×${window.innerHeight}, Kopfleiste bis ${Math.round(kopf.bottom)})` +
          `${imBild ? '' : ' außerhalb'}${oben && knopf.contains(oben) ? '' : ' verdeckt'}`)
      }
    }
    return probleme
  }, knoepfe.map(k => k.source))
}

/** Seite und <main> nicht breiter als der Bildschirm, keine Spalte unter der Kopfleiste */
async function rahmen(page: Page) {
  return page.evaluate(() => {
    const kopf = document.querySelector('header')!.getBoundingClientRect()
    const main = document.querySelector('main')!
    return {
      ueberbreiteSeite:   document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ueberbreiteMain:    main.scrollWidth > main.clientWidth,
      seiteGescrollt:     window.scrollY !== 0,
      spalteUnterKopf:    [...document.querySelectorAll('main section')]
        .some(s => s.getBoundingClientRect().top < kopf.bottom - 1),
    }
  })
}

const OHNE_PROBLEM = { ueberbreiteSeite: false, ueberbreiteMain: false, seiteGescrollt: false, spalteUnterKopf: false }

/** Wie ein Mensch: Mausrad über dem Artikel-Raster und über der rechten Spalte */
async function scrolleMitMausrad(page: Page) {
  for (const titel of [/^Artikel/, /^(Warenkorb|Laufende Bestellung)$/]) {
    const box = await page.getByRole('heading', { name: titel }).first().boundingBox()
    if (!box) continue
    await page.mouse.move(box.x + 60, Math.min(page.viewportSize()!.height - 10, box.y + 200))
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 500)
  }
  await page.waitForTimeout(150)
}

/** Sichtbare Höhe der Warenkorb-Positionsliste (erster scrollbarer Vorfahr) */
async function sichtbareKorbHoehe(page: Page) {
  return page.getByTitle('Menge eingeben').first().evaluate((el) => {
    let e: HTMLElement | null = el.parentElement
    while (e && !/(auto|scroll)/.test(getComputedStyle(e).overflowY)) e = e.parentElement
    return e?.clientHeight ?? 0
  })
}

test.describe('Kasse und Tisch füllen ab lg den Bildschirm', () => {

test('Bar/Karte/Leeren/Bonieren und die Tisch-Knöpfe liegen ohne Scrollen im Bild — Admin mit vollem Menü und Kassier', async ({ browser, request }) => {
  test.setTimeout(240_000)

  // Warmup: erste Verbindung Preview-Proxy → Backend absichern (Muster onboarding)
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }
  const kasseId    = login.kassen[0]!.id

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const praefix     = `Falz${Date.now() % 1_000_000}`
  const kategorien: string[] = []
  const artikel: { id: string; bezeichnung: string }[] = []
  let tabId: string | null      = null
  let kassierId: string | null  = null

  try {
    // 16 Warengruppen mit langen Namen: die Warengruppen-Leiste ist viel breiter als die Spalte
    for (let i = 1; i <= 16; i++) {
      const res = await request.post('/api/kategorien', {
        headers: authHeader,
        data: { name: `${praefix} Warengruppe mit langem Namen ${i}`, farbe: i % 2 ? 'blau' : 'rot', reihenfolge: 900 + i },
      })
      expect(res.ok(), await res.text()).toBe(true)
      kategorien.push((await res.json() as { id: string }).id)
    }
    for (let i = 1; i <= 12; i++) {
      const res = await request.post('/api/artikel', {
        headers: authHeader,
        data: { bezeichnung: `${praefix} Artikel ${String(i).padStart(2, '0')}`, preisBruttoCent: 100 * i + 50, mwstSatz: 'normal', kategorieId: kategorien[i - 1] },
      })
      expect(res.ok(), await res.text()).toBe(true)
      artikel.push(await res.json() as { id: string; bezeichnung: string })
    }

    // Kassier: nur `kasse` — einzeilige Kopfleiste, keine Tische-Leiste
    const kassierEmail = `kassier-${praefix.toLowerCase()}@test.at`
    const anlage = await request.post('/api/users', {
      headers: authHeader,
      data: { name: 'E2E Kassier', email: kassierEmail, passwort: 'kassier-passwort-123', rolle: 'kellner', berechtigungen: ['kasse'], kassenIds: [kasseId] },
    })
    expect(anlage.ok(), await anlage.text()).toBe(true)
    kassierId = (await anlage.json() as { id: string }).id
    const kassierAnmeldung = await request.post('/api/auth/login', { data: { email: kassierEmail, passwort: 'kassier-passwort-123' } })
    expect(kassierAnmeldung.ok()).toBe(true)
    const kassier = await kassierAnmeldung.json() as Login

    // Tisch mit laufender Bestellung
    const tab = await request.post('/api/tisch-tabs', {
      headers: authHeader, data: { kasseId, tischNummer: `F${Date.now() % 10_000}`, kellner: 'E2E Service' },
    })
    expect(tab.ok(), await tab.text()).toBe(true)
    tabId = (await tab.json() as { id: string }).id
    const positionen = await request.put(`/api/tisch-tabs/${tabId}/positionen`, {
      headers: authHeader,
      data: { positionen: artikel.slice(0, 3).map(a => ({ artikelId: a.id, bezeichnung: a.bezeichnung, preisBruttoCent: 150, menge: 1 })) },
    })
    expect(positionen.ok(), await positionen.text()).toBe(true)

    async function warenkorbMit(page: Page, anzahl: number) {
      await page.goto('/kasse')
      const suche = page.getByPlaceholder(/Artikel suchen/)
      await suche.fill(praefix)
      for (const a of artikel.slice(0, anzahl)) {
        await page.getByRole('button', { name: a.bezeichnung }).first().click()
      }
      await suche.fill('')
      await expect(page.getByTitle('Menge eingeben')).toHaveCount(anzahl)
    }

    // Admin mit voll ausgebautem Menü: alle Module, die Menüpunkte bringen, sind
    // an (nur in der Anmeldung im Browser — die Kopfleiste liest sie dort)
    const vollesMenue = {
      ...login.mandant,
      modulGastroAktiv: true, modulAngeboteAktiv: true, modulMergeportAktiv: true,
      modulReservierungenAktiv: true, modulZeiterfassungAktiv: true,
      modulSbTerminalAktiv: true, modulTicketsAktiv: true,
    }
    const admin = await angemeldeteSeite(browser, login, vollesMenue)
    const kassa = await angemeldeteSeite(browser, kassier)

    for (const [wer, page] of [['Admin', admin], ['Kassier', kassa]] as const) {
      for (const format of QUERFORMATE) {
        const szene = `${wer} ${format.width}×${format.height}`
        await page.setViewportSize(format)
        await warenkorbMit(page, 3)
        expect(await problemKnoepfe(page, KASSE_KNOEPFE), szene).toEqual([])
        expect(await rahmen(page), szene).toEqual(OHNE_PROBLEM)
        // Die Positionsliste bekommt, was übrig bleibt — mindestens gut zwei Zeilen
        expect(await sichtbareKorbHoehe(page), szene).toBeGreaterThanOrEqual(90)

        // Mausrad über Raster und Warenkorb: nichts wandert unter die Kopfleiste
        await scrolleMitMausrad(page)
        expect(await problemKnoepfe(page, KASSE_KNOEPFE), `${szene} nach dem Scrollen`).toEqual([])
        expect(await rahmen(page), `${szene} nach dem Scrollen`).toEqual(OHNE_PROBLEM)
      }
    }

    // Voller Warenkorb (12 Positionen): die Liste scrollt in sich, die Knöpfe bleiben
    await admin.setViewportSize({ width: 1024, height: 768 })
    await warenkorbMit(admin, 12)
    expect(await problemKnoepfe(admin, KASSE_KNOEPFE), 'Admin 1024×768, 12 Positionen').toEqual([])
    expect(await rahmen(admin), 'Admin 1024×768, 12 Positionen').toEqual(OHNE_PROBLEM)

    // Hinweis über der Kopfleiste (SEE ausgefallen) — die Seite rechnet ihn mit
    await admin.route('**/api/belege/see-status*', route => route.fulfill({ json: {
      ausgefallen: true, seit: new Date(Date.now() - 75 * 60_000).toISOString(), dauerMinuten: 75, fonMeldungNoetig: false,
    } }))
    await warenkorbMit(admin, 3)
    await expect(admin.getByTestId('see-banner')).toBeVisible()
    expect(await problemKnoepfe(admin, KASSE_KNOEPFE), 'Admin 1024×768 mit SEE-Hinweis').toEqual([])
    expect(await rahmen(admin), 'Admin 1024×768 mit SEE-Hinweis').toEqual(OHNE_PROBLEM)

    // Knapper Bildschirm: reicht die Höhe nicht, scrollt die rechte Spalte in
    // sich und der Zahlteil klebt unten — die Knöpfe bleiben trotzdem im Bild
    await admin.setViewportSize({ width: 1024, height: 640 })
    await warenkorbMit(admin, 3)
    expect(await problemKnoepfe(admin, KASSE_KNOEPFE), 'Admin 1024×640 mit SEE-Hinweis').toEqual([])
    await admin.unroute('**/api/belege/see-status*')

    // Offener Tisch: laufende Bestellung + neue Positionen im Warenkorb
    for (const format of QUERFORMATE) {
      const szene = `Tisch, Admin ${format.width}×${format.height}`
      await admin.setViewportSize(format)
      await admin.goto(`/tische/${tabId}`)
      await expect(admin.getByText('Laufende Bestellung')).toBeVisible()
      const suche = admin.getByPlaceholder(/Artikel suchen/)
      await suche.fill(praefix)
      for (const a of artikel.slice(3, 5)) await admin.getByRole('button', { name: a.bezeichnung }).first().click()
      await suche.fill('')
      await expect(admin.getByRole('button', { name: 'Parken' })).toBeVisible()
      expect(await problemKnoepfe(admin, TISCH_KNOEPFE), szene).toEqual([])
      expect(await rahmen(admin), szene).toEqual(OHNE_PROBLEM)
      await scrolleMitMausrad(admin)
      expect(await problemKnoepfe(admin, TISCH_KNOEPFE), `${szene} nach dem Scrollen`).toEqual([])
      expect(await rahmen(admin), `${szene} nach dem Scrollen`).toEqual(OHNE_PROBLEM)
    }
  } finally {
    // Aufräumen — spätere Specs teilen sich die Instanz
    if (tabId) await request.post(`/api/tisch-tabs/${tabId}/verwerfen`, { headers: authHeader, data: {} })
    if (kassierId) await request.delete(`/api/users/${kassierId}`, { headers: authHeader })
    for (const a of artikel) await request.delete(`/api/artikel/${a.id}`, { headers: authHeader })
    for (const k of kategorien) await request.delete(`/api/kategorien/${k}`, { headers: authHeader })
  }
})

})
