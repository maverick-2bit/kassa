import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Offline-Verkauf an der Kasse — echter Service Worker im gebauten Bundle (vite preview).
 *
 * Prüfbericht 2026-11 (RKSV): Die Warteschlange speicherte den Login-Token, sendete ohne
 * Idempotenz-Schlüssel nach (Doppelbeleg bei verlorener Antwort) und löschte einen abgelehnten
 * Verkauf still. Jetzt: Verkauf offline gepuffert → nach der Rückkehr GENAU EIN Beleg (Token
 * holt der SW frisch von der Seite); ein abgelehnter Verkauf bleibt sichtbar, bis der Kassier
 * ihn verwirft.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ viewport: { width: 1280, height: 800 } })   // Service Worker bewusst NICHT blockiert

type Login = { token: string; mandant: { id: string }; kassen: { id: string }[] }
type Beleg = { id: string; positionen: Array<{ bezeichnung: string }> }

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Offline-Verkauf GmbH',
        uid:        'ATU87654333',
        kassenId:   'E2E-OFF-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test',
        admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', {
      data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return res.json() as Promise<Login>
}

async function anmelden(page: Page, request: APIRequestContext, login: Login) {
  const ich = await (await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${login.token}` },
  })).json() as { user: unknown; mandant: { id: string }; kassen: { id: string }[] }
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:     login.token,
    authJson:  JSON.stringify(ich),
    mandantId: ich.mandant.id,
    kasseId:   login.kassen[0]!.id,
  })
}

/**
 * Kasse öffnen, bis der Service Worker die Seite kontrolliert — dann einmal neu laden, damit
 * Artikel & Co. über ihn laufen und für offline im Cache liegen (wie an einer Kasse im Betrieb).
 */
async function kasseMitServiceWorker(page: Page, bezeichnung: string) {
  await page.goto('/kasse')
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 20_000 })
  await page.reload()
  await page.getByPlaceholder(/Artikel suchen/).fill(bezeichnung)
  await expect(page.getByRole('button', { name: bezeichnung }).first()).toBeVisible()
  await page.getByPlaceholder(/Artikel suchen/).fill('')
}

async function inDenKorb(page: Page, bezeichnung: string) {
  const suche = page.getByPlaceholder(/Artikel suchen/)
  await suche.fill(bezeichnung)
  await page.getByRole('button', { name: bezeichnung }).first().click()
  await suche.fill('')
  await expect(page.getByTitle('Menge eingeben')).toHaveCount(1)
}

let login: Login
let auth: { Authorization: string }
let kasseId: string

test.beforeAll(async ({ request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)
  login   = await adminLogin(request)
  auth    = { Authorization: `Bearer ${login.token}` }
  kasseId = login.kassen[0]!.id
})

async function belegeMit(request: APIRequestContext, bezeichnung: string): Promise<Beleg[]> {
  const liste = await (await request.get(`/api/belege?kasseId=${kasseId}&limit=200`, { headers: auth })).json() as Beleg[]
  return liste.filter(b => b.positionen.some(p => p.bezeichnung === bezeichnung))
}

test('offline verkauft → nach der Rückkehr genau ein Beleg', async ({ page, context, request }) => {
  const artikel = await (await request.post('/api/artikel', {
    headers: auth,
    data: { bezeichnung: `Offline-Semmel ${Date.now() % 100000}`, preisBruttoCent: 130, mwstSatz: 'normal' },
  })).json() as { id: string; bezeichnung: string }

  try {
    await anmelden(page, request, login)
    await kasseMitServiceWorker(page, artikel.bezeichnung)

    await context.setOffline(true)
    await inDenKorb(page, artikel.bezeichnung)
    await page.getByRole('button', { name: /^Bar \(/ }).click()
    await expect(page.getByText(/Verkauf offline gespeichert/)).toBeVisible()
    await expect(page.getByText('1 Verkauf in Warteschlange')).toBeVisible()
    expect(await belegeMit(request, artikel.bezeichnung)).toHaveLength(0)

    // Der Service Worker speichert den Login-Token nicht mit
    const gespeichert = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const req = indexedDB.open('kassa-sw-db')
      req.onsuccess = () => {
        const all = req.result.transaction('offline-queue', 'readonly').objectStore('offline-queue').getAll()
        all.onsuccess = () => resolve(JSON.stringify(all.result))
        all.onerror   = () => reject(all.error)
      }
      req.onerror = () => reject(req.error)
    }))
    expect(gespeichert).toContain('idempotency-key')
    expect(gespeichert).not.toContain(login.token)
    expect(gespeichert.toLowerCase()).not.toContain('authorization')

    await context.setOffline(false)
    await expect.poll(async () => (await belegeMit(request, artikel.bezeichnung)).length, { timeout: 25_000 }).toBe(1)
    await expect(page.getByText('1 Verkauf in Warteschlange')).toBeHidden()

    // Ein weiterer Nachsende-Anstoß bucht nichts doppelt
    await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: 'SYNC_NOW' }))
    await page.waitForTimeout(1_500)
    expect(await belegeMit(request, artikel.bezeichnung)).toHaveLength(1)
  } finally {
    await context.setOffline(false)
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
  }
})

test('beim Nachbuchen abgelehnt → bleibt sichtbar, bis der Kassier ihn verwirft', async ({ page, context, request }) => {
  const artikel = await (await request.post('/api/artikel', {
    headers: auth,
    data: { bezeichnung: `Offline-Kipferl ${Date.now() % 100000}`, preisBruttoCent: 170, mwstSatz: 'normal' },
  })).json() as { id: string; bezeichnung: string }

  try {
    await anmelden(page, request, login)
    await kasseMitServiceWorker(page, artikel.bezeichnung)

    await context.setOffline(true)
    await inDenKorb(page, artikel.bezeichnung)
    await page.getByRole('button', { name: /^Bar \(/ }).click()
    await expect(page.getByText(/Verkauf offline gespeichert/)).toBeVisible()

    // Während die Kasse offline ist, nimmt das Backoffice den Artikel aus dem Sortiment
    expect((await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })).ok()).toBe(true)

    await context.setOffline(false)
    const banner = page.getByTestId('offline-abgelehnt')
    await expect(banner).toHaveText(/1 offline erfasster Verkauf wurde nicht gebucht/, { timeout: 25_000 })
    expect(await belegeMit(request, artikel.bezeichnung)).toHaveLength(0)

    await banner.getByRole('button', { name: 'Anzeigen' }).click()
    const zeile = page.getByTestId('abgelehnter-verkauf')
    await expect(zeile).toContainText('1,70')
    await expect(zeile).toContainText(/nicht \(mehr\) verfügbar/)

    // Erneut senden: dasselbe Ergebnis, der Verkauf bleibt stehen (kein stilles Löschen)
    await zeile.getByRole('button', { name: 'Erneut senden' }).click()
    await page.waitForTimeout(1_500)
    await expect(zeile).toHaveCount(1)

    await zeile.getByRole('button', { name: 'Verwerfen' }).click()
    await zeile.getByRole('button', { name: 'Endgültig verwerfen' }).click()
    await expect(banner).toBeHidden()
    expect(await belegeMit(request, artikel.bezeichnung)).toHaveLength(0)
  } finally {
    await context.setOffline(false)
    await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
  }
})

test.describe('Antwort geht verloren (ohne Service Worker, der Server hat schon gebucht)', () => {
  test.use({ serviceWorkers: 'block' })   // page.route sieht nur Anfragen ohne Service Worker

  /** Die nächste Verkaufs-Antwort kommt nicht an: der Server bucht, der Browser sieht einen Netzfehler */
  async function naechsteAntwortVerlieren(page: Page) {
    let verloren = false
    await page.route('**/api/belege/barzahlung', async (route) => {
      if (verloren) return route.fallback()
      verloren = true
      await route.fetch()          // beim Backend angekommen und gebucht …
      await route.abort('failed')  // … aber die Antwort erreicht die Kasse nie
    })
  }

  test('derselbe Warenkorb erneut kassiert → genau ein Beleg', async ({ page, request }) => {
    const artikel = await (await request.post('/api/artikel', {
      headers: auth,
      data: { bezeichnung: `Verloren-Kaffee ${Date.now() % 100000}`, preisBruttoCent: 320, mwstSatz: 'normal' },
    })).json() as { id: string; bezeichnung: string }
    try {
      await anmelden(page, request, login)
      await page.goto('/kasse')
      await inDenKorb(page, artikel.bezeichnung)
      await naechsteAntwortVerlieren(page)

      await page.getByRole('button', { name: /^Bar \(/ }).click()
      await expect.poll(async () => (await belegeMit(request, artikel.bezeichnung)).length).toBe(1)
      await expect(page.getByTitle('Menge eingeben')).toHaveCount(1)   // Kasse hält den Korb (Fehler)
      // Die Kasse warnt: vielleicht schon gebucht — erst nachsehen, nicht mit geändertem Korb neu kassieren
      await expect(page.getByText(/Keine Antwort von der Kassa — der Verkauf ist möglicherweise schon gebucht/)).toBeVisible()

      await page.getByRole('button', { name: /^Bar \(/ }).click()
      await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
      expect(await belegeMit(request, artikel.bezeichnung)).toHaveLength(1)
    } finally {
      await request.delete(`/api/artikel/${artikel.id}`, { headers: auth })
    }
  })

  test('danach Korb verworfen und anderes kassiert → eigener Beleg, nicht der alte als „Erfolg"', async ({ page, request }) => {
    const stamp = Date.now() % 100000
    const erst = await (await request.post('/api/artikel', {
      headers: auth, data: { bezeichnung: `Verloren-Tee ${stamp}`, preisBruttoCent: 280, mwstSatz: 'normal' },
    })).json() as { id: string; bezeichnung: string }
    const dann = await (await request.post('/api/artikel', {
      headers: auth, data: { bezeichnung: `Neu-Kakao ${stamp}`, preisBruttoCent: 350, mwstSatz: 'normal' },
    })).json() as { id: string; bezeichnung: string }
    try {
      await anmelden(page, request, login)
      await page.goto('/kasse')
      await inDenKorb(page, erst.bezeichnung)
      await naechsteAntwortVerlieren(page)
      await page.getByRole('button', { name: /^Bar \(/ }).click()
      await expect.poll(async () => (await belegeMit(request, erst.bezeichnung)).length).toBe(1)

      page.once('dialog', d => d.accept())
      await page.getByRole('button', { name: /Alles verwerfen/ }).click()
      await expect(page.getByTitle('Menge eingeben')).toHaveCount(0)
      await inDenKorb(page, dann.bezeichnung)
      await page.getByRole('button', { name: /^Bar \(/ }).click()
      await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })

      expect(await belegeMit(request, dann.bezeichnung)).toHaveLength(1)
      expect(await belegeMit(request, erst.bezeichnung)).toHaveLength(1)
    } finally {
      await request.delete(`/api/artikel/${erst.id}`, { headers: auth })
      await request.delete(`/api/artikel/${dann.id}`, { headers: auth })
    }
  })
})
