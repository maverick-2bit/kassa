import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

/**
 * Benachrichtigungs-Karten der Kasse (SB-Bestellung, Gastbestellung,
 * Zahlungsanforderung, KDS-Nachricht, Bonier-Toast) liegen UNTER jedem Dialog.
 * Früher standen sie mit z-50 hinter <main> im DOM und damit über den Dialogen
 * (ebenfalls z-50): Während „Zahlung am Terminal" führte „Zu den Bestellungen"
 * von der Kasse weg — das Job-Polling endete, der Gast zahlte am Terminal, ein
 * Beleg entstand nie. Optionen-Dialog und „Neuer Kunde" steckten zudem im
 * Stapelkontext des mitlaufenden (sticky) Kassen-Abschnitts — dort lag sogar
 * die Kopfleiste darüber. Außerdem verdeckte die Gast-Karte die SB-Karte (zwei
 * Stapel an derselben Stelle).
 *
 * Kiosk-Format 1280×800 gegen das gebaute Bundle. Jede Karte entsteht über eine
 * echte Backend-Aktion und kommt per SSE an; das Kartenterminal ist der ZVT-Stub.
 * page.clock hält die App-Uhr an, damit der Bonier-Toast (6 s) nicht wegläuft.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({
  viewport: { width: 1280, height: 800 },
  // page.route sieht keine Anfragen, die ein Service Worker kontrolliert
  serviceWorkers: 'block',
})

type Login = { token: string; mandant: { id: string }; kassen: { id: string }[] }

// Einmal je Datei anmelden: /api/auth/login ist je IP auf 10/min begrenzt,
// und die ganze Suite teilt sich 127.0.0.1 (Muster ensureAuth in onboarding).
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
        firmenname: 'E2E Hinweiskarten GmbH',
        uid:        'ATU87654331',
        kassenId:   'E2E-KARTEN-001',
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

/** Anmeldung per localStorage — Stammdaten frisch aus /api/auth/me (Module eben erst aktiviert) */
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

/**
 * Alles, was die Karten braucht: SB-Terminal-Modul, ZVT-Stub, Gast-Modus „tab",
 * Self-Checkout. Liefert eine Funktion, die den vorherigen Stand zurückstellt —
 * spätere Specs teilen sich die Instanz.
 */
async function richteKartenquellenEin(request: APIRequestContext, auth: Record<string, string>, kasseId: string) {
  const module = await (await request.get('/api/mandanten/module', { headers: auth })).json() as { modulSbTerminalAktiv: boolean }
  const zvt    = await (await request.get(`/api/kassen/${kasseId}/zvt`, { headers: auth })).json() as { zvtIp: string | null; zvtAktiv: boolean }
  const gast   = await (await request.get(`/api/kassen/${kasseId}/drucker`, { headers: auth })).json() as { gastModus: string }
  const sc     = await (await request.get(`/api/kassen/${kasseId}/self-checkout`, { headers: auth })).json() as { selfCheckoutAktiv: boolean }

  expect((await request.patch('/api/mandanten/module', { headers: auth, data: { modulSbTerminalAktiv: true } })).ok()).toBe(true)
  expect((await request.patch(`/api/kassen/${kasseId}/zvt`, { headers: auth, data: { zvtIp: 'stub', zvtAktiv: true } })).ok()).toBe(true)
  expect((await request.patch(`/api/kassen/${kasseId}/drucker`, { headers: auth, data: { gastModus: 'tab' } })).ok()).toBe(true)
  expect((await request.patch(`/api/kassen/${kasseId}/self-checkout`, { headers: auth, data: { aktiv: true } })).ok()).toBe(true)

  return async () => {
    await request.patch('/api/mandanten/module', { headers: auth, data: { modulSbTerminalAktiv: module.modulSbTerminalAktiv } })
    await request.patch(`/api/kassen/${kasseId}/zvt`, { headers: auth, data: { zvtIp: zvt.zvtIp, zvtAktiv: zvt.zvtAktiv } })
    await request.patch(`/api/kassen/${kasseId}/drucker`, { headers: auth, data: { gastModus: gast.gastModus } })
    await request.patch(`/api/kassen/${kasseId}/self-checkout`, { headers: auth, data: { aktiv: sc.selfCheckoutAktiv } })
  }
}

/** Offene Tische dieser Kasse mit den gegebenen Nummern verwerfen (Gast- und Self-Checkout-Tische) */
async function verwerfeTische(request: APIRequestContext, auth: Record<string, string>, kasseId: string, nummern: string[]) {
  const tabs = await (await request.get(`/api/tisch-tabs?kasseId=${kasseId}`, { headers: auth })).json() as { id: string; tischNummer: string }[]
  for (const t of tabs.filter(t => nummern.includes(t.tischNummer))) {
    await request.post(`/api/tisch-tabs/${t.id}/verwerfen`, { headers: auth, data: {} })
  }
}

/** Liegt das Element an seinem Mittelpunkt zuoberst (also bedienbar)? */
async function zuoberst(el: Locator) {
  // Mit vielen Warengruppen wird die Kasse breiter als 1280 px — Klicks rechts
  // scrollen sie seitwärts, die Kopfleiste steht dann links außerhalb des Bildes
  await el.scrollIntoViewIfNeeded()
  return el.evaluate((e) => {
    const r = e.getBoundingClientRect()
    const oben = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!oben && e.contains(oben)
  })
}

/** Deckt an seinem Mittelpunkt ein Dialog das Element ab (Hintergrund oder Dialogfenster)? */
async function unterDialog(el: Locator) {
  await el.scrollIntoViewIfNeeded()
  return el.evaluate((e) => {
    const r = e.getBoundingClientRect()
    const oben = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!oben?.closest('[role="dialog"]')
  })
}

/** Tipp genau auf den Mittelpunkt des Elements — trifft, was dort zuoberst liegt */
async function tippeAuf(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('Kassa: Benachrichtigungs-Karten liegen unter Dialogen', () => {

test('Kartenzahlung läuft: neue Karten liegen unter dem Dialog, Tipps darauf brechen nichts ab — danach führen sie weiter', async ({ page, request }) => {
  // Warmup: erste Verbindung Preview-Proxy → Backend absichern (Muster onboarding)
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const nr         = `${Date.now() % 100000}`
  const gastTisch  = `G${nr}`
  const zahlTisch  = `Z${nr}`
  const kdsText    = `Lachs ist aus (${nr})`

  const zurueck = await richteKartenquellenEin(request, auth, kasseId)
  const artikel = await (await request.post('/api/artikel', {
    headers: auth,
    data: { bezeichnung: `Karten-Kaffee ${nr}`, preisBruttoCent: 350, mwstSatz: 'normal', terminalSichtbar: true },
  })).json() as { id: string; bezeichnung: string }

  try {
    // Tisch, an dem der Gast gleich per Self-Checkout die Rechnung anfordert
    const tab = await (await request.post('/api/tisch-tabs', {
      headers: auth, data: { kasseId, tischNummer: zahlTisch, kellner: 'E2E Service' },
    })).json() as { id: string }
    expect((await request.put(`/api/tisch-tabs/${tab.id}/positionen`, {
      headers: auth,
      data: { positionen: [{ artikelId: artikel.id, bezeichnung: artikel.bezeichnung, preisBruttoCent: 350, menge: 1 }] },
    })).ok()).toBe(true)

    await anmelden(page, request, login)
    await page.clock.install()
    await page.goto('/kasse')

    const suche = page.getByPlaceholder(/Artikel suchen/)
    await suche.fill(artikel.bezeichnung)
    await page.getByRole('button', { name: artikel.bezeichnung }).first().click()
    await suche.fill('')
    await expect(page.getByTitle('Menge eingeben')).toHaveCount(1)

    // Terminal wartet auf die PIN: der Job-GET wird gehalten (der Stub-Job im
    // Backend läuft trotzdem durch und steht nach ~3,5 s auf „erfolg")
    await page.route('**/api/zvt/zahlung/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const jobId = new URL(route.request().url()).pathname.split('/').pop()!
      return route.fulfill({ json: {
        id: jobId, status: 'autorisiere', betragCent: 350,
        meldung: 'Karte eingesteckt — PIN-Eingabe', gestartetAm: new Date().toISOString(),
      } })
    })
    let abbrueche = 0
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/zvt\/zahlung\/[^/]+\/abbrechen$/.test(r.url())) abbrueche++
    })

    await page.getByRole('button', { name: /^Karte \(/ }).click()
    await page.getByRole('button', { name: 'Weiter →' }).click()
    const amTerminal = page.getByText('Zahlung am Terminal')
    await expect(amTerminal).toBeVisible()
    // App-Uhr anhalten: der Bonier-Toast verschwindet sonst nach 6 s
    await page.clock.pauseAt(new Date(Date.now() + 1_000))

    // Während der Zahlung kommt alles an, was die Kasse melden kann
    expect((await request.post('/api/kds/nachricht', {
      headers: auth, data: { text: kdsText, station: 'kueche', kasseIds: [] },
    })).ok()).toBe(true)
    expect((await request.post('/api/gast/bestellung', {
      data: { kasseId, tischNummer: gastTisch, positionen: [{ artikelId: artikel.id, menge: 2 }] },
    })).status()).toBe(201)
    expect((await request.post('/api/selfcheckout/zahlung-anfordern', {
      data: { kasseId, tisch: zahlTisch },
    })).ok()).toBe(true)
    const sb = await (await request.post('/api/terminal/bestellung', {
      data: { kasseId, positionen: [{ artikelId: artikel.id, menge: 1 }] },
    })).json() as { id: string }
    // Der Status-Abruf finalisiert die bezahlte SB-Bestellung (Beleg, Bon, SSE)
    await expect.poll(
      async () => ((await (await request.get(`/api/terminal/bestellung/${sb.id}`)).json()) as { status: string }).status,
      { timeout: 20_000 },
    ).toBe('offen')

    const karten: Record<string, Locator> = {
      'SB: Zu den Bestellungen':  page.getByRole('link', { name: 'Zu den Bestellungen' }),
      'Gast: ✓ Gesehen':          page.getByRole('button', { name: '✓ Gesehen' }),
      'Zahlung: ✓ Übernommen':    page.getByRole('button', { name: '✓ Übernommen' }),
      'KDS: ✓ Verstanden':        page.getByRole('button', { name: '✓ Verstanden' }),
      'Bonier-Toast':             page.getByText(/^Boniert — Tisch SB /),
    }
    for (const el of Object.values(karten)) await expect(el).toBeVisible()
    await expect(page.getByText(kdsText)).toBeVisible()

    // Der Dialog liegt über allen Karten — und über der Kopfleiste
    expect(await zuoberst(amTerminal)).toBe(true)
    const lage: Record<string, boolean> = {}
    for (const [name, el] of Object.entries(karten)) lage[name] = await unterDialog(el)
    lage['Kopfleiste'] = await unterDialog(page.getByRole('banner').getByRole('button', { name: 'Verkauf' }))
    expect(lage).toEqual(Object.fromEntries(Object.keys(lage).map(k => [k, true])))

    // Tipps auf die (abgedunkelten) Karten treffen den Hintergrund: keine
    // Navigation, kein Abbruch, die Karten bleiben stehen
    for (const name of ['SB: Zu den Bestellungen', 'Gast: ✓ Gesehen', 'Zahlung: ✓ Übernommen', 'KDS: ✓ Verstanden']) {
      await tippeAuf(page, karten[name]!)
    }
    await expect(page).toHaveURL(/\/kasse$/)
    await expect(amTerminal).toBeVisible()
    expect(abbrueche).toBe(0)

    // Der Gast bestätigt am Terminal → nächster Abgleich holt „erfolg" → Beleg
    await page.unroute('**/api/zvt/zahlung/*')
    const beleg = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/belege/barzahlung'))
    await page.clock.runFor(1_000)
    const belegAntwort = await beleg
    expect(belegAntwort.ok()).toBe(true)
    const erstellt = await belegAntwort.json() as { belegNummer: number; summeKarteCent: number }
    expect(erstellt.summeKarteCent).toBe(350)
    // Bestätigung: im Druck-Modus eine Leiste, im Digital-Modus (Stand nach
    // onboarding) der Beleg-Dialog — der liegt ebenfalls über den Karten; schließen
    await expect(page.getByText(`Beleg #${erstellt.belegNummer} erstellt`)).toBeVisible()
    if (await page.getByRole('dialog').count() > 0) await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(abbrueche).toBe(0)

    // Ohne Dialog ist jede Karte wieder bedienbar — auch SB und Gast gleichzeitig
    for (const [name, el] of Object.entries(karten)) {
      expect(await zuoberst(el), `${name} ist zuoberst`).toBe(true)
    }
    await karten['SB: Zu den Bestellungen']!.click()
    await expect(page).toHaveURL(/\/sb-bestellungen$/)
  } finally {
    await verwerfeTische(request, auth, kasseId, [gastTisch, zahlTisch])
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    await zurueck()
  }
})

test('Optionen-Dialog und „Neuer Kunde" im mitlaufenden Kassen-Abschnitt liegen über Karten und Kopfleiste', async ({ page, request }) => {
  const login   = await adminLogin(request)
  const auth    = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const nr        = `${Date.now() % 100000}`
  const gastTisch = `G${nr}`
  const kdsText   = `Tisch 4 abholen (${nr})`

  const zurueck = await richteKartenquellenEin(request, auth, kasseId)
  const artikel = await (await request.post('/api/artikel', {
    headers: auth, data: { bezeichnung: `Karten-Tee ${nr}`, preisBruttoCent: 400, mwstSatz: 'normal' },
  })).json() as { id: string; bezeichnung: string }
  const gruppe = await (await request.post('/api/modifikator-gruppen', {
    headers: auth, data: { name: `Milch ${nr}`, typ: 'optional' },
  })).json() as { id: string }

  try {
    expect((await request.post(`/api/modifikator-gruppen/${gruppe.id}/modifikatoren`, {
      headers: auth, data: { name: 'Hafermilch', aufschlagCent: 50 },
    })).status()).toBe(201)
    expect((await request.put(`/api/artikel/${artikel.id}/modifikator-gruppen`, {
      headers: auth, data: { gruppenIds: [gruppe.id] },
    })).ok()).toBe(true)

    await anmelden(page, request, login)
    await page.goto('/kasse')
    await expect(page.getByPlaceholder(/Artikel suchen/)).toBeVisible()

    // Karten oben links, oben mittig, oben rechts
    expect((await request.post('/api/kds/nachricht', {
      headers: auth, data: { text: kdsText, station: 'kueche', kasseIds: [] },
    })).ok()).toBe(true)
    expect((await request.post('/api/gast/bestellung', {
      data: { kasseId, tischNummer: gastTisch, positionen: [{ artikelId: artikel.id, menge: 1 }] },
    })).status()).toBe(201)
    const karten: Record<string, Locator> = {
      'Gast: ✓ Gesehen':   page.getByRole('button', { name: '✓ Gesehen' }),
      'KDS: ✓ Verstanden': page.getByRole('button', { name: '✓ Verstanden' }),
      'Kopfleiste':        page.getByRole('banner').getByRole('button', { name: 'Verkauf' }),
    }
    for (const el of Object.values(karten)) await expect(el).toBeVisible()

    const pruefe = async () => {
      await expect(page.getByRole('dialog')).toBeVisible()
      const lage: Record<string, boolean> = {}
      for (const [name, el] of Object.entries(karten)) lage[name] = await unterDialog(el)
      return lage
    }
    const alleUnterDialog = Object.fromEntries(Object.keys(karten).map(k => [k, true]))

    // Optionen-Dialog (ArtikelGrid im sticky Artikel-Abschnitt)
    const suche = page.getByPlaceholder(/Artikel suchen/)
    await suche.fill(artikel.bezeichnung)
    await page.getByRole('button', { name: artikel.bezeichnung }).first().click()
    await expect(page.getByRole('dialog').getByText('Hafermilch')).toBeVisible()
    expect(await pruefe()).toEqual(alleUnterDialog)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // „Neuer Kunde" (KundePicker im sticky Warenkorb)
    await page.getByTitle('Neuen Kunden anlegen').click()
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Neuer Kunde' })).toBeVisible()
    expect(await pruefe()).toEqual(alleUnterDialog)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Ohne Dialog: alles wieder bedienbar
    for (const [name, el] of Object.entries(karten)) {
      expect(await zuoberst(el), `${name} ist zuoberst`).toBe(true)
    }
  } finally {
    await verwerfeTische(request, auth, kasseId, [gastTisch])
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    await request.delete(`/api/modifikator-gruppen/${gruppe.id}`, { headers: auth })
    await zurueck()
  }
})

})
