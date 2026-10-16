import { readFileSync } from 'node:fs'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Layout-Export: Warengruppen samt Artikeln aus einem Mandanten in eine Datei schreiben und in einem anderen
 * Mandanten (einer anderen Kassa) wieder einlesen.
 *
 *  - Artikel → „Layout exportieren (JSON)": Warengruppen wählen (eine Gruppe nimmt ihre Untergruppen mit), Datei wird
 *    heruntergeladen; Inhalt: Baum, Artikel mit Preis/MwSt/Raster-Platz/Allergenen, Optionen
 *  - dieselbe Datei in einem zweiten, leeren Mandanten per „Layout importieren (JSON)" → dieselben Gruppen und Artikel
 *  - der Export-Knopf ist nur für Admins da
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript — es wird kein Passwort in die Maske getippt.
 * Der zweite Mandant entsteht per /api/setup und bleibt in der Wegwerf-Datenbank.
 */

const ADMIN_EMAIL      = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT   = 'e2e-passwort-12345'
const KELLNER_PASSWORT = 'kellner-passwort-123'

test.use({ serviceWorkers: 'block' })
test.setTimeout(180_000)

interface Login {
  token: string; user: { id: string }; mandant: { id: string; firmenname: string } & Record<string, unknown>
  kassen: { id: string; kassenId: string; bezeichnung: string | null }[]
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

/** Mandant A: der Admin der Suite — einmal je Lauf angemeldet und wiederverwendet (Login-Limiter!). */
let mandantA: Promise<Login> | null = null
function adminLogin(request: APIRequestContext): Promise<Login> {
  mandantA ??= (async () => {
    const res = await loginAbwarten(request, ADMIN_EMAIL, ADMIN_PASSWORT)
    if (res.ok()) return (await res.json()) as Login
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-LEX-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    return anmeldenPerApi(request, ADMIN_EMAIL, ADMIN_PASSWORT)
  })()
  return mandantA
}

/** Mandant B: ein zweiter, leerer Betrieb auf derselben Installation. */
let mandantB: Promise<Login> | null = null
function zweiterMandant(request: APIRequestContext): Promise<Login> {
  mandantB ??= (async () => {
    const kennung = String(Date.now() % 1_000_000)
    const email = `layout-b-${kennung}@test.at`
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: `E2E Vereinskassa ${kennung}`, uid: `ATU${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`,
        kassenId: `E2E-LB-${kennung}`,
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

/** Meldet die Seite an (Init-Skript: nur beim ersten Laden je Tab). */
async function anmelden(page: Page, login: Login) {
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
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })
}

interface LayoutDatei {
  quelle?: string
  gruppen: {
    name: string; farbe: string; artikel: { name: string; preisCent: number; mwst: number; slot: number; allergene?: string | null
      optionen: { gruppe: string; exakterName?: boolean; pflicht: boolean; maxAuswahl?: number | null; optionen: { name: string; aufschlagCent: number }[] }[] }[]
    untergruppen: LayoutDatei['gruppen']
  }[]
}

test('Layout-Export: Warengruppen samt Artikeln exportieren und in einem zweiten Mandanten importieren', async ({ page, request, browser }) => {
  const a = await adminLogin(request)
  const b = await zweiterMandant(request)
  const authA = { Authorization: `Bearer ${a.token}` }
  const authB = { Authorization: `Bearer ${b.token}` }
  const p = `Ex${Date.now() % 1_000_000}`

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: authA, data })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }

  // ---- Mandant A: „Kellner Getränke" (mit Untergruppe „Bier") und „Kellner Speisen" — plus eine Gruppe, die NICHT wandern soll ----
  const getraenke = await post('/api/kategorien', { name: `${p} Kellner Getränke`, farbe: 'blau', reihenfolge: 7001 })
  const bier      = await post('/api/kategorien', { name: `${p} Bier`, farbe: 'gold', reihenfolge: 0, parentId: getraenke.id })
  const speisen   = await post('/api/kategorien', { name: `${p} Kellner Speisen`, farbe: 'rot', reihenfolge: 7002 })
  const buero     = await post('/api/kategorien', { name: `${p} Büro`, farbe: 'grau', reihenfolge: 7003 })
  const cola    = await post('/api/artikel', { bezeichnung: `${p} Cola`,      preisBruttoCent: 320,  mwstSatz: 'normal',      kategorieId: getraenke.id, rasterPosition: 1 })
  await post('/api/artikel', { bezeichnung: `${p} Wasser`,    preisBruttoCent: 290,  mwstSatz: 'ermaessigt1', kategorieId: getraenke.id, rasterPosition: 3, farbe: 'gruen' })
  await post('/api/artikel', { bezeichnung: `${p} Pils`,      preisBruttoCent: 450,  mwstSatz: 'normal',      kategorieId: bier.id,      rasterPosition: 1 })
  await post('/api/artikel', { bezeichnung: `${p} Schnitzel`, preisBruttoCent: 1450, mwstSatz: 'normal',      kategorieId: speisen.id,   rasterPosition: 2, allergene: 'A,C' })
  await post('/api/artikel', { bezeichnung: `${p} Locher`,    preisBruttoCent: 599,  mwstSatz: 'normal',      kategorieId: buero.id })
  const groesse = await post(`/api/modifikator-gruppen`, { name: `${p} Größe`, typ: 'pflicht', maxAuswahl: 1 })
  await post(`/api/modifikator-gruppen/${groesse.id}/modifikatoren`, { name: 'Klein', aufschlagCent: 0, reihenfolge: 0 })
  await post(`/api/modifikator-gruppen/${groesse.id}/modifikatoren`, { name: 'Groß', aufschlagCent: 100, reihenfolge: 1 })
  const zuw = await request.put(`/api/artikel/${cola.id}/modifikator-gruppen`, { headers: authA, data: { gruppenIds: [groesse.id] } })
  expect(zuw.ok(), await zuw.text()).toBe(true)

  let dateiPfad = ''
  await test.step('Mandant A: Warengruppen wählen und exportieren — die Datei wird heruntergeladen', async () => {
    await anmelden(page, a)
    await page.goto('/artikel')
    await page.getByRole('button', { name: 'Layout exportieren (JSON)' }).click()
    const dialog = page.getByTestId('layout-export')
    await expect(dialog).toBeVisible()

    // Erst nichts gewählt: Exportieren ist gesperrt
    await expect(dialog.getByRole('button', { name: 'Exportieren', exact: true })).toBeDisabled()
    // „Kellner Getränke" nimmt „Bier" mit (angehakt und gesperrt); „Kellner Speisen" dazu; „Büro" bleibt draußen
    await dialog.getByLabel(`Warengruppe ${p} Kellner Getränke wählen`).check()
    await expect(dialog.getByLabel(`Warengruppe ${p} Kellner Getränke › ${p} Bier wählen`)).toBeChecked()
    await expect(dialog.getByLabel(`Warengruppe ${p} Kellner Getränke › ${p} Bier wählen`)).toBeDisabled()
    await dialog.getByLabel(`Warengruppe ${p} Kellner Speisen wählen`).check()
    await expect(dialog.getByLabel(`Warengruppe ${p} Büro wählen`)).not.toBeChecked()
    await expect(dialog.getByTestId('layout-export-zaehler')).toContainText('3 Gruppen')
    await expect(dialog.getByTestId('layout-export-zaehler')).toContainText('4 Artikel')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Exportieren', exact: true }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^kassa-layout-e2e-onboarding-gmbh-\d{4}-\d{2}-\d{2}\.json$/)
    dateiPfad = (await download.path())!
    await expect(page.getByTestId('layout-export-ergebnis')).toContainText('3 Warengruppen, 4 Artikel, 1 Optionsgruppen')
    await page.getByRole('button', { name: 'Fertig' }).click()
  })

  await test.step('Inhalt der Datei: Baum, Artikel, Preise, Raster-Plätze, Allergene, Optionen — und keine Büro-Gruppe', async () => {
    const datei = JSON.parse(readFileSync(dateiPfad, 'utf8')) as LayoutDatei
    expect(datei.quelle).toMatch(/^Kassa-Export E2E Onboarding GmbH \(/)
    expect(datei.gruppen.map(g => g.name)).toEqual([`${p} Kellner Getränke`, `${p} Kellner Speisen`])
    const g = datei.gruppen[0]!
    expect(g.untergruppen.map(u => u.name)).toEqual([`${p} Bier`])
    expect(g.artikel.map(x => [x.name, x.preisCent, x.mwst, x.slot])).toEqual([[`${p} Cola`, 320, 0.2, 1], [`${p} Wasser`, 290, 0.1, 3]])
    expect(g.artikel[0]!.optionen).toMatchObject([{ gruppe: `${p} Größe`, exakterName: true, pflicht: true, maxAuswahl: 1,
      optionen: [{ name: 'Klein', aufschlagCent: 0 }, { name: 'Groß', aufschlagCent: 100 }] }])
    expect(datei.gruppen[1]!.artikel[0]).toMatchObject({ name: `${p} Schnitzel`, preisCent: 1450, allergene: 'A,C' })
    expect(JSON.stringify(datei)).not.toContain('Büro')
    expect(JSON.stringify(datei)).not.toContain('Locher')
  })

  await test.step('Mandant B (leer): „Layout importieren" — Vorschau, Anwenden → dieselben Gruppen und Artikel', async () => {
    const kontext = await browser.newContext({ baseURL: 'http://127.0.0.1:5173', serviceWorkers: 'block' })
    try {
      const seiteB = await kontext.newPage()
      await anmelden(seiteB, b)
      await seiteB.goto('/artikel')
      await seiteB.getByRole('button', { name: 'Layout importieren (JSON)' }).click()
      await seiteB.getByLabel('Layout-Datei (JSON)').setInputFiles(dateiPfad)
      await expect(seiteB.getByText(/Vorschau — noch nichts geändert/)).toBeVisible()
      await expect(seiteB.getByTestId('layout-bericht')).toContainText('4')                      // 4 Artikel
      await seiteB.getByRole('button', { name: 'Anwenden' }).click()
      await expect(seiteB.getByText('Layout angewendet')).toBeVisible({ timeout: 30_000 })
      await seiteB.getByRole('button', { name: 'Fertig' }).click()
    } finally {
      await kontext.close()
    }

    const gruppenB = (await (await request.get('/api/kategorien', { headers: authB })).json()) as { id: string; name: string; parentId: string | null }[]
    expect(gruppenB.map(g => g.name).sort()).toEqual([`${p} Bier`, `${p} Kellner Getränke`, `${p} Kellner Speisen`].sort())
    expect(gruppenB.find(g => g.name === `${p} Bier`)!.parentId).toBe(gruppenB.find(g => g.name === `${p} Kellner Getränke`)!.id)

    const artikelB = (await (await request.get('/api/artikel', { headers: authB })).json()) as
      { bezeichnung: string; preisBruttoCent: number; mwstSatz: string; rasterPosition: number | null; allergene: string | null; kategorieId: string | null }[]
    expect(artikelB.map(x => [x.bezeichnung, x.preisBruttoCent, x.mwstSatz, x.rasterPosition]).sort()).toEqual([
      [`${p} Cola`, 320, 'normal', 1], [`${p} Pils`, 450, 'normal', 1], [`${p} Schnitzel`, 1450, 'normal', 2], [`${p} Wasser`, 290, 'ermaessigt1', 3],
    ].sort())
    expect(artikelB.find(x => x.bezeichnung === `${p} Schnitzel`)!.allergene).toBe('A,C')
    expect(artikelB.some(x => x.bezeichnung.includes('Locher'))).toBe(false)

    const optionenB = (await (await request.get('/api/modifikator-gruppen', { headers: authB })).json()) as { name: string; typ: string; maxAuswahl: number | null }[]
    expect(optionenB.map(o => [o.name, o.typ, o.maxAuswahl])).toEqual([[`${p} Größe`, 'pflicht', 1]])
  })

  await test.step('Mandant A ist unverändert', async () => {
    const artikelA = (await (await request.get('/api/artikel', { headers: authA })).json()) as { bezeichnung: string }[]
    expect(artikelA.filter(x => x.bezeichnung.startsWith(p))).toHaveLength(5)
  })
})

test('Layout-Export: der Knopf ist nur für Admins da', async ({ page, request }) => {
  const a = await adminLogin(request)
  const email = `layout-kellner-${Date.now() % 1_000_000}@test.at`
  const anlage = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${a.token}` },
    data: { name: 'Layout Kellner', email, passwort: KELLNER_PASSWORT, rolle: 'kellner', berechtigungen: ['artikel.verwalten'], kassenIds: [a.kassen[0]!.id] },
  })
  expect(anlage.ok(), await anlage.text()).toBe(true)
  const kellnerId = ((await anlage.json()) as { id: string }).id
  try {
    await anmelden(page, await anmeldenPerApi(request, email, KELLNER_PASSWORT))
    await page.goto('/artikel')
    await expect(page.getByRole('button', { name: 'Layout importieren (JSON)' })).toBeVisible()      // die Seite ist da …
    await expect(page.getByRole('button', { name: 'Layout exportieren (JSON)' })).toHaveCount(0)     // … der Export nicht
  } finally {
    await request.delete(`/api/users/${kellnerId}`, { headers: { Authorization: `Bearer ${a.token}` } })
  }
})
