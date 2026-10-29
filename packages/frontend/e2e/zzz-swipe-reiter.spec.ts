import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Wischen zwischen den Warengruppen: zusätzlich zu den Reiter-Tasten wechselt ein Wisch nach links/rechts im Artikel-Raster
 * den Reiter — links = der nächste, rechts = der vorherige, am Rand bleibt es stehen. Ein Tipp, ein senkrechter Zug (Scrollen)
 * und ein Wisch, der in der Reiter-Leiste beginnt (sie scrollt selbst), wechseln nichts.
 *
 * Die Wisch-Bewegung wird als echte Touch-Ereignisse (touchstart/touchend) auf das Raster geschickt.
 * Meldet über die API an und setzt die Anmeldung per Init-Skript. Legt zwei Warengruppen mit Artikeln an — am Ende aufgeräumt.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ serviceWorkers: 'block' })
test.setTimeout(120_000)

interface Login { token: string; user: unknown; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }

/** /api/auth/login ist auf 10 Anmeldungen je Minute begrenzt (429): abwarten statt fälschlich in /api/setup zu fallen. */
async function loginAbwarten(request: APIRequestContext) {
  const body = { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } }
  for (let versuch = 0; versuch < 6; versuch++) {
    const res = await request.post('/api/auth/login', body)
    if (res.status() !== 429) return res
    const sekunden = Math.min(Math.max(Number(res.headers()['retry-after']) || 10, 2), 65)
    await new Promise(r => setTimeout(r, sekunden * 1000))
  }
  return request.post('/api/auth/login', body)
}

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-SWIPE-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
  }
  return (await res.json()) as Login
}

async function anmelden(page: Page, login: Login, kasseId: string) {
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
    mandantId: login.mandant.id, kasseId,
  })
}

/** Ein Wisch als Touch-Ereignisse: Start an `von`, Ende an `bis`, beides auf dem Element `selektor`. */
async function wische(page: Page, selektor: string, von: { x: number; y: number }, bis: { x: number; y: number }) {
  await page.evaluate(({ selektor, von, bis }) => {
    const el = document.querySelector(selektor)!
    const ereignis = (typ: string, p: { x: number; y: number }) => {
      const t = new Touch({ identifier: 1, target: el, clientX: p.x, clientY: p.y })
      const ende = typ === 'touchend'
      return new TouchEvent(typ, {
        bubbles: true, cancelable: true,
        touches: ende ? [] : [t], targetTouches: ende ? [] : [t], changedTouches: [t],
      })
    }
    el.dispatchEvent(ereignis('touchstart', von))
    el.dispatchEvent(ereignis('touchend', bis))
  }, { selektor, von, bis })
}

test('Wischen im Raster wechselt die Warengruppe — links nächste, rechts vorherige, am Rand bleibt es stehen', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const p     = `Sw${Date.now() % 1_000_000}`

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }

  const getraenke = await post('/api/kategorien', { name: `${p} Getränke`, farbe: 'blau', reihenfolge: 7301 })
  const speisen   = await post('/api/kategorien', { name: `${p} Speisen`,  farbe: 'rot',  reihenfolge: 7302 })
  const dessert   = await post('/api/kategorien', { name: `${p} Dessert`,  farbe: 'gruen', reihenfolge: 7303 })
  const artikel = [
    await post('/api/artikel', { bezeichnung: `${p} Cola`,      preisBruttoCent: 320,  mwstSatz: 'normal', kategorieId: getraenke.id }),
    await post('/api/artikel', { bezeichnung: `${p} Schnitzel`, preisBruttoCent: 1450, mwstSatz: 'normal', kategorieId: speisen.id }),
    await post('/api/artikel', { bezeichnung: `${p} Torte`,     preisBruttoCent: 480,  mwstSatz: 'normal', kategorieId: dessert.id }),
  ]
  const kasse = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-SW-${p}`, bezeichnung: `${p} Wischkasse`, umgebung: 'test' })
  // Nur diese drei Gruppen, ohne Favoriten-Reiter: „erste Warengruppe" öffnet zuerst
  const cfg = await request.put(`/api/kassen/${kasse.kasseId}/pos-config`, {
    headers: auth, data: { sichtbareKategorieIds: [getraenke.id, speisen.id, dessert.id], startFavoriten: false, startKategorieId: null },
  })
  expect(cfg.ok(), await cfg.text()).toBe(true)

  const reiter = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) })
  const kachel = (name: string) => page.getByTestId('artikel-kachel').filter({ hasText: name })
  const GRID   = '[data-testid="artikel-grid"]'

  try {
    await anmelden(page, login, kasse.kasseId)
    await page.goto('/kasse')
    await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'true')
    await expect(kachel(`${p} Cola`)).toBeVisible()

    await test.step('Wisch nach links: nächste Warengruppe — danach noch eine', async () => {
      await wische(page, GRID, { x: 300, y: 300 }, { x: 140, y: 310 })
      await expect(reiter(`${p} Speisen`)).toHaveAttribute('aria-pressed', 'true')
      await expect(kachel(`${p} Schnitzel`)).toBeVisible()
      await expect(kachel(`${p} Cola`)).toHaveCount(0)
      await wische(page, GRID, { x: 300, y: 300 }, { x: 140, y: 300 })
      await expect(reiter(`${p} Dessert`)).toHaveAttribute('aria-pressed', 'true')
    })

    await test.step('am letzten Reiter bleibt es stehen', async () => {
      await wische(page, GRID, { x: 300, y: 300 }, { x: 100, y: 300 })
      await expect(reiter(`${p} Dessert`)).toHaveAttribute('aria-pressed', 'true')
    })

    await test.step('Wisch nach rechts: vorherige Warengruppe', async () => {
      await wische(page, GRID, { x: 100, y: 300 }, { x: 260, y: 305 })
      await expect(reiter(`${p} Speisen`)).toHaveAttribute('aria-pressed', 'true')
      await wische(page, GRID, { x: 100, y: 300 }, { x: 260, y: 300 })
      await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'true')
      // …und am ersten Reiter nach rechts: bleibt
      await wische(page, GRID, { x: 100, y: 300 }, { x: 260, y: 300 })
      await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'true')
    })

    await test.step('Scrollen (senkrechter Zug) und ein kurzes Zucken wechseln nichts', async () => {
      await wische(page, GRID, { x: 200, y: 200 }, { x: 150, y: 500 })
      await wische(page, GRID, { x: 200, y: 300 }, { x: 230, y: 300 })
      await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'true')
    })

    await test.step('ein Wisch in der Reiter-Leiste wechselt nichts (sie scrollt selbst)', async () => {
      await wische(page, '[data-swipe-aus] button', { x: 300, y: 100 }, { x: 140, y: 100 })
      await expect(reiter(`${p} Getränke`)).toHaveAttribute('aria-pressed', 'true')
    })

    await test.step('die Reiter-Tasten gehen weiter, und ein Tipp auf eine Kachel legt den Artikel in den Warenkorb', async () => {
      await reiter(`${p} Dessert`).click()
      await expect(kachel(`${p} Torte`)).toBeVisible()
      await kachel(`${p} Torte`).click()
      await expect(page.getByText(`${p} Torte`).first()).toBeVisible()
      await expect(reiter(`${p} Dessert`)).toHaveAttribute('aria-pressed', 'true')       // der Tipp ist kein Wisch
    })
  } finally {
    await request.post(`/api/kassen/${kasse.kasseId}/ausser-betrieb`, { headers: auth, data: {} })
    for (const a of artikel) await request.delete(`/api/artikel/${a.id}`, { headers: auth })
    for (const g of [getraenke, speisen, dessert]) await request.delete(`/api/kategorien/${g.id}`, { headers: auth })
  }
})
