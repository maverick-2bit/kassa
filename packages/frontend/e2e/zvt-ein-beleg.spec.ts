import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Kartenzahlung über das ZVT-Terminal bei langsamer Leitung: Der Dialog fragt
 * den Terminal-Job alle 500 ms ab. Antwortete das Backend langsamer (WLAN-Tablet,
 * ausgelastete Kasse), lief die nächste Abfrage los, bevor die vorige zurück war —
 * beide sahen „erfolg", onErfolg lief doppelt und es entstanden ZWEI signierte
 * Belege für eine Zahlung. Jetzt läuft nie mehr als eine Abfrage gleichzeitig.
 *
 * Echte Uhr, echter Stub-Job (≈3,5 s bis „erfolg"); nur die Antwort auf die
 * Job-Abfrage kommt per page.route 700 ms verzögert an.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({
  viewport: { width: 1280, height: 800 },
  // page.route sieht keine Anfragen, die ein Service Worker kontrolliert
  serviceWorkers: 'block',
})

type Login = { token: string; mandant: { id: string }; kassen: { id: string }[] }

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Kartenzahlung GmbH',
        uid:        'ATU87654332',
        kassenId:   'E2E-ZVT-001',
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

async function anmelden(page: Page, request: APIRequestContext, login: Login) {
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

test('Kartenzahlung bei langsamer Job-Abfrage: genau ein Beleg', async ({ page, request }) => {
  // Warmup: erste Verbindung Preview-Proxy → Backend absichern (Muster onboarding)
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const zvt     = await (await request.get(`/api/kassen/${kasseId}/zvt`, { headers: auth })).json() as { zvtIp: string | null; zvtAktiv: boolean }
  expect((await request.patch(`/api/kassen/${kasseId}/zvt`, {
    headers: auth, data: { zvtIp: 'stub', zvtAktiv: true },
  })).ok()).toBe(true)
  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const artikel = await (await request.post('/api/artikel', {
    headers: auth,
    data: { bezeichnung: `Langsam-Kaffee ${Date.now() % 100000}`, preisBruttoCent: 420, mwstSatz: 'normal' },
  })).json() as { id: string; bezeichnung: string }

  try {
    await anmelden(page, request, login)
    await page.goto('/kasse')
    const suche = page.getByPlaceholder(/Artikel suchen/)
    await suche.fill(artikel.bezeichnung)
    await page.getByRole('button', { name: artikel.bezeichnung }).first().click()
    await suche.fill('')
    await expect(page.getByTitle('Menge eingeben')).toHaveCount(1)

    // Langsame Leitung: das Backend beantwortet die Job-Abfrage sofort, beim
    // Browser kommt die Antwort erst nach 700 ms an (> 500-ms-Abfragetakt)
    let offen = 0
    let hoechstensGleichzeitig = 0
    await page.route('**/api/zvt/zahlung/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      offen++
      hoechstensGleichzeitig = Math.max(hoechstensGleichzeitig, offen)
      try {
        const echt = await route.fetch()
        await new Promise(r => setTimeout(r, 700))
        await route.fulfill({ response: echt })
      } finally {
        offen--
      }
    })
    const belege: number[] = []
    page.on('response', async (r) => {
      if (r.request().method() === 'POST' && r.url().endsWith('/api/belege/barzahlung')) {
        belege.push(((await r.json()) as { belegNummer: number }).belegNummer)
      }
    })

    await page.getByRole('button', { name: /^Karte \(/ }).click()
    await page.getByRole('button', { name: 'Weiter →' }).click()
    await expect(page.getByText('Zahlung am Terminal')).toBeVisible()

    // Stub-Job ≈3,5 s → erfolg → Beleg (Leiste im Druck-, Dialog im Digital-Modus)
    await expect.poll(() => belege.length, { timeout: 20_000 }).toBeGreaterThan(0)
    await expect(page.getByText(`Beleg #${belege[0]} erstellt`)).toBeVisible()
    // Abfragen, die noch unterwegs waren, hätten jetzt einen zweiten Beleg ausgelöst
    await expect.poll(() => offen, { timeout: 5_000 }).toBe(0)
    await page.waitForTimeout(1_500)
    expect(belege).toHaveLength(1)
    expect(hoechstensGleichzeitig).toBe(1)
  } finally {
    await request.patch(`/api/kassen/${kasseId}/zvt`, { headers: auth, data: { zvtIp: zvt.zvtIp, zvtAktiv: zvt.zvtAktiv } })
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
  }
})
