import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
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

  await test.step('Storno: Häkchen „zurück ins Lager" ist vorbelegt; abgewählt bleibt der Bestand, angehakt kommt er zurück', async () => {
    const bestand = async () => ((await (await request.get('/api/artikel', { headers: auth })).json()) as { id: string; lagerstandMenge: number }[])
      .find(a => a.id === artikelId)!.lagerstandMenge
    const verkaufe = async (menge: number) => {
      const r = await request.post('/api/belege/barzahlung', {
        headers: auth, data: { kasseId: login.kassen[0]!.id, positionen: [{ artikelId, menge }], zahlung: { barCent: menge * 300, karteCent: 0, sonstigeCent: 0 } },
      })
      expect(r.status()).toBe(201)
      return r.json() as Promise<{ belegNummer: number }>
    }
    const stornieren = async (belegNummer: number, zurueck: boolean) => {
      await page.goto('/belege')
      await page.getByTestId(`beleg-zeile-${belegNummer}`).getByRole('button', { name: 'Stornieren' }).click()
      const dialog = page.getByRole('dialog').filter({ hasText: `Beleg #${belegNummer} stornieren?` })
      const haken = dialog.getByTestId('storno-lager-haken')
      await expect(haken).toBeChecked()                         // Ware: Vorgabe „zurück"
      await expect(dialog.getByTestId('storno-lager')).toContainText(name)
      if (!zurueck) await haken.uncheck()
      await dialog.getByRole('button', { name: 'Storno bestätigen' }).click()
      const erstellt = page.getByRole('dialog').filter({ hasText: /Stornobeleg #\d+ erstellt/ })
      await expect(erstellt).toBeVisible()
      await erstellt.getByRole('button', { name: 'Schließen' }).click()
    }

    const vorher = await bestand()
    const a = await verkaufe(2)
    expect(await bestand()).toBe(vorher - 2)
    await stornieren(a.belegNummer, false)
    expect(await bestand()).toBe(vorher - 2)                    // abgewählt: bleibt verbraucht

    const b = await verkaufe(3)
    expect(await bestand()).toBe(vorher - 5)
    await stornieren(b.belegNummer, true)
    expect(await bestand()).toBe(vorher - 2)                    // angehakt: zurück ins Lager

    // Zurückholen: Lager bleibt — das Neukassieren der (freien) Positionen bucht nicht noch einmal ab
    const c = await verkaufe(1)
    expect(await bestand()).toBe(vorher - 3)
    await page.goto('/belege')
    await page.getByTestId(`beleg-zeile-${c.belegNummer}`).getByRole('button', { name: 'Zurückholen' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: `Beleg #${c.belegNummer} zurückholen?` })
    await expect(dialog.getByTestId('storno-lager-zurueckholen')).toBeVisible()
    await expect(dialog.getByTestId('storno-lager-haken')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Stornieren und zurückholen' }).click()
    await expect(page).toHaveURL(/\/kasse/, { timeout: 15_000 })
    expect(await bestand()).toBe(vorher - 3)
  })
})

test('Lager genau einmal: „Bonieren" an der Kasse, dann bar kassieren — der Beleg bucht nichts doppelt ab', async ({ page, request }) => {
  test.setTimeout(120_000)
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const ts    = Date.now()
  const name  = `Einmal-Bier ${ts}`

  // Bonierdrucker auf einen TCP-Empfänger in diesem Prozess (das Backend läuft auf demselben Rechner)
  const empfaenger = createServer(s => { s.on('data', () => undefined); s.on('error', () => undefined) })
  await new Promise<void>(r => empfaenger.listen(0, '127.0.0.1', () => r()))
  const port = (empfaenger.address() as AddressInfo).port
  const drucker = await request.post('/api/bonierdrucker', { headers: auth, data: { name: `Einmal-Drucker ${ts}`, ip: '127.0.0.1', port } })
  expect(drucker.ok(), await drucker.text()).toBe(true)
  const druckerId = (await drucker.json() as { id: string }).id
  try {
    const artikel = await request.post('/api/artikel', {
      headers: auth,
      data: { bezeichnung: name, preisBruttoCent: 400, mwstSatz: 'normal', bonierdruckerId: druckerId, lagerstandAktiv: true, lagerstandMenge: 10 },
    })
    expect(artikel.ok(), await artikel.text()).toBe(true)
    const artikelId = (await artikel.json() as { id: string }).id
    const bestand = async () => ((await (await request.get('/api/artikel', { headers: auth })).json()) as { id: string; lagerstandMenge: number }[])
      .find(a => a.id === artikelId)!.lagerstandMenge

    await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
      localStorage.setItem('kassa:token', d.token)
      localStorage.setItem('kassa:auth', d.authJson)
      localStorage.setItem('kassa:mandantId', d.mandantId)
      localStorage.setItem('kassa:kasseId', d.kasseId)
    }, {
      token: login.token, mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
      authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    })
    await page.goto('/kasse')
    await page.getByPlaceholder(/Artikel suchen/).fill(name)
    const kachel = page.getByTestId('artikel-kachel').filter({ hasText: name })
    await kachel.click()
    await kachel.click()

    // Bonieren: zieht 2 ab
    await page.getByRole('button', { name: 'Bonieren', exact: true }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: /Bonierung/ })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect.poll(bestand).toBe(8)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Bar kassieren: der Beleg verrechnet die Bonierung — bleibt 8 (vorher wäre der Artikel hier gar nicht oder
    // ohne Station doppelt abgebucht worden)
    await page.getByRole('button', { name: /^Bar \(/ }).click()
    await expect(page.getByText(/Beleg #\d+ erstellt/).first()).toBeVisible({ timeout: 20_000 })
    expect(await bestand()).toBe(8)
    // Steht die Kasse (durch andere Tests) auf digitalem Beleg, fragt ein Dialog nach — quittieren
    const belegDialog = page.getByRole('dialog').filter({ hasText: /Beleg #\d+ erstellt/ })
    if (await belegDialog.count() > 0) {
      const akzeptiert = belegDialog.getByRole('button', { name: 'Akzeptiert', exact: true })
      if (await akzeptiert.count() > 0) await akzeptiert.click()
      else await belegDialog.getByRole('button', { name: 'Schließen' }).first().click()
      await expect(belegDialog).toHaveCount(0)
    }

    // Direkt kassieren ohne Bonieren: wird abgebucht, obwohl der Artikel einen Bonierdrucker hat
    await page.getByPlaceholder(/Artikel suchen/).fill(name)
    await kachel.click()
    await page.getByRole('button', { name: /^Bar \(/ }).click()
    await expect.poll(bestand, { timeout: 20_000 }).toBe(7)
  } finally {
    // Immer aufräumen — ein übrig gebliebener Drucker brächte spätere Tests (Drucker-Listen) durcheinander
    await request.delete(`/api/bonierdrucker/${druckerId}`, { headers: auth }).catch(() => undefined)
    empfaenger.close()
  }
})
