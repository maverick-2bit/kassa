import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Ticketing-Journey: Event im Backoffice anlegen → Ticketart → Einzelticket mit
 * Geburtsdatum + Crew-Mehrfachtickets ausstellen → öffentliche Ticketseite in der
 * Ticket-App (gebautes Bundle, Port 5181) → nach Storno „storniert".
 *
 * zy-Präfix: läuft nach dem Onboarding (braucht die eingerichtete Instanz), vor
 * der Kellner-Journey. Solo-Läufe richten die Instanz notfalls selbst ein.
 */

const TICKET_APP     = 'http://127.0.0.1:5181'
const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Ticket GmbH',
        uid:        'ATU87654329',
        kassenId:   'E2E-TICKET-001',
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

test('Ticketing: Event anlegen, Tickets ausstellen, Ticketseite zeigt Band + Status', async ({ page, request }) => {
  const login  = await adminLogin(request)
  const auth   = { Authorization: `Bearer ${login.token}` }
  const titel  = `E2E Buffet ${Date.now()}`
  const jahr   = new Date().getFullYear() + 1

  // Modul + Ticket-Adresse per API (Einstellungen sind nicht Gegenstand dieses Tests)
  expect((await request.patch('/api/mandanten/module', { headers: auth, data: { modulTicketsAktiv: true } })).ok()).toBe(true)
  expect((await request.put('/api/ticketing/einstellungen', { headers: auth, data: { ticketBasisUrl: TICKET_APP } })).ok()).toBe(true)

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

  // ── Event anlegen ──
  await page.goto('/tickets')
  await page.getByRole('button', { name: '+ Neues Event' }).click()
  await page.getByPlaceholder('z. B. Sommerfest 2026').fill(titel)
  await page.locator('input[type="datetime-local"]').first().fill(`${jahr}-06-20T19:00`)
  await page.getByPlaceholder('z. B. Kammersäle Leoben').fill('Kammersäle Leoben')
  await page.getByPlaceholder('z. B. Motto: wird am Abend enthüllt').fill('Motto: wird noch enthüllt')
  await page.getByRole('dialog').getByRole('combobox').selectOption('test')
  await page.getByRole('button', { name: 'Event anlegen' }).click()

  await expect(page.getByRole('heading', { name: titel })).toBeVisible()
  await expect(page.getByText('Besucher jetzt')).toBeVisible()
  const eventId = page.url().split('/tickets/')[1]!

  // ── Ticketart ──
  await page.getByRole('button', { name: 'Ticketarten' }).click()
  await page.getByRole('button', { name: '+ Ticketart' }).click()
  await page.getByRole('dialog').locator('input').first().fill('Buffet')
  await page.getByPlaceholder('0,00').fill('45,00')
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('0 ausgegeben · unbegrenzt')).toBeVisible()

  // ── Einzelticket mit Geburtsdatum (volljährig → Grün) ──
  await page.getByRole('button', { name: 'Tickets', exact: true }).last().click()
  await page.getByRole('button', { name: '+ Tickets ausstellen' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type="date"]').fill('1990-05-01')
  await dialog.locator('input:not([type])').first().fill('Anna Gast')
  await dialog.getByRole('button', { name: 'Ticket ausstellen' }).click()
  await expect(dialog.getByText('✓ 1 Ticket ausgestellt.')).toBeVisible()

  // ── Crew-Mehrfachtickets ──
  await dialog.getByRole('button', { name: 'Weitere ausstellen' }).click()
  await dialog.getByText('Mehrfachticket', { exact: true }).click()
  await dialog.locator('input[type="number"]').fill('2')
  await dialog.getByRole('button', { name: '2 Tickets ausstellen' }).click()
  await expect(dialog.getByText('✓ 2 Tickets ausgestellt.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Fertig' }).click()

  await expect(page.getByText('Crew · Mehrfachticket')).toHaveCount(2)
  await expect(page.getByRole('cell', { name: /Buffet \(1 Person\)/ })).toBeVisible()
  await expect(page.getByText('Grün', { exact: true }).first()).toBeVisible()

  // ── Öffentliche Ticketseite in der Ticket-App ──
  const liste = await (await request.get(`/api/ticketing/events/${eventId}/tickets`, { headers: auth })).json() as
    Array<{ id: string; code: string; typ: string; url: string }>
  const einzel = liste.find(t => t.typ === 'einzel')!
  expect(einzel.url).toBe(`${TICKET_APP}/t/${einzel.code}`)

  await page.goto(einzel.url)
  await expect(page.getByText('Interner Test · nicht veröffentlichen')).toBeVisible()
  await expect(page.getByRole('heading', { name: titel })).toBeVisible()
  await expect(page.getByText('Motto: wird noch enthüllt')).toBeVisible()
  await expect(page.getByText('Buffet (1 Person)')).toBeVisible()
  await expect(page.getByText('Band Grün · ab 18 Jahre')).toBeVisible()
  await expect(page.getByText('gültig', { exact: true })).toBeVisible()
  await expect(page.getByText(einzel.code, { exact: true })).toBeVisible()
  await expect(page.getByText('Nur 1× gültig.', { exact: true })).toBeVisible()
  for (const knopf of ['WhatsApp', 'E-Mail', 'PDF (A4)', 'Als Foto speichern']) {
    await expect(page.getByText(knopf).first()).toBeVisible()
  }
  // Datenschutz: das Geburtsdatum steht NICHT auf der weiterleitbaren Seite
  await expect(page.getByText('1990')).toHaveCount(0)

  const pdf = await request.get(`${TICKET_APP}/api/ticketshop/ticket/${einzel.code}/pdf`)
  expect(pdf.headers()['content-type']).toBe('application/pdf')

  // ── Storno → Ticketseite zeigt es ──
  expect((await request.post(`/api/ticketing/tickets/${einzel.id}/stornieren`, { headers: auth })).ok()).toBe(true)
  await page.reload()
  await expect(page.getByText('storniert', { exact: true })).toBeVisible()
  await expect(page.getByText('Dieses Ticket wurde storniert und gilt nicht mehr.')).toBeVisible()
})
