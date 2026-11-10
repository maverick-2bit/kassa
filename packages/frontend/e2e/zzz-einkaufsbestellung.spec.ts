import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Bestellung beim Lieferanten über die Oberfläche: aus der Bestellliste anlegen → Detail → bearbeiten →
 * PDF → Mailversand ohne SMTP meldet sich verständlich → als gesendet markieren → erledigt; neue Bestellung
 * von Hand, Entwurf löschen; Statusfilter.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet adminLogin() die Instanz selbst ein.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Einkauf GmbH',
        uid:        'ATU87654342',
        kassenId:   'E2E-EINKAUF-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test',
        admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return res.json() as Promise<{ token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }>
}

test('Bestellung beim Lieferanten: aus der Bestellliste anlegen, bearbeiten, PDF, Status bis erledigt, Entwurf löschen', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  const ts         = Date.now()
  const lieferant  = `Bestell-Lieferant ${ts}`
  const artikel1   = `Bestell-Toner ${ts}`
  const artikel2   = `Bestell-Kabel ${ts}`
  const artikel3   = `Bestell-Handarbeit ${ts}`

  const lieferantId = (await (await request.post('/api/lieferanten', {
    headers: authHeader, data: { name: lieferant, email: `bestellung-${ts}@lieferant.at`, strasse: 'Hauptstraße 1', plz: '8750', ort: 'Judenburg' },
  })).json() as { id: string }).id
  const neuerArtikel = async (bezeichnung: string, extra: Record<string, unknown>) => (await (await request.post('/api/artikel', {
    headers: authHeader, data: { bezeichnung, preisBruttoCent: 5000, mwstSatz: 'normal', lieferantId, ...extra },
  })).json() as { id: string }).id
  // beide unter Mindestbestand → landen in der Bestellliste
  const a1 = await neuerArtikel(artikel1, { lagerstandAktiv: true, lagerstandMenge: 1, mindestbestand: 4, einkaufspreisCent: 4500, lieferantenArtikelnummer: `TN-${ts}` })
  const a2 = await neuerArtikel(artikel2, { lagerstandAktiv: true, lagerstandMenge: 0, mindestbestand: 10, einkaufspreisCent: 150 })
  const a3 = await neuerArtikel(artikel3, { einkaufspreisCent: 1000 })

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:     login.token,
    authJson:  JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id,
    kasseId:   login.kassen[0]!.id,
  })

  const nummern: string[] = []
  try {
    // ---- aus der Bestellliste anlegen
    await page.goto('/bestellliste')
    const gruppe = page.locator('div.bg-panel', { hasText: lieferant }).filter({ has: page.getByTestId('bestellung-anlegen') })
    await expect(gruppe).toBeVisible()
    await gruppe.getByTestId('bestellung-anlegen').click()

    await expect(page).toHaveURL(/\/einkaufsbestellungen$/)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('bestell-detail')).toBeVisible()
    await expect(dialog.getByText(artikel1)).toBeVisible()
    await expect(dialog.getByText(artikel2)).toBeVisible()
    await expect(dialog.getByText(`TN-${ts}`)).toBeVisible()
    // Vorschlag: max(Fehlmenge, Mindestbestand, 1) → 4 × 45,00 + 10 × 1,50 = 195,00
    await expect(dialog.getByText('Entwurf', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('cell', { name: /195,00/ }).first()).toBeVisible()
    const titel = await dialog.locator('h2').first().textContent()
    const nummer = /B\d{7}/.exec(titel ?? '')?.[0]
    expect(nummer, `Bestellnummer im Titel „${titel}"`).toBeTruthy()
    nummern.push(nummer!)

    // ---- bearbeiten: Menge des Toners auf 2
    await dialog.getByTestId('bestell-bearbeiten').click()
    const zeile1 = dialog.getByTestId('bestell-zeile').filter({ hasText: artikel1 })
    await zeile1.getByTestId('bestell-menge').fill('2')
    await expect(dialog.getByTestId('bestell-summe')).toContainText('105,00')      // 2 × 45 + 10 × 1,50
    await dialog.getByTestId('bestell-speichern').click()
    await expect(dialog.getByTestId('bestell-detail')).toBeVisible()
    await expect(dialog.getByRole('cell', { name: /105,00/ }).first()).toBeVisible()

    // ---- PDF
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByTestId('bestell-pdf').click(),
    ])
    expect(download.suggestedFilename()).toBe(`Bestellung-${nummer}.pdf`)

    // ---- Mail ohne SMTP-Konfiguration: verständliche Meldung, Status bleibt Entwurf
    await expect(dialog.getByTestId('bestell-empfaenger')).toHaveValue(`bestellung-${ts}@lieferant.at`)
    await dialog.getByTestId('bestell-mail').click()
    await expect(dialog.getByRole('alert')).toContainText('nicht konfiguriert')
    await expect(dialog.getByText('Entwurf', { exact: true })).toBeVisible()

    // ---- als gesendet markieren → erledigt
    await dialog.getByTestId('bestell-als-gesendet').click()
    await expect(dialog.getByText('Gesendet', { exact: true })).toBeVisible()
    await expect(dialog.getByTestId('bestell-bearbeiten')).toHaveCount(0)          // nicht mehr bearbeitbar
    await dialog.getByTestId('bestell-erledigt').click()
    await expect(dialog.getByText('Erledigt', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    // ---- Liste + Filter
    await expect(page.getByTestId('bestell-zeile-liste').filter({ hasText: nummer! })).toBeVisible()
    await page.getByTestId('bestell-filter-entwurf').click()
    await expect(page.getByTestId('bestell-zeile-liste').filter({ hasText: nummer! })).toHaveCount(0)
    await page.getByTestId('bestell-filter-erledigt').click()
    await expect(page.getByTestId('bestell-zeile-liste').filter({ hasText: nummer! })).toBeVisible()
    await page.getByTestId('bestell-filter-alle').click()

    // ---- neue Bestellung von Hand
    await page.getByTestId('bestell-neu').click()
    const neu = page.getByRole('dialog')
    await expect(neu.getByTestId('bestell-speichern')).toBeDisabled()               // ohne Lieferant/Position
    await neu.getByTestId('bestell-lieferant').selectOption(lieferantId)
    await neu.getByTestId('bestell-artikel-hinzu').selectOption(a3)
    await neu.getByTestId('bestell-menge').fill('3')
    await neu.getByTestId('bestell-termin').fill('2030-01-15')
    await expect(neu.getByTestId('bestell-summe')).toContainText('30,00')
    await neu.getByTestId('bestell-speichern').click()
    await expect(neu.getByTestId('bestell-detail')).toBeVisible()
    await expect(neu.getByText('Wunschtermin 15.01.2030')).toBeVisible()
    const nummer2 = /B\d{7}/.exec(await neu.locator('h2').first().textContent() ?? '')?.[0]
    expect(nummer2).toBeTruthy()
    nummern.push(nummer2!)
    expect(Number(nummer2!.slice(-3))).toBe(Number(nummer!.slice(-3)) + 1)           // fortlaufend

    // ---- Entwurf löschen (mit Rückfrage)
    await neu.getByTestId('bestell-loeschen').click()
    await expect(neu.getByTestId('bestell-bestaetigung')).toBeVisible()
    await neu.getByTestId('bestell-bestaetigen').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('bestell-zeile-liste').filter({ hasText: nummer2! })).toHaveCount(0)
  } finally {
    // Aufräumen: offene Bestellungen dieses Laufs stornieren/löschen, Artikel und Lieferant deaktivieren
    const liste = await (await request.get('/api/einkauf/bestellungen', { headers: authHeader })).json() as { id: string; nummer: string; status: string; lieferantId: string }[]
    for (const b of liste.filter(x => x.lieferantId === lieferantId && x.status === 'entwurf')) {
      await request.delete(`/api/einkauf/bestellungen/${b.id}`, { headers: authHeader })
    }
    for (const id of [a1, a2, a3]) await request.delete(`/api/artikel/${id}`, { headers: authHeader })
    await request.delete(`/api/lieferanten/${lieferantId}`, { headers: authHeader })
  }
})
