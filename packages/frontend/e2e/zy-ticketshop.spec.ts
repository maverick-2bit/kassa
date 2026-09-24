import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Ticketshop-Journey (Release 3): Gast kauft am Handy zwei Tickets über die
 * Eventseite der Ticket-App → Bestellseite mit Tickets + Rechnung → Ticket zeigt
 * das Band nach Alter am Eventtag → Backoffice listet die Bestellung.
 *
 * Ohne Stripe-Schlüssel (E2E: NODE_ENV=test) nimmt der Shop den Demo-Pfad:
 * die Bestellung wird sofort abgeschlossen — mit echtem RKSV-Beleg auf der
 * Verkaufskasse. Den Stripe-Pfad decken die Integrationstests ab.
 */

const TICKET_APP     = 'http://127.0.0.1:5181'
const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Shop GmbH',
        uid:        'ATU87654330',
        kassenId:   'E2E-SHOP-001',
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

test('Ticketshop: Gast kauft zwei Tickets am Handy, bekommt Tickets + Rechnung, Backoffice sieht die Bestellung', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const titel = `E2E Herbstfest ${Date.now()}`
  const jahr  = new Date().getFullYear() + 1

  // Einrichtung per API (Einstellungen sind nicht Gegenstand dieses Tests)
  expect((await request.patch('/api/mandanten/module', { headers: auth, data: { modulTicketsAktiv: true } })).ok()).toBe(true)
  expect((await request.put('/api/ticketing/einstellungen', { headers: auth, data: { ticketBasisUrl: TICKET_APP } })).ok()).toBe(true)
  expect((await request.put('/api/ticketing/shop-einstellungen', { headers: auth, data: {
    verkaufKasseId: login.kassen[0]!.id, agbUrl: null, datenschutzUrl: null, impressumUrl: null,
    kaufhinweis: 'Kein Rücktrittsrecht bei Veranstaltungen mit fixem Termin.',
  } })).ok()).toBe(true)
  const event = await (await request.post('/api/ticketing/events', { headers: auth, data: {
    titel, beginn: new Date(`${jahr}-10-17T20:00:00+02:00`).toISOString(), ort: 'Festzelt', status: 'veroeffentlicht', mindestalter: 16,
  } })).json() as { id: string }
  expect((await request.post(`/api/ticketing/events/${event.id}/arten`, { headers: auth, data: {
    bezeichnung: 'Stehplatz', preisCent: 1990, mwstSatz: 'ermaessigt2', kontingent: 10,
  } })).ok()).toBe(true)

  // ── Kauf am Handy ──
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${TICKET_APP}/e/${event.id}`)
  await expect(page.getByRole('heading', { name: titel })).toBeVisible()
  await expect(page.getByText('Einlass ab 16 Jahren · Ausweis mitnehmen')).toBeVisible()
  const mehr = page.getByRole('button', { name: 'Stehplatz mehr' })
  await mehr.click()
  await mehr.click()

  await page.getByLabel('Name (optional)').nth(0).fill('Anna Gast')
  await page.locator('input[type="date"]').nth(0).fill('1990-01-01')
  await page.getByLabel('Name (optional)').nth(1).fill('Ben Gast')
  await page.locator('input[type="date"]').nth(1).fill(`${jahr - 17}-01-01`)   // am Eventtag 17 → Band Gelb
  await page.getByLabel('Name', { exact: true }).fill('Karin Käuferin')
  await page.getByLabel('E-Mail', { exact: true }).fill('karin@example.at')
  await page.getByLabel('E-Mail wiederholen').fill('karin@example.at')
  await expect(page.getByText('Kein Rücktrittsrecht bei Veranstaltungen mit fixem Termin.')).toBeVisible()
  await page.getByRole('checkbox', { name: /Ich akzeptiere/ }).check()
  await page.getByRole('button', { name: 'Weiter zur Zahlung · € 39,80' }).click()

  // ── Bestellseite ──
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}$/)
  await expect(page.getByText('✓ Vielen Dank — Ihre Tickets')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Ticket öffnen' })).toHaveCount(2)
  await expect(page.getByText('Anna Gast')).toBeVisible()
  await expect(page.getByRole('link', { name: /Rechnung \(Beleg Nr\. \d+\)/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Alle Tickets als PDF/ })).toBeVisible()

  // ── Ticket von Ben: Band nach Alter am Eventtag ──
  await page.getByRole('listitem').filter({ hasText: 'Ben Gast' }).getByRole('link', { name: 'Ticket öffnen' }).click()
  await expect(page.getByText('Stehplatz (1 Person)')).toBeVisible()
  await expect(page.getByText('Band Gelb · 16–17 Jahre')).toBeVisible()
  await expect(page.getByText('gültig', { exact: true })).toBeVisible()

  // ── Backoffice: Reiter „Bestellungen" ──
  await page.addInitScript((d: { token: string; authJson: string; kasseId: string; mandantId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant: { ...login.mandant, modulTicketsAktiv: true }, kassen: login.kassen }),
    mandantId: login.mandant.id,
    kasseId: login.kassen[0]!.id,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/tickets/${event.id}`)
  await expect(page.getByText(`${TICKET_APP}/e/${event.id}`)).toBeVisible()
  await page.getByRole('button', { name: 'Bestellungen' }).click()
  await expect(page.getByText('1 bezahlt · 2 Tickets · € 39,80')).toBeVisible()
  await expect(page.getByRole('cell', { name: /Karin Käuferin/ })).toBeVisible()
  await expect(page.getByText(/^Beleg Nr\. \d+$/)).toBeVisible()
})
