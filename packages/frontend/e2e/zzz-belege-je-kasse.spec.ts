import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Auswertung → Belege: die Belege JEDER Kasse des Betriebs, je Kasse getrennt.
 *
 *  - Kassen-Auswahl oben, vorausgewählt „dieses Gerät"; eine Kellner-Kasse zeigt nur ihre eigenen Belege
 *  - Suche nach Betrag, Paging-Zeile
 *  - „Ausgeben" öffnet den Ausgabe-Dialog (Bon, Rechnung, E-Mail)
 *  - Storno eines Belegs der Kellner-Kasse vom Gerät der Barkasse aus: der Stornobeleg landet in der
 *    Kette der Kellner-Kasse, die Zeile zeigt „storniert (#…)"
 *  - „Zurückholen": Storno auf der eigenen Kasse + Positionen im Warenkorb dieses Geräts
 *
 * Liegt am Ende der Suite (zzz-): legt eine Kasse an und legt sie am Schluss still.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ serviceWorkers: 'block' })
test.setTimeout(180_000)

type Login = { token: string; user: { id: string }; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }
interface BelegRes { id: string; belegNummer: number; belegTyp: string; verweisBelegId?: string }
interface Seite { belege: (BelegRes & { storniertDurch?: { id: string; belegNummer: number } })[]; gesamt: number }

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
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-BJK-001',
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

test('Belege je Kasse: Auswahl, Suche, Ausgeben, Storno auf der Kellner-Kasse, Zurückholen in den Warenkorb', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const p = `Bjk${Date.now() % 1_000_000}`
  const barkasse = login.kassen[0]!.id

  const post = async <T>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const seite = async (q: Record<string, string>): Promise<Seite> => {
    const res = await request.get(`/api/belege/seite?${new URLSearchParams(q).toString()}`, { headers: auth })
    expect(res.ok(), await res.text()).toBe(true)
    return (await res.json()) as Seite
  }
  const verkauf = (kasseId: string, bezeichnung: string, cent: number) => post<BelegRes>('/api/belege/barzahlung', {
    kasseId,
    positionen: [{ bezeichnung, preisBruttoCent: cent, mwstSatz: 'normal', menge: 1 }],
    zahlung:    { barCent: cent, karteCent: 0, sonstigeCent: 0 },
    keinAutodruck: true,
  })

  const aufraeumen: (() => Promise<unknown>)[] = []
  try {
    // ---- Testdaten: Kellner-Kasse mit eigenem Beleg, zwei Belege auf der Barkasse ----
    const kellner = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-BJK-${p}`, bezeichnung: `${p} Kellner`, umgebung: 'test' })
    aufraeumen.push(() => request.post(`/api/kassen/${kellner.kasseId}/ausser-betrieb`, { headers: auth, data: {} }))

    const kellnerBeleg = await verkauf(kellner.kasseId, `${p} Spritzer`, 1777)
    const schnitzel    = await verkauf(barkasse, `${p} Schnitzel`, 4321)
    await verkauf(barkasse, `${p} Melange`, 330)

    await anmelden(page, login, barkasse)
    await page.goto('/belege')

    // ---- Kassen-Auswahl: dieses Gerät ist vorausgewählt, die Kellner-Kasse wählbar ----
    const auswahl = page.getByTestId('kassen-auswahl')
    await expect(auswahl).toBeVisible()
    await expect(auswahl.getByRole('tab', { selected: true })).toContainText('dieses Gerät')
    const kellnerTab = auswahl.getByRole('tab', { name: new RegExp(`${p} Kellner`) })
    await expect(kellnerTab).toBeVisible()

    const tabelle = page.getByTestId('belege-tabelle')
    await expect(tabelle).toContainText('43,21')
    await expect(tabelle).not.toContainText('17,77')
    await expect(page.getByTestId('belege-paging')).toContainText(/Belege 1–\d+ von \d+/)

    // ---- Suche nach Betrag ----
    await page.getByLabel('Belege durchsuchen').fill('43,21')
    await expect(tabelle.locator('tbody tr')).toHaveCount(1)
    await expect(page.getByTestId(`beleg-zeile-${schnitzel.belegNummer}`)).toBeVisible()
    await page.getByRole('button', { name: 'Filter zurücksetzen' }).click()

    // ---- Kellner-Kasse: nur deren Belege ----
    await kellnerTab.click()
    await expect(kellnerTab).toHaveAttribute('aria-selected', 'true')
    await expect(tabelle).toContainText('17,77')
    await expect(tabelle).not.toContainText('43,21')
    const kellnerZeile = page.getByTestId(`beleg-zeile-${kellnerBeleg.belegNummer}`)

    // „Ausgeben" → Ausgabe-Dialog (Bon, Rechnung, E-Mail)
    await kellnerZeile.getByRole('button', { name: 'Ausgeben' }).click()
    const ausgabe = page.getByRole('dialog').filter({ hasText: `Beleg #${kellnerBeleg.belegNummer} ausgeben` })
    await expect(ausgabe).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(ausgabe).toBeHidden()

    // ---- Storno vom Gerät der Barkasse aus — landet auf der Kellner-Kasse ----
    await kellnerZeile.getByRole('button', { name: 'Stornieren' }).click()
    const stornoDialog = page.getByRole('dialog').filter({ hasText: `Beleg #${kellnerBeleg.belegNummer} stornieren?` })
    await expect(stornoDialog).toContainText(`${p} Kellner`)
    await stornoDialog.getByRole('button', { name: 'Storno bestätigen' }).click()
    const erstellt = page.getByRole('dialog').filter({ hasText: /Stornobeleg #\d+ erstellt/ })
    await expect(erstellt).toBeVisible()
    await erstellt.getByRole('button', { name: 'Schließen' }).click()
    await expect(kellnerZeile).toContainText(/storniert \(#\d+\)/)

    const stornosKellner = await seite({ kasseId: kellner.kasseId, typen: 'Stornobeleg' })
    expect(stornosKellner.belege.map(b => b.verweisBelegId)).toEqual([kellnerBeleg.id])

    // ---- Zurückholen auf der Barkasse: Storno + Warenkorb ----
    await auswahl.getByRole('tab', { name: /dieses Gerät/ }).click()
    await page.getByLabel('Belege durchsuchen').fill('43,21')
    const schnitzelZeile = page.getByTestId(`beleg-zeile-${schnitzel.belegNummer}`)
    await expect(tabelle.locator('tbody tr')).toHaveCount(1)
    await schnitzelZeile.getByRole('button', { name: 'Zurückholen' }).click()
    const zurueck = page.getByRole('dialog').filter({ hasText: `Beleg #${schnitzel.belegNummer} zurückholen?` })
    await expect(zurueck).toContainText('Warenkorb')
    await zurueck.getByRole('button', { name: 'Stornieren und zurückholen' }).click()

    await expect(page).toHaveURL(/\/kasse$/)
    await expect(page.getByTestId('zurueckgeholt-hinweis')).toContainText(`#${schnitzel.belegNummer}`)
    await expect(page.getByText(`${p} Schnitzel`).first()).toBeVisible()

    const barStorno = await seite({ kasseId: barkasse, typen: 'Barzahlungsbeleg', suche: '43,21' })
    expect(barStorno.belege.find(b => b.id === schnitzel.id)?.storniertDurch).toBeTruthy()

    // Erneutes Öffnen der Kasse holt den Beleg nicht noch einmal
    await page.reload()
    await expect(page.getByTestId('zurueckgeholt-hinweis')).toHaveCount(0)
  } finally {
    for (const f of aufraeumen.reverse()) await f().catch(() => {})
  }
})
