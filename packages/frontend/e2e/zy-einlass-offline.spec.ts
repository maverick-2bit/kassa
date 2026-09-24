import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Offline-Einlass (Release 4) im Handy-Format gegen das gebaute Bundle der
 * Einlass-App (Port 5182): Gerät verbinden → Offline-Liste lädt → Netz weg →
 * einlassen/abweisen aus der Liste (mit „OFFLINE geprüft") → derweil lässt ein
 * zweiter Eingang ein Ticket online ein → Netz wieder da → Scans werden
 * nachgereicht, die Kopie kommt als Konflikt zurück (App + Protokoll).
 */

const EINLASS_APP    = 'http://127.0.0.1:5182'
const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Offline GmbH',
        uid:        'ATU87654331',
        kassenId:   'E2E-OFFLINE-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test',
        admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return res.json() as Promise<{ token: string }>
}

test('Einlass offline: Liste laden, ohne Netz prüfen, nachreichen, Kopie als Konflikt', async ({ page, context, request }) => {
  const { token } = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${token}` }
  const titel = `E2E Offline ${Date.now()}`

  expect((await request.patch('/api/mandanten/module', { headers: auth, data: { modulTicketsAktiv: true } })).ok()).toBe(true)
  expect((await request.put('/api/ticketing/einstellungen', {
    headers: auth, data: { ticketBasisUrl: 'http://127.0.0.1:5181', einlassBasisUrl: EINLASS_APP },
  })).ok()).toBe(true)
  const event = await (await request.post('/api/ticketing/events', {
    headers: auth, data: { titel, ort: 'Festwiese', beginn: new Date(Date.now() + 3600_000).toISOString(), status: 'test' },
  })).json() as { id: string }
  const art = await (await request.post(`/api/ticketing/events/${event.id}/arten`, {
    headers: auth, data: { bezeichnung: 'Eintritt', preisCent: 0, mwstSatz: 'ermaessigt2' },
  })).json() as { id: string }
  const ticket = async (name: string) => (await (await request.post(`/api/ticketing/events/${event.id}/tickets`, {
    headers: auth, data: { typ: 'einzel', ticketArtId: art.id, anzahl: 1, name, geburtsdatum: '1990-05-01' },
  })).json()).tickets[0].code as string
  const anna = await ticket('Anna Offline')
  const ben  = await ticket('Ben Kopie')

  const sued = await (await request.post('/api/ticketing/einlass-geraete', { headers: auth, data: { name: 'Einlass Süd' } })).json() as { url: string }
  const nord = await (await request.post('/api/ticketing/einlass-geraete', { headers: auth, data: { name: 'Einlass Nord' } })).json() as { token: string }

  // ── Gerät verbinden, Event wählen, Offline-Liste lädt ──
  await page.goto(sued.url)
  await page.getByRole('button', { name: new RegExp(titel) }).click()
  await expect(page.getByText(/Offline-Liste bereit \(2 Tickets/)).toBeVisible()

  const eingabe = page.getByPlaceholder('Code eingeben oder Handscanner')
  const scanne = async (inhalt: string) => {
    await eingabe.fill(inhalt)
    await page.getByRole('button', { name: 'Prüfen' }).click()
  }
  const weiter = async () => {
    await page.getByText('Tippen für den nächsten Gast').click()
    await expect(page.getByText('Tippen für den nächsten Gast')).toBeHidden()
  }

  // ── Netz weg ──
  await context.setOffline(true)

  await scanne(`http://127.0.0.1:5181/t/${anna}`)
  await expect(page.getByText('✓ EINLASS')).toBeVisible()
  await expect(page.getByText(/^OFFLINE geprüft/)).toBeVisible()
  await expect(page.getByText('Band Grün')).toBeVisible()
  await expect(page.getByText('Anna Offline')).toBeVisible()
  await weiter()

  // dieselbe Kopie am selben Gerät → die Liste auf dem Gerät weiß es schon
  await scanne(anna)
  await expect(page.getByText('✗ KEIN EINLASS')).toBeVisible()
  await expect(page.getByText('Bereits eingelöst')).toBeVisible()
  await weiter()

  // Derweil lässt der Nord-Eingang (online) Ben ein — Süd weiß davon nichts
  const nordScan = await request.post('/api/einlass/scan', {
    headers: { Authorization: `Bearer ${nord.token}` }, data: { eventId: event.id, inhalt: ben },
  })
  expect((await nordScan.json()).ergebnis).toBe('zugelassen')

  await scanne(ben)
  await expect(page.getByText('✓ EINLASS')).toBeVisible()   // offline nicht erkennbar
  await weiter()

  await scanne('abcdefghjkmnpqrs')
  await expect(page.getByText('Kein gültiges Ticket')).toBeVisible()
  await expect(page.getByText(/Nicht in der Offline-Liste/)).toBeVisible()
  await weiter()

  await expect(page.getByText(/OFFLINE — geprüft wird mit der Liste von/)).toBeVisible()
  await expect(page.getByText(/4 Scans warten aufs Nachreichen/)).toBeVisible()

  // ── Netz wieder da → nachreichen, Konflikt ──
  await context.setOffline(false)
  const konflikt = page.getByRole('button', { name: /1 Konflikt beim Nachreichen/ })
  await expect(konflikt).toBeVisible({ timeout: 25_000 })
  await expect(page.locator('header').getByText(/^\d+$/)).toHaveText('2')   // Anna + Ben, jetzt vom Server
  await konflikt.click()
  const dialog = page.getByRole('dialog', { name: 'Konflikte' })
  await expect(dialog.getByText('Bereits eingelöst')).toBeVisible()
  await expect(dialog.getByText(/Ben Kopie · zuerst um \d{2}:\d{2} Uhr \(Einlass Nord\)/)).toBeVisible()
  await page.getByRole('button', { name: 'Gesehen' }).click()
  await expect(konflikt).toBeHidden()

  // ── Protokoll im Backoffice ──
  const log = await (await request.get(`/api/ticketing/events/${event.id}/einlass-log`, { headers: auth })).json() as
    Array<{ ergebnis: string; geraetName: string; offline: boolean; konflikt: boolean }>
  const sueds = log.filter(l => l.geraetName === 'Einlass Süd')
  expect(sueds).toHaveLength(4)
  expect(sueds.every(l => l.offline)).toBe(true)
  expect(sueds.filter(l => l.konflikt)).toHaveLength(1)
})
