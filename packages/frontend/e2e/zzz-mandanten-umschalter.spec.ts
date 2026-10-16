import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Mandanten-Umschalter: dieses Gerät mit einem Klick auf einen anderen Betrieb (Mandanten) umschalten.
 *
 *  - Kopfleiste: der Firmenname wird zur Liste, sobald das Gerät mehrere Mandanten kennt; ein Klick wechselt ohne
 *    Anmeldung (gemerkte Sitzung), und zurück; in der Kasse fragt der Wechsel vorher nach; eingeklappt kompakt
 *  - ohne gültige Sitzung: Wechsel führt zur Anmeldung DES Mandanten (Kasse + PIN-Pad dort); die bisherige Sitzung
 *    liegt zur Seite; die Anmeldeseite bietet die bekannten Mandanten zur Wahl
 *  - Abmelden verwirft alle gemerkten Sitzungen — die Konten (Namen) bleiben
 *  - wer keine Einstellungen ändern darf (Kellner), bekommt keinen Umschalter
 *  - „Weiteren Mandanten anmelden": eigener Modus der Anmeldeseite, die aktuelle Sitzung bleibt bestehen
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript — es wird kein Passwort in die Maske getippt.
 * Legt einen zweiten Mandanten (per /api/setup) und einen Kellner an; beides bleibt in der Wegwerf-Datenbank.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const KELLNER_PASSWORT = 'kellner-passwort-123'

test.use({ serviceWorkers: 'block' })
test.setTimeout(180_000)

interface Login {
  token: string; user: { id: string }; mandant: { id: string; firmenname: string } & Record<string, unknown>
  kassen: { id: string; kassenId: string; bezeichnung: string | null; umgebung: string }[]
}

/** /api/auth/login ist auf 10 Anmeldungen je Minute begrenzt (429): abwarten statt fälschlich in /api/setup zu fallen. */
async function loginAbwarten(request: APIRequestContext, email: string, passwort: string) {
  const body = { data: { email, passwort } }
  for (let versuch = 0; versuch < 6; versuch++) {
    const res = await request.post('/api/auth/login', body)
    if (res.status() !== 429) return res
    const sekunden = Math.min(Math.max(Number(res.headers()['retry-after']) || 10, 2), 65)
    await new Promise(r => setTimeout(r, sekunden * 1000))
  }
  return request.post('/api/auth/login', body)
}

async function anmeldenPerApi(request: APIRequestContext, email: string, passwort: string): Promise<Login> {
  const res = await loginAbwarten(request, email, passwort)
  if (!res.ok()) throw new Error(`Login ${email} fehlgeschlagen (${res.status()}): ${await res.text()}`)
  return (await res.json()) as Login
}

/**
 * Mandant A: der Admin der Suite (bei frischer Datenbank per Ersteinrichtung angelegt). Einmal je Lauf angemeldet und
 * wiederverwendet — das Token gilt 8 Stunden, und /api/auth/login bremst bei mehr als 10 Anmeldungen je Minute.
 */
let mandantA: Promise<Login> | null = null
function adminLogin(request: APIRequestContext): Promise<Login> {
  mandantA ??= (async () => {
    const res = await loginAbwarten(request, ADMIN_EMAIL, ADMIN_PASSWORT)
    if (res.ok()) return (await res.json()) as Login
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-MAND-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    return anmeldenPerApi(request, ADMIN_EMAIL, ADMIN_PASSWORT)
  })()
  return mandantA
}

/** Mandant B: ein zweiter Betrieb auf derselben Installation — wird je Lauf einmal angelegt und wiederverwendet. */
let mandantB: Promise<Login> | null = null
function zweiterMandant(request: APIRequestContext): Promise<Login> {
  mandantB ??= (async () => {
    const kennung = String(Date.now() % 1_000_000)
    const email = `mandant-b-${kennung}@test.at`
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: `E2E Mandant B ${kennung}`, uid: `ATU${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`,
        kassenId: `E2E-MB-${kennung}`,
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'Admin B', email, passwort: ADMIN_PASSWORT },
      },
      timeout: 90_000,
    })
    if (!setup.ok()) throw new Error(`Setup Mandant B fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    return anmeldenPerApi(request, email, ADMIN_PASSWORT)
  })()
  return mandantB
}

/** Das Konto eines Mandanten in der Form, in der das Gerät es merkt (lib/konten.ts) — mit oder ohne zur Seite gelegte Sitzung. */
function konto(login: Login, sitzung: Login | { token: string } | null) {
  return {
    mandantId: login.mandant.id, firmenname: login.mandant.firmenname,
    kassen: login.kassen.map(k => ({ id: k.id, kassenId: k.kassenId, bezeichnung: k.bezeichnung })),
    kasseId: login.kassen[0]!.id, benutzer: 'E2E', geraetToken: null,
    sitzung: sitzung ? { ...login, token: sitzung.token } : null,
  }
}

/** Ein Token, das längst abgelaufen ist (die Signatur spielt hier keine Rolle). */
const ABGELAUFEN = `kopf.${Buffer.from(JSON.stringify({ sub: 'x', exp: 1 })).toString('base64url')}.signatur`

/**
 * Meldet die Seite an (und merkt optional Konten). Das Init-Skript läuft bei JEDEM Laden — gesetzt wird nur beim ersten
 * Mal je Tab (sessionStorage), sonst nähme es jeden Wechsel und jedes Abmelden sofort zurück.
 */
async function anmelden(page: Page, login: Login, konten: unknown[] = []) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string; kontenJson: string | null }) => {
    if (sessionStorage.getItem('e2e:angemeldet')) return
    sessionStorage.setItem('e2e:angemeldet', '1')
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
    if (d.kontenJson) localStorage.setItem('kassa:konten', d.kontenJson)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
    kontenJson: konten.length ? JSON.stringify(konten) : null,
  })
}

/** Was im Speicher des Geräts steht (null-Werte mitten im Neuladen). */
async function speicher(page: Page) {
  try {
    return await page.evaluate(() => ({
      token: localStorage.getItem('kassa:token'),
      mandantId: localStorage.getItem('kassa:mandantId'),
      kasseId: localStorage.getItem('kassa:kasseId'),
      konten: JSON.parse(localStorage.getItem('kassa:konten') ?? '[]') as { mandantId: string; sitzung: { token: string } | null }[],
    }))
  } catch {
    return null
  }
}

const oeffneListe = async (page: Page) => {
  await page.getByTestId('mandanten-umschalter').click()
  const liste = page.getByRole('listbox', { name: 'Mandant wählen' })
  await expect(liste).toBeVisible()
  return liste
}

test('Mandanten-Umschalter: ein Klick wechselt ohne Anmeldung, zurück, Rückfrage in der Kasse, kompakt', async ({ page, request }) => {
  const a = await adminLogin(request)
  const b = await zweiterMandant(request)

  // B war vorher schon angemeldet und liegt zur Seite; A ist die aktive Sitzung (das Gerät nimmt A beim Start selbst auf)
  await anmelden(page, a, [konto(b, b)])
  await page.goto('/belege')

  await test.step('der Firmenname wird zur Liste: A aktiv, B angemeldet', async () => {
    await expect(page.getByTestId('mandanten-umschalter')).toContainText(a.mandant.firmenname)
    const liste = await oeffneListe(page)
    await expect(liste.getByRole('option')).toHaveCount(2)
    await expect(page.getByTestId(`mandanten-umschalter-${a.mandant.id}`)).toContainText('● aktiv')
    await expect(page.getByTestId(`mandanten-umschalter-${b.mandant.id}`)).toContainText('angemeldet')
    await page.keyboard.press('Escape')
    await expect(liste).toHaveCount(0)
  })

  await test.step('ein Klick auf B: Sitzung und Kasse von B sind aktiv, A liegt zur Seite — keine Anmeldeseite', async () => {
    await oeffneListe(page)
    await page.getByTestId(`mandanten-umschalter-${b.mandant.id}`).click()
    await expect.poll(async () => (await speicher(page))?.mandantId).toBe(b.mandant.id)
    await expect(page.getByTestId('status-mandant')).toHaveText(b.mandant.firmenname)
    const s = (await speicher(page))!
    expect(s.token).toBe(b.token)
    expect(s.kasseId).toBe(b.kassen[0]!.id)
    expect(s.konten.find(k => k.mandantId === a.mandant.id)?.sitzung?.token).toBe(a.token)
    expect(s.konten.find(k => k.mandantId === b.mandant.id)?.sitzung).toBeNull()
    await expect(page).not.toHaveURL(/\/login/)
  })

  await test.step('und zurück zu A', async () => {
    await oeffneListe(page)
    await expect(page.getByTestId(`mandanten-umschalter-${a.mandant.id}`)).toContainText('angemeldet')
    await page.getByTestId(`mandanten-umschalter-${a.mandant.id}`).click()
    await expect.poll(async () => (await speicher(page))?.mandantId).toBe(a.mandant.id)
    await expect(page.getByTestId('status-mandant')).toHaveText(a.mandant.firmenname)
    expect((await speicher(page))!.token).toBe(a.token)
  })

  await test.step('in der Kasse fragt der Wechsel vorher nach — Abbrechen lässt alles, OK wechselt', async () => {
    await page.goto('/kasse')
    await expect(page.getByTestId('mandanten-umschalter')).toBeVisible()
    const frage = new Promise<string>(resolve => page.once('dialog', d => { resolve(d.message()); void d.dismiss() }))
    await oeffneListe(page)
    await page.getByTestId(`mandanten-umschalter-${b.mandant.id}`).click()
    const text = await frage
    expect(text).toContain(`„${b.mandant.firmenname}"`)
    expect(text).toContain('Warenkorb')
    expect((await speicher(page))!.mandantId).toBe(a.mandant.id)               // abgebrochen: nichts geändert

    page.once('dialog', d => void d.accept())
    await oeffneListe(page)
    await page.getByTestId(`mandanten-umschalter-${b.mandant.id}`).click()
    await expect.poll(async () => (await speicher(page))?.mandantId).toBe(b.mandant.id)
    await expect(page.getByTestId('status-mandant')).toHaveText(b.mandant.firmenname)     // Seite ist nach dem Wechsel neu geladen
  })

  await test.step('eingeklappte Kopfleiste: kompakter Umschalter, ein Klick wechselt auch dort', async () => {
    await page.evaluate(() => localStorage.setItem('kassa:kopfleisteEingeklappt', '1'))
    await page.goto('/belege')
    await expect(page.getByRole('button', { name: /Menü/ })).toBeVisible()          // „☰ Menü" = eingeklappt
    await expect(page.getByTestId('mandanten-umschalter')).toContainText(b.mandant.firmenname)
    // Die Kopfleiste wieder ausklappen (wirkt erst beim nächsten Laden — also mit dem Wechsel), dann wechseln
    await page.evaluate(() => localStorage.removeItem('kassa:kopfleisteEingeklappt'))
    await oeffneListe(page)
    await page.getByTestId(`mandanten-umschalter-${a.mandant.id}`).click()
    await expect.poll(async () => (await speicher(page))?.mandantId).toBe(a.mandant.id)
    await expect(page.getByTestId('status-mandant')).toHaveText(a.mandant.firmenname)
  })
})

test('Mandanten-Umschalter: ohne gültige Sitzung führt der Wechsel zur Anmeldung dort; Abmelden verwirft alle Sitzungen', async ({ page, request }) => {
  const a = await adminLogin(request)
  const b = await zweiterMandant(request)

  // B ist bekannt, seine Sitzung aber abgelaufen
  await anmelden(page, a, [konto(b, { token: ABGELAUFEN })])
  await page.goto('/belege')

  await test.step('abgelaufen: „Anmeldung nötig" — der Klick zeigt die Anmeldeseite von B (Kasse dort), A liegt zur Seite', async () => {
    await oeffneListe(page)
    await expect(page.getByTestId(`mandanten-umschalter-${b.mandant.id}`)).toContainText('Anmeldung nötig')
    await page.getByTestId(`mandanten-umschalter-${b.mandant.id}`).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByTestId('login-mandant')).toHaveText(b.mandant.firmenname)
    await expect(page.getByTestId('login-kasse')).toContainText(b.kassen[0]!.bezeichnung || b.kassen[0]!.kassenId)
    const s = (await speicher(page))!
    expect(s.token).toBeNull()                                                  // keine aktive Sitzung mehr
    expect(s.mandantId).toBe(b.mandant.id)
    expect(s.kasseId).toBe(b.kassen[0]!.id)
    expect(s.konten.find(k => k.mandantId === a.mandant.id)?.sitzung?.token).toBe(a.token)   // liegt zur Seite
  })

  await test.step('die Anmeldeseite bietet beide Mandanten an; die Wahl stellt das PIN-Pad um', async () => {
    await expect(page.getByTestId(`login-konto-${b.mandant.id}`)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId(`login-konto-${a.mandant.id}`)).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId(`login-konto-${a.mandant.id}`).click()
    await expect(page.getByTestId('login-mandant')).toHaveText(a.mandant.firmenname)
    expect((await speicher(page))!.mandantId).toBe(a.mandant.id)
    expect((await speicher(page))!.kasseId).toBe(a.kassen[0]!.id)
  })
})

test('Mandanten-Umschalter: Abmelden verwirft alle gemerkten Sitzungen — die Konten bleiben', async ({ page, request }) => {
  const a = await adminLogin(request)
  const b = await zweiterMandant(request)
  await anmelden(page, a, [konto(b, b)])
  await page.goto('/belege')
  await expect(page.getByTestId('mandanten-umschalter')).toBeVisible()
  expect((await speicher(page))!.konten.find(k => k.mandantId === b.mandant.id)?.sitzung?.token).toBe(b.token)

  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page).toHaveURL(/\/login$/)
  const s = (await speicher(page))!
  expect(s.token).toBeNull()
  expect(s.konten.map(k => k.mandantId).sort()).toEqual([a.mandant.id, b.mandant.id].sort())   // Konten bleiben …
  expect(s.konten.every(k => k.sitzung === null)).toBe(true)                                     // … ohne eine einzige Sitzung
  await expect(page.getByTestId('login-konten')).toBeVisible()
})

test('Mandanten-Umschalter: ein Kellner (ohne Einstellungs-Recht) bekommt keinen Umschalter', async ({ page, request }) => {
  const a = await adminLogin(request)
  const b = await zweiterMandant(request)
  const kennung = String(Date.now() % 1_000_000)
  const email = `umschalter-kellner-${kennung}@test.at`
  const anlage = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${a.token}` },
    data: { name: 'Umschalter Kellner', email, passwort: KELLNER_PASSWORT, rolle: 'kellner', berechtigungen: ['belege.lesen'], kassenIds: [a.kassen[0]!.id] },
  })
  expect(anlage.ok(), `Kellner anlegen: ${await anlage.text()}`).toBe(true)
  const kellnerId = ((await anlage.json()) as { id: string }).id
  try {
    const kellner = await anmeldenPerApi(request, email, KELLNER_PASSWORT)
    // Selbst wenn auf dem Gerät eine Admin-Sitzung von B liegt: der Kellner sieht davon nichts
    await anmelden(page, kellner, [konto(b, b)])
    await page.goto('/belege')
    await expect(page.locator('header').first()).toContainText(a.mandant.firmenname)
    await expect(page.getByTestId('mandanten-umschalter')).toHaveCount(0)
  } finally {
    await request.delete(`/api/users/${kellnerId}`, { headers: { Authorization: `Bearer ${a.token}` } })
  }
})

test('Mandanten-Umschalter: „Weiteren Mandanten anmelden" — eigener Modus der Anmeldeseite, die Sitzung bleibt', async ({ page, request }) => {
  const a = await adminLogin(request)
  const b = await zweiterMandant(request)
  await anmelden(page, a, [konto(b, b)])
  await page.goto('/belege')

  await oeffneListe(page)
  await page.getByTestId('mandanten-umschalter-neu').click()
  await expect(page).toHaveURL(/\/login\?konto=neu$/)
  await expect(page.getByRole('heading', { name: 'Weiteren Mandanten anmelden' })).toBeVisible()
  await expect(page.getByTestId('login-weiterer-mandant')).toContainText('Ihre aktuelle Anmeldung bleibt bestehen')
  await expect(page.getByLabel('E-Mail')).toBeVisible()
  await expect(page.getByRole('button', { name: 'PIN', exact: true })).toHaveCount(0)           // kein PIN-Pad: es gehörte zu A
  expect((await speicher(page))!.token).toBe(a.token)                                           // A bleibt angemeldet

  await page.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(page).not.toHaveURL(/\/login/)
  expect((await speicher(page))!.token).toBe(a.token)
})

test('Mandanten-Umschalter: bekannte Konten entfernen; ein einzelner Mandant bleibt der schlichte Firmenname', async ({ page, request }) => {
  const a = await adminLogin(request)
  const b = await zweiterMandant(request)
  page.on('dialog', d => void d.accept())
  await anmelden(page, a, [konto(b, b)])
  await page.goto('/belege')

  await oeffneListe(page)
  await expect(page.getByTestId(`mandanten-entfernen-${a.mandant.id}`)).toHaveCount(0)         // das aktive Konto lässt sich nicht entfernen
  await page.getByTestId(`mandanten-entfernen-${b.mandant.id}`).click()
  expect((await speicher(page))!.konten.map(k => k.mandantId)).toEqual([a.mandant.id])

  await page.reload()
  await expect(page.getByTestId('mandanten-umschalter')).toHaveCount(0)                         // nur noch ein Mandant bekannt
  await expect(page.locator('header').first()).toContainText(a.mandant.firmenname)
})
