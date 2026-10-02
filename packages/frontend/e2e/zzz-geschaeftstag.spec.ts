import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Geschäftstag (Tagesbeginn je Mandant, gültig ab Stichtag):
 *  1. Einstellung unter „Module": Tagesbeginn + „gilt ab" setzen, Vorschau des Übergangstags,
 *     „Keine Änderung" sperrt das Speichern, geplanten Wechsel zurücknehmen
 *  2. „heute" folgt dem Geschäftstag: um 03:00 vor dem Stichtags-Beginn 06:00 ist „heute" auf
 *     Tagesabschluss-Seite und in den Berichten noch der Vortag; der Tagesabschluss schreibt den
 *     Zeitraum aus; nach 06:00 ist es der neue Tag
 *  3. Zeiterfassung: eine Nachtschicht über Mitternacht steht unter ihrem Starttag
 *
 * Liegt bewusst am Ende der Suite (zzz-): der Tagesbeginn ist eine Einstellung des GANZEN
 * Mandanten. Jeder Test räumt seine geplanten Wechsel am Anfang UND am Ende wieder ab
 * (Retries!) — gespeicherte Stichtage lägen sonst für alle folgenden Specs im Weg.
 *
 * Der Browser-Zeitpunkt wird per page.clock auf „morgen 03:00 / 07:00 Wiener Zeit" gestellt:
 * ein Tagesbeginn gilt erst ab morgen, und diesen Tag kann man nicht abwarten.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

// Wiener Zeit im Browser — die Uhrzeiten der Zeiterfassungs-Zeilen kommen aus der Ortszeit des Geräts
test.use({ serviceWorkers: 'block', timezoneId: 'Europe/Vienna', locale: 'de-AT' })

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
test.setTimeout(150_000)

let gemerkterLogin: Login | null = null
async function adminLogin(request: APIRequestContext): Promise<Login> {
  if (gemerkterLogin) return gemerkterLogin
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-GT-001',
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

/** Frische Anmeldung (die Antwort trägt die aktuelle Tagesbeginn-Historie) in den Browser legen. */
async function anmelden(page: Page, request: APIRequestContext) {
  gemerkterLogin = null
  const login = await adminLogin(request)
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })
  return login
}

type Stand = { eintraege: { id: string; gueltigAb: string; beginn: string }[]; heute: { kalendertag: string; geschaeftstag: string; beginn: string } }

async function stand(request: APIRequestContext, token: string): Promise<Stand> {
  const res = await request.get('/api/mandanten/tagesbeginn', { headers: { Authorization: `Bearer ${token}` } })
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as Stand
}

/** Alle GEPLANTEN Wechsel (Stichtag in der Zukunft) zurücknehmen — gültige bleiben, das lässt der Server nicht anders zu. */
async function raeumeGeplantesAb(request: APIRequestContext, token: string): Promise<Stand> {
  const aktuell = await stand(request, token)
  for (const e of aktuell.eintraege.filter(x => x.gueltigAb > aktuell.heute.kalendertag)) {
    const res = await request.delete(`/api/mandanten/tagesbeginn/${e.id}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  return stand(request, token)
}

function addTage(datum: string, tage: number): string {
  const [j, m, t] = datum.split('-').map(Number)
  return new Date(Date.UTC(j!, m! - 1, t! + tage)).toISOString().slice(0, 10)
}

/** 'JJJJ-MM-TT' → 'TT.MM.JJJJ' */
function datumKurz(datum: string): string {
  const [j, m, t] = datum.split('-')
  return `${t}.${m}.${j}`
}

/** Zeitpunkt, zu dem die Wiener Wanduhr `datum` `hm` zeigt (Sommer-/Winterzeit über Intl). */
function wienerZeitpunkt(datum: string, hm: string): Date {
  const [j, m, t] = datum.split('-').map(Number)
  const [h, mi]   = hm.split(':').map(Number)
  const anzeige   = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  for (const versatz of [1, 2]) {
    const kandidat = new Date(Date.UTC(j!, m! - 1, t!, h! - versatz, mi))
    if (anzeige.format(kandidat) === hm) return kandidat
  }
  throw new Error(`Keine Wiener Zeit ${datum} ${hm}`)
}

test('Einstellung: Tagesbeginn ab morgen setzen, Vorschau, „Keine Änderung", Zurücknehmen', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const ausgang = await raeumeGeplantesAb(request, login.token)
  const morgen  = addTage(ausgang.heute.kalendertag, 1)

  try {
    await anmelden(page, request)
    await page.goto('/module')

    const abschnitt = page.getByTestId('geschaeftstag-abschnitt')
    await expect(abschnitt.getByRole('heading', { name: 'Geschäftstag' })).toBeVisible()
    await expect(page.getByTestId('geschaeftstag-aktuell')).toContainText(`${ausgang.heute.beginn} Uhr`)

    // Eingabe: 06:00 ab morgen (Vorgabe des Datumsfelds)
    await expect(page.getByTestId('geschaeftstag-ab')).toHaveValue(morgen)
    await page.getByTestId('geschaeftstag-beginn').fill('06:00')

    // Vorschau des Übergangstags: der Tag VOR dem Stichtag wird länger (heute 00:00 bis morgen 06:00)
    const vorschau = page.getByTestId('geschaeftstag-vorschau')
    await expect(vorschau).toContainText(`Ab dem ${datumKurz(morgen)} beginnt der Tag um 06:00 Uhr`)
    await expect(vorschau).toContainText('Übergangstag')
    await expect(vorschau).toContainText('länger')
    await expect(vorschau).toContainText(/\d+(,\d)? Stunden statt \d+/)
    await expect(vorschau).toContainText('bleiben unverändert')

    await page.getByTestId('geschaeftstag-speichern').click()
    await expect(page.getByTestId('geschaeftstag-erfolg')).toContainText(`Ab dem ${datumKurz(morgen)} beginnt der Tag um 06:00 Uhr`)

    // Der geplante Wechsel steht in der Liste; HEUTE gilt weiter der alte Beginn
    const zeile = page.getByTestId(`geschaeftstag-eintrag-${morgen}`)
    await expect(zeile).toContainText('06:00 Uhr')
    await expect(zeile).toContainText('geplant')
    await expect(page.getByTestId('geschaeftstag-aktuell')).toContainText(`${ausgang.heute.beginn} Uhr`)

    // Server hat den Eintrag (Neuladen)
    await page.reload()
    await expect(page.getByTestId(`geschaeftstag-eintrag-${morgen}`)).toContainText('geplant')

    // Dasselbe nochmal: „Keine Änderung" — Speichern gesperrt
    await page.getByTestId('geschaeftstag-beginn').fill('06:00')
    await expect(page.getByTestId('geschaeftstag-vorschau')).toContainText('Keine Änderung')
    await expect(page.getByTestId('geschaeftstag-speichern')).toBeDisabled()

    // Ungültige Uhrzeit blockiert ebenfalls
    await page.getByTestId('geschaeftstag-beginn').fill('')
    await expect(page.getByTestId('geschaeftstag-speichern')).toBeDisabled()

    // Geplanten Wechsel zurücknehmen
    page.once('dialog', d => void d.accept())
    await page.getByTestId(`geschaeftstag-zurueck-${morgen}`).click()
    await expect(page.getByTestId('geschaeftstag-erfolg')).toContainText('zurückgenommen')
    await expect(page.getByTestId(`geschaeftstag-eintrag-${morgen}`)).toHaveCount(0)
    expect((await stand(request, login.token)).eintraege.some(e => e.gueltigAb === morgen)).toBe(false)
  } finally {
    await raeumeGeplantesAb(request, login.token)
  }
})

test('„heute" folgt dem Geschäftstag: Tagesabschluss und Berichte um 03:00 vor dem Beginn 06:00', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const ausgang = await raeumeGeplantesAb(request, login.token)
  const heute   = ausgang.heute.kalendertag
  const morgen  = addTage(heute, 1)

  try {
    // 06:00 ab morgen — per API, danach FRISCH anmelden (die Anmeldung trägt die Historie ins Frontend)
    const res = await request.post('/api/mandanten/tagesbeginn', {
      headers: { Authorization: `Bearer ${login.token}` }, data: { gueltigAb: morgen, beginn: '06:00' },
    })
    expect(res.ok(), await res.text()).toBe(true)
    await anmelden(page, request)

    // Morgen 03:00 Wiener Zeit: der Kalendertag ist schon „morgen", der Geschäftstag noch „heute"
    await page.clock.setFixedTime(wienerZeitpunkt(morgen, '03:00'))
    await page.goto('/tagesabschluss')
    const datumsfeld = page.locator('input[type="date"]').first()
    await expect(datumsfeld).toHaveValue(heute)
    await expect(datumsfeld).not.toHaveValue(morgen)

    // Der Abschluss dieses Geschäftstags läuft von 00:00 bis morgen 06:00 — ausgeschrieben, damit klar ist, was dazugehört
    await expect(page.getByTestId('tagesabschluss-zeitraum')).toContainText(`Geschäftstag ${datumKurz(heute)}, 00:00 – ${datumKurz(morgen)}, 06:00`)

    // Berichte: „Heute" ist ebenfalls der Geschäftstag
    await page.goto('/berichte')
    await expect(page.getByTestId('berichte-geschaeftstag-hinweis')).toContainText('Geschäftstage (Tagesbeginn 06:00 Uhr)')
    await page.getByRole('button', { name: 'Umsatz', exact: true }).click()
    await page.getByRole('button', { name: 'Heute', exact: true }).click()
    await expect(page.locator('input[type="date"]').first()).toHaveValue(heute)

    // Nach dem Tagesbeginn (morgen 07:00) ist „heute" der neue Tag
    await page.clock.setFixedTime(wienerZeitpunkt(morgen, '07:00'))
    await page.goto('/tagesabschluss')
    await expect(page.locator('input[type="date"]').first()).toHaveValue(morgen)
  } finally {
    await raeumeGeplantesAb(request, login.token)
  }
})

test('Zeiterfassung: eine Nachtschicht über Mitternacht steht unter ihrem Starttag', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const kopf  = { Authorization: `Bearer ${login.token}` }
  const ausgang = await raeumeGeplantesAb(request, login.token)
  const morgen  = addTage(ausgang.heute.kalendertag, 1)
  const uebermorgen = addTage(morgen, 1)

  // Zeiterfassungs-Modul einschalten (Route + Seite), am Ende wie vorgefunden zurück
  const vorher = (await (await request.get('/api/mandanten/module', { headers: kopf })).json()) as { modulZeiterfassungAktiv: boolean }
  let angelegt: string | null = null

  try {
    const an = await request.patch('/api/mandanten/module', { headers: kopf, data: { modulZeiterfassungAktiv: true } })
    expect(an.ok(), await an.text()).toBe(true)

    // Tagesbeginn 06:00 ab morgen; die Schicht: morgen 18:00 bis übermorgen 02:00
    const tb = await request.post('/api/mandanten/tagesbeginn', { headers: kopf, data: { gueltigAb: morgen, beginn: '06:00' } })
    expect(tb.ok(), await tb.text()).toBe(true)
    const schicht = await request.post('/api/zeiterfassung', {
      headers: kopf,
      data: {
        kasseId: login.kassen[0]!.id, userId: login.user.id,
        beginn: wienerZeitpunkt(morgen, '18:00').toISOString(), ende: wienerZeitpunkt(uebermorgen, '02:00').toISOString(),
        notiz: 'E2E Nachtschicht',
      },
    })
    expect(schicht.ok(), await schicht.text()).toBe(true)
    const antwort = (await schicht.json()) as { id: string; geschaeftstag: string }
    angelegt = antwort.id
    expect(antwort.geschaeftstag).toBe(morgen)

    // Liste für „morgen" (Geschäftstag) enthält die Schicht, die für „übermorgen" nicht
    const liste = async (tag: string) => (await (await request.get(`/api/zeiterfassung?datumVon=${tag}&datumBis=${tag}`, { headers: kopf })).json()) as { id: string }[]
    expect((await liste(morgen)).map(z => z.id)).toContain(angelegt)
    expect((await liste(uebermorgen)).map(z => z.id)).not.toContain(angelegt)

    // Die Seite: Übersicht, Woche mit „morgen" — Zeile mit dem Starttag, Ende mit „+1"
    await anmelden(page, request)
    await page.goto('/zeiterfassung')
    await page.getByRole('button', { name: 'Übersicht', exact: true }).click()
    // morgen liegt in der aktuellen Woche (Mo–So) — außer heute ist Sonntag, dann ist morgen der Montag der nächsten
    const heuteIstSonntag = new Date(`${ausgang.heute.kalendertag}T12:00:00Z`).getUTCDay() === 0
    if (heuteIstSonntag) await page.getByRole('button', { name: 'Woche →' }).click()
    const zeile = page.locator(`[data-testid="ze-schicht"][data-geschaeftstag="${morgen}"]`)
    await expect(zeile.first()).toBeVisible()
    await expect(zeile.first()).toContainText(datumKurz(morgen))
    await expect(zeile.first()).toContainText('18:00')
    await expect(zeile.first()).toContainText('02:00')
    await expect(zeile.first()).toContainText('+1')
    // keine zweite Zeile unter „übermorgen"
    await expect(page.locator(`[data-testid="ze-schicht"][data-geschaeftstag="${uebermorgen}"]`)).toHaveCount(0)
  } finally {
    if (angelegt) await request.delete(`/api/zeiterfassung/${angelegt}`, { headers: kopf })
    await raeumeGeplantesAb(request, login.token)
    await request.patch('/api/mandanten/module', { headers: kopf, data: { modulZeiterfassungAktiv: vorher.modulZeiterfassungAktiv } })
  }
})
