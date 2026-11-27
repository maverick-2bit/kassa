import { readFileSync } from 'node:fs'
import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Bestellvorschlag aus dem Verbrauch der letzten 14 Tage (Artikel & Lager → Bestellliste) und erwartete Reichweite
 * in der Lagerstandsliste: Verkauf über die API, Vorschlag und Reichweite an der Oberfläche, Reichweite ändern,
 * CSV-Export mit den Zahlen, PDF-Download, PDF-Vorschau zum Drucken.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet adminLogin() die Instanz selbst ein.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ viewport: { width: 1400, height: 900 } })

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Vorschlag GmbH', uid: 'ATU87654343', kassenId: 'E2E-VORSCHLAG-001', umgebung: 'test',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return res.json() as Promise<{ token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }>
}

test('Bestellvorschlag aus dem Verbrauch: Vorschlag, Reichweite, CSV, PDF, Druck; Lagerstand mit Reichweite', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000] }).toBe(200)
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const ts    = Date.now()
  const lieferant = `Vorschlag-Lieferant ${ts}`
  const name      = `Vorschlag-Bier ${ts}`

  const lieferantId = (await (await request.post('/api/lieferanten', { headers: auth, data: { name: lieferant } })).json() as { id: string }).id
  const artikel = await request.post('/api/artikel', {
    headers: auth,
    data: { bezeichnung: name, preisBruttoCent: 300, mwstSatz: 'normal', lieferantId, lagerstandAktiv: true, lagerstandMenge: 20, mindestbestand: 2, einkaufspreisCent: 100 },
  })
  expect(artikel.ok(), await artikel.text()).toBe(true)
  const artikelId = (await artikel.json() as { id: string }).id

  // 14 Stück verkauft → Ø 1/Tag, Bestand 6
  const verkauf = await request.post('/api/belege/barzahlung', {
    headers: auth,
    data: { kasseId: login.kassen[0]!.id, positionen: [{ artikelId, menge: 14 }], zahlung: { barCent: 4200, karteCent: 0, sonstigeCent: 0 } },
  })
  expect(verkauf.status(), await verkauf.text()).toBe(201)

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
  })

  await test.step('Bestellliste: Vorschlag = 14 Tage Bedarf + Mindestbestand − Bestand = 14 + 2 − 6 = 10', async () => {
    await page.goto('/bestellliste')
    const zeile = page.getByTestId('vorschlag-zeile').filter({ hasText: name })
    await expect(zeile).toBeVisible({ timeout: 15_000 })
    // Bestand, Unterwegs, Verbrauch, Ø/Tag, Reicht, Mindest, Vorschlag
    await expect(zeile.locator('td').nth(1)).toHaveText('6')
    await expect(zeile.locator('td').nth(3)).toHaveText('14')
    await expect(zeile.locator('td').nth(4)).toHaveText('1')
    await expect(zeile.locator('td').nth(5)).toHaveText('6 T')
    await expect(zeile.locator('td').nth(7)).toHaveText('10')
    await expect(zeile.getByTestId('vorschlag-menge')).toHaveValue('10')
    await page.locator('div.bg-panel', { hasText: lieferant }).first().screenshot({ path: test.info().outputPath('bestellvorschlag.png') })
  })

  await test.step('für 28 Tage bestellen: 28 + 2 − 6 = 24', async () => {
    await page.getByTestId('vorschlag-reichweite').fill('28')
    const zeile = page.getByTestId('vorschlag-zeile').filter({ hasText: name })
    await expect(zeile.getByTestId('vorschlag-menge')).toHaveValue('24')
  })

  await test.step('CSV-Export enthält Artikel, Verbrauch und Bestellmenge', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('vorschlag-csv').click()])
    expect(download.suggestedFilename()).toMatch(/^Bestellvorschlag-\d{4}-\d{2}-\d{2}\.csv$/)
    const csv = readFileSync((await download.path())!, 'utf8')
    expect(csv.split('\r\n')[0]).toContain('Verbrauch 14 T')
    const zeile = csv.split('\r\n').find(z => z.includes(name))!
    // Lieferant;Art.-Nr.;Artikel;Bestand;Unterwegs;Verbrauch;Ø/Tag;Reicht;Mindest;Vorschlag;Bestellen;EK;EK gesamt
    expect(zeile).toBe(`${lieferant};;${name};6;0;14;1;6;2;24;24;1,00;24,00`)
  })

  await test.step('PDF wird heruntergeladen, Drucken zeigt die PDF-Vorschau mit Drucken-Knopf', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('vorschlag-pdf').click()])
    expect(download.suggestedFilename()).toMatch(/^Bestellvorschlag-.*\.pdf$/)
    await page.getByTestId('vorschlag-drucken').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('pdf-vorschau')).toHaveAttribute('src', /^blob:/, { timeout: 10_000 })
    await expect(dialog.getByRole('button', { name: 'Drucken' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Schließen', exact: true }).last().click()
    await expect(dialog).toBeHidden()
  })

  await test.step('Lagerstand: erwartete Reichweite 6 Tage, Sortierung nach Reichweite', async () => {
    await page.goto('/lagerstand')
    await page.getByPlaceholder('Suche…').fill(name)
    const zeile = page.getByRole('row').filter({ hasText: name })
    await expect(zeile.getByTestId('lager-pro-tag')).toHaveText('1')
    await expect(zeile.getByTestId('lager-reicht')).toHaveText('6 T')
    await page.getByTestId('lager-sortierung').selectOption('reichweite')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('lager-csv').click()])
    const csv = readFileSync((await download.path())!, 'utf8')
    // Artikel;Art.-Nr. (vergibt die Kassa ggf. selbst);Lagerstand;Mindest;Verbrauch;Ø/Tag;Reicht;Unterwegs;Reicht mit Bestellung
    expect(csv.split('\r\n').find(z => z.includes(name))).toMatch(new RegExp(`^${name};[^;]*;6;2;14;1;6;0;6$`))
    await page.getByTestId('lager-drucken').click()
    await expect(page.getByRole('dialog').getByTestId('pdf-vorschau')).toHaveAttribute('src', /^blob:/, { timeout: 10_000 })
  })
})
