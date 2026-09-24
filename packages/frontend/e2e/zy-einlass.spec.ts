import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Einlass-Journey im Handy-Format gegen das gebaute Bundle der Einlass-App
 * (Port 5182): Gerät über den Einrichtungs-Link verbinden → Event wählen →
 * Einzelticket einlassen (Band + Alter + Geburtsdatum) → zweiter Scan
 * „bereits eingelöst" → Crew-Mehrfachticket zweimal (Besucherzahl zählt einmal)
 * → unbekannter Code.
 *
 * Die Kamera gibt es im Testbrowser nicht — gescannt wird über das Eingabefeld,
 * genau wie ein Handscanner (Tastatur-Emulation) es tut.
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
        firmenname: 'E2E Einlass GmbH',
        uid:        'ATU87654328',
        kassenId:   'E2E-EINLASS-001',
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

test('Einlass-App: verbinden, einlassen mit Band, doppelt abgewiesen, Crew zählt einmal', async ({ page, request }) => {
  const { token } = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${token}` }
  const titel = `E2E Einlass ${Date.now()}`

  expect((await request.patch('/api/mandanten/module', { headers: auth, data: { modulTicketsAktiv: true } })).ok()).toBe(true)
  expect((await request.put('/api/ticketing/einstellungen', {
    headers: auth, data: { ticketBasisUrl: 'http://127.0.0.1:5181', einlassBasisUrl: EINLASS_APP },
  })).ok()).toBe(true)

  const event = await (await request.post('/api/ticketing/events', {
    headers: auth,
    data: { titel, ort: 'Kammersäle Leoben', beginn: new Date(Date.now() + 3600_000).toISOString(), status: 'test' },
  })).json() as { id: string }
  const art = await (await request.post(`/api/ticketing/events/${event.id}/arten`, {
    headers: auth, data: { bezeichnung: 'Buffet', preisCent: 4500, mwstSatz: 'ermaessigt1' },
  })).json() as { id: string }
  const anna = (await (await request.post(`/api/ticketing/events/${event.id}/tickets`, {
    headers: auth, data: { typ: 'einzel', ticketArtId: art.id, anzahl: 1, name: 'Anna Gast', geburtsdatum: '1990-05-01' },
  })).json()).tickets[0].code as string
  const crew = (await (await request.post(`/api/ticketing/events/${event.id}/tickets`, {
    headers: auth, data: { typ: 'mehrfach', rolle: 'Crew', anzahl: 1, name: 'Tom' },
  })).json()).tickets[0].code as string

  const geraet = await (await request.post('/api/ticketing/einlass-geraete', {
    headers: auth, data: { name: 'Einlass Nord' },
  })).json() as { url: string }
  expect(geraet.url.startsWith(`${EINLASS_APP}/?token=`)).toBe(true)

  // ── Gerät über den Einrichtungs-Link verbinden, Event wählen ──
  await page.goto(geraet.url)
  await expect(page.getByText('Für welches Event?')).toBeVisible()
  expect(page.url()).not.toContain('token=')        // Zugang sofort aus der Adresszeile entfernt
  await page.getByRole('button', { name: new RegExp(titel) }).click()
  await expect(page.getByText('Besucher', { exact: true })).toBeVisible()
  const zaehler = page.locator('header').getByText(/^\d+$/)
  await expect(zaehler).toHaveText('0')

  const eingabe = page.getByPlaceholder('Code eingeben oder Handscanner')
  const scanne = async (inhalt: string) => {
    await eingabe.fill(inhalt)
    await page.getByRole('button', { name: 'Prüfen' }).click()
  }
  const weiter = async () => {
    await page.getByText('Tippen für den nächsten Gast').click()
    await expect(page.getByText('Tippen für den nächsten Gast')).toBeHidden()
  }

  // ── Einzelticket (als Link aus dem QR) → Einlass mit Band, Alter, Geburtsdatum ──
  await scanne(`http://127.0.0.1:5181/t/${anna}`)
  await expect(page.getByText('✓ EINLASS')).toBeVisible()
  await expect(page.getByText('Band Grün')).toBeVisible()
  await expect(page.getByText('ab 18 Jahre')).toBeVisible()
  await expect(page.getByText('geb. 01.05.1990')).toBeVisible()
  await expect(page.getByText('Anna Gast')).toBeVisible()
  await weiter()
  await expect(zaehler).toHaveText('1')

  // ── derselbe Code nochmal → abgewiesen, mit Gerät ──
  await scanne(anna)
  await expect(page.getByText('✗ KEIN EINLASS')).toBeVisible()
  await expect(page.getByText('Bereits eingelöst')).toBeVisible()
  await expect(page.getByText(/^um \d{2}:\d{2} Uhr · Einlass Nord$/)).toBeVisible()
  await weiter()
  await expect(zaehler).toHaveText('1')

  // ── Crew: zweimal rein, Besucherzahl zählt einmal ──
  await scanne(crew)
  await expect(page.getByText('✓ MEHRFACHTICKET')).toBeVisible()
  await expect(page.getByText('Crew', { exact: true })).toBeVisible()
  await weiter()
  await expect(zaehler).toHaveText('2')

  await scanne(crew)
  await expect(page.getByText('2. Eintritt · zählt nicht erneut als Besucher')).toBeVisible()
  await weiter()
  await expect(zaehler).toHaveText('2')

  // ── unbekannter Code ──
  await scanne('abcdefghjkmnpqrs')
  await expect(page.getByText('Kein gültiges Ticket')).toBeVisible()
  await weiter()

  // ── Protokoll im Backoffice hat alle Scans ──
  const log = await (await request.get(`/api/ticketing/events/${event.id}/einlass-log`, { headers: auth })).json() as
    Array<{ ergebnis: string; geraetName: string }>
  expect(log.map(l => l.ergebnis)).toEqual(['unbekannt', 'mehrfach', 'mehrfach', 'bereits_eingeloest', 'zugelassen'])
  expect(log.every(l => l.geraetName === 'Einlass Nord')).toBe(true)
})
