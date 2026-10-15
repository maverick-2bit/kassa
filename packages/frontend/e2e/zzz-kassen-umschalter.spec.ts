import { randomUUID } from 'node:crypto'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Kassen-Schnellumschalter (Kopfleiste): dieses Gerät mit einem Klick auf eine andere Kasse umschalten.
 *
 *  - echter Wechsel zwischen Kassen: gespeicherte Kasse + Statuszeile, bleibt nach dem Neuladen, und zurück
 *  - in der Kasse (offener Warenkorb!) fragt der Wechsel vorher nach — „Abbrechen" lässt alles, „OK" wechselt
 *  - eingeklappte Kopfleiste: kompakter Umschalter statt der festen Kassen-Angabe
 *  - Aufbau: bis drei Kassen Knöpfe, ab vier eine Auswahlliste (Esc und Klick daneben schließen); stillgelegte fehlen
 *  - ohne Einstellungs-Recht: nur die zugeordneten Kassen — auch wenn es eine weitere in Betrieb gibt
 *
 * Liegt am Ende der Suite (zzz-): legt zwei Kassen und einen Benutzer an — am Schluss stillgelegt bzw. gelöscht.
 */

const ADMIN_EMAIL      = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT   = 'e2e-passwort-12345'
const KELLNER_EMAIL    = 'umschalter-kellner@test.at'
const KELLNER_PASSWORT = 'kellner-passwort-123'
const APP_URL          = 'http://127.0.0.1:5173'

test.use({ serviceWorkers: 'block' })
test.setTimeout(240_000)

type Login = { token: string; user: { id: string }; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }
interface KasseListe {
  id: string; kassenId: string; bezeichnung: string | null; status: string; umgebung: string
  seeGueltigBis: string; beiFoRegistriert: boolean; ausserBetriebAm: string | null
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

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await loginAbwarten(request, ADMIN_EMAIL, ADMIN_PASSWORT)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-UMS-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request, ADMIN_EMAIL, ADMIN_PASSWORT)
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return (await res.json()) as Login
}

/**
 * Meldet die Seite an. Das Init-Skript läuft bei JEDEM Laden — die Kasse darf es nur beim allerersten setzen,
 * sonst würde es jeden Kassenwechsel (Seite lädt neu) sofort wieder zurücknehmen.
 */
async function anmelden(page: Page, login: Login, kasseId: string) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    if (localStorage.getItem('kassa:token')) return
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId,
  })
}

/** Die Kasse dieses Geräts, wie sie im Speicher steht (null mitten im Neuladen). */
async function kasseImSpeicher(page: Page): Promise<string | null> {
  try { return await page.evaluate(() => localStorage.getItem('kassa:kasseId')) } catch { return null }
}

/** Schaltet über die Kopfleiste um — Knopf-Gruppe oder Auswahlliste, je nachdem, wie viele Kassen es gibt. */
async function umschaltenAuf(page: Page, kassenId: string) {
  await expect(page.getByTestId('kassen-umschalter')).toBeVisible()
  const eintrag = page.getByTestId(`kassen-umschalter-${kassenId}`)
  if (!(await eintrag.isVisible())) await page.getByTestId('kassen-umschalter').click()     // Auswahlliste aufklappen
  await eintrag.click()
}

test('Kassen-Umschalter: ein Klick auf die andere Kasse, Rückfrage in der Kasse, Auswahlliste ab vier, nur zugeordnete Kassen', async ({ page, request, browser }) => {
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const p = `Um${Date.now() % 1_000_000}`

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const get = async <T>(url: string): Promise<T> => {
    const res = await request.get(url, { headers: auth })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }

  const aufraeumen: (() => Promise<unknown>)[] = []
  try {
    // ---- Testdaten: zwei weitere Kassen; „A" ist die Kasse, mit der sich dieses Gerät anmeldet ----
    const neuB = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-UB-${p}`, bezeichnung: `${p} Bar`, umgebung: 'test' })
    aufraeumen.push(() => request.post(`/api/kassen/${neuB.kasseId}/ausser-betrieb`, { headers: auth, data: {} }))
    const neuC = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-UC-${p}`, bezeichnung: `${p} Kuchen`, umgebung: 'test' })
    aufraeumen.push(() => request.post(`/api/kassen/${neuC.kasseId}/ausser-betrieb`, { headers: auth, data: {} }))

    const liste = await get<KasseListe[]>('/api/kassen')
    const kasse = (id: string): KasseListe => {
      const k = liste.find(x => x.id === id)
      if (!k) throw new Error(`Kasse ${id} fehlt in /api/kassen`)
      return k
    }
    const A = kasse(login.kassen[0]!.id)
    const B = kasse(neuB.kasseId)
    const C = kasse(neuC.kasseId)
    const name = (k: KasseListe) => k.bezeichnung || k.kassenId

    await anmelden(page, login, A.id)
    await page.goto('/belege')

    // =================================================================================
    // 1. Ein Klick schaltet um — und der Wechsel überlebt das Neuladen
    // =================================================================================
    await test.step('ein Klick schaltet dieses Gerät auf die andere Kasse — und zurück', async () => {
      await expect(page.getByTestId('kassen-umschalter')).toBeVisible()
      await expect(page.getByTestId('status-kasse')).toHaveText(name(A))

      await umschaltenAuf(page, B.kassenId)
      await expect.poll(() => kasseImSpeicher(page)).toBe(B.id)
      await expect(page.getByTestId('status-kasse')).toHaveText(name(B))        // Statuszeile unten, nach dem Neuladen

      await page.reload()                                                        // die Anmeldung setzt die Kasse nicht zurück
      await expect(page.getByTestId('status-kasse')).toHaveText(name(B))
      expect(await kasseImSpeicher(page)).toBe(B.id)

      await umschaltenAuf(page, A.kassenId)
      await expect.poll(() => kasseImSpeicher(page)).toBe(A.id)
      await expect(page.getByTestId('status-kasse')).toHaveText(name(A))
    })

    // =================================================================================
    // 2. In der Kasse geht beim Wechsel ein Warenkorb verloren → vorher nachfragen
    // =================================================================================
    await test.step('in der Kasse fragt der Wechsel vorher nach — Abbrechen lässt alles, OK wechselt', async () => {
      await page.goto('/kasse')
      await expect(page.getByTestId('kassen-umschalter')).toBeVisible()

      const frage = new Promise<string>(resolve => page.once('dialog', d => { resolve(d.message()); void d.dismiss() }))
      await umschaltenAuf(page, B.kassenId)
      const text = await frage
      expect(text).toContain(`„${name(B)}"`)
      expect(text).toContain('Warenkorb')
      expect(await kasseImSpeicher(page)).toBe(A.id)                             // abgebrochen: nichts geändert
      await expect(page).toHaveURL(/\/kasse$/)

      page.once('dialog', d => void d.accept())
      await umschaltenAuf(page, B.kassenId)
      await expect.poll(() => kasseImSpeicher(page)).toBe(B.id)
      await expect(page).toHaveURL(/\/kasse$/)                                   // bleibt auf der Kassen-Seite
    })

    // =================================================================================
    // 3. Eingeklappte Kopfleiste: kompakter Umschalter statt der festen Kassen-Angabe
    // =================================================================================
    await test.step('eingeklappte Kopfleiste zeigt den kompakten Umschalter', async () => {
      await page.evaluate(() => localStorage.setItem('kassa:kopfleisteEingeklappt', '1'))
      await page.goto('/belege')
      await expect(page.getByRole('button', { name: /Menü/ })).toBeVisible()      // „☰ Menü" = eingeklappt
      await expect(page.getByTestId('kassen-umschalter')).toBeVisible()
      await expect(page.locator('header').first()).not.toContainText('Kasse:')    // die feste Angabe ist ersetzt

      await umschaltenAuf(page, A.kassenId)                                      // Übersicht ohne Warenkorb → keine Rückfrage
      await expect.poll(() => kasseImSpeicher(page)).toBe(A.id)

      await page.evaluate(() => localStorage.removeItem('kassa:kopfleisteEingeklappt'))
    })

    // =================================================================================
    // 4. Aufbau: bis drei Kassen Knöpfe, ab vier eine Auswahlliste (feste Liste per Mock)
    // =================================================================================
    const attrappe = (n: number, status = 'aktiv'): KasseListe => ({
      id: randomUUID(), kassenId: `MOCK-${n}`, bezeichnung: `${p} Mock ${n}`, status, umgebung: 'test',
      seeGueltigBis: '2030-01-01', beiFoRegistriert: false, ausserBetriebAm: status === 'aktiv' ? null : '2026-01-01T00:00:00.000Z',
    })
    const listeMocken = async (eintraege: KasseListe[]) => {
      await page.unroute('**/api/kassen')
      await page.route('**/api/kassen', route =>
        route.request().method() === 'GET' ? route.fulfill({ json: eintraege }) : route.fallback())
    }

    await test.step('zwei Kassen in Betrieb: Knöpfe, die aktive Kasse ist hervorgehoben, stillgelegte fehlen', async () => {
      await listeMocken([A, B, attrappe(1, 'ausser_betrieb')])
      await page.goto('/belege')
      const gruppe = page.getByTestId('kassen-umschalter')
      await expect(gruppe).toHaveAttribute('role', 'group')
      await expect(gruppe.getByRole('button')).toHaveCount(2)
      await expect(page.getByTestId('kassen-umschalter-MOCK-1')).toHaveCount(0)
      await expect(page.getByTestId(`kassen-umschalter-${A.kassenId}`)).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId(`kassen-umschalter-${B.kassenId}`)).toHaveAttribute('aria-pressed', 'false')
    })

    await test.step('vier und mehr Kassen: Auswahlliste — Esc und Klick daneben schließen, ein Klick wählt', async () => {
      await listeMocken([A, B, attrappe(1), attrappe(2), attrappe(3), attrappe(4, 'ausser_betrieb')])
      await page.goto('/belege')
      const knopf = page.getByTestId('kassen-umschalter')
      await expect(knopf).toHaveAttribute('aria-haspopup', 'listbox')
      await expect(knopf).toContainText(name(A))                                // zeigt die aktive Kasse
      const auswahl = page.getByRole('listbox', { name: 'Kasse wählen' })
      await expect(auswahl).toHaveCount(0)

      await knopf.click()
      await expect(auswahl.getByRole('option')).toHaveCount(5)                  // 5 in Betrieb, die stillgelegte fehlt
      await expect(auswahl.getByRole('option', { selected: true })).toContainText(name(A))
      await page.keyboard.press('Escape')
      await expect(auswahl).toHaveCount(0)

      await knopf.click()
      await expect(auswahl).toBeVisible()
      await page.locator('body').click({ position: { x: 3, y: 3 } })             // irgendwo daneben
      await expect(auswahl).toHaveCount(0)

      await knopf.click()
      await auswahl.getByTestId(`kassen-umschalter-${B.kassenId}`).click()
      await expect.poll(() => kasseImSpeicher(page)).toBe(B.id)
      await expect(page.getByTestId('kassen-umschalter')).toContainText(name(B))
      await page.unroute('**/api/kassen')
    })

    // =================================================================================
    // 5. Ohne Einstellungs-Recht: nur die zugeordneten Kassen
    // =================================================================================
    await test.step('ohne Einstellungs-Recht nur die zugeordneten Kassen — die dritte bleibt unsichtbar', async () => {
      // Reste eines früheren Versuchs entfernen, dann einen Kellner mit Zugriff auf A und B (nicht C) anlegen
      for (const u of (await get<{ id: string; email: string | null }[]>('/api/users')).filter(x => x.email === KELLNER_EMAIL)) {
        await request.delete(`/api/users/${u.id}`, { headers: auth })
      }
      const kellner = await post<{ id: string }>('/api/users', {
        name: 'Umschalter Kellner', email: KELLNER_EMAIL, passwort: KELLNER_PASSWORT,
        rolle: 'kellner', berechtigungen: ['belege.lesen'], kassenIds: [A.id, B.id],
      })
      aufraeumen.push(() => request.delete(`/api/users/${kellner.id}`, { headers: auth }))
      const res = await loginAbwarten(request, KELLNER_EMAIL, KELLNER_PASSWORT)
      expect(res.ok(), `Kellner-Login: ${await res.text()}`).toBe(true)
      const kellnerLogin = (await res.json()) as Login
      expect(kellnerLogin.kassen.map(k => k.id).sort()).toEqual([A.id, B.id].sort())

      const kontext = await browser.newContext({ baseURL: APP_URL, serviceWorkers: 'block' })
      aufraeumen.push(() => kontext.close())
      const seite = await kontext.newPage()
      await anmelden(seite, kellnerLogin, A.id)
      await seite.goto('/belege')

      const gruppe = seite.getByTestId('kassen-umschalter')
      await expect(gruppe).toBeVisible()
      await expect(gruppe.getByRole('button')).toHaveCount(2)
      await expect(seite.getByTestId(`kassen-umschalter-${A.kassenId}`)).toBeVisible()
      await expect(seite.getByTestId(`kassen-umschalter-${B.kassenId}`)).toBeVisible()
      await expect(seite.getByTestId(`kassen-umschalter-${C.kassenId}`)).toHaveCount(0)   // C ist in Betrieb, aber nicht zugeordnet

      // der Wechsel geht auch ohne Einstellungs-Recht
      await seite.getByTestId(`kassen-umschalter-${B.kassenId}`).click()
      await expect.poll(() => kasseImSpeicher(seite)).toBe(B.id)
      await expect(seite.getByTestId('status-kasse')).toHaveText(name(B))
    })
  } finally {
    // ---- aufräumen (rückwärts): Kontext schließen, Benutzer löschen, Kassen stilllegen ----
    for (const schritt of aufraeumen.reverse()) await schritt().catch(() => undefined)
  }
})
