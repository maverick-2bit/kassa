import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Steuersatz 4,9 % (ausgewählte Nahrungsmittel, seit 1.7.2026) durch den echten Browser:
 * Artikelformular (Satz wählbar, Hinweis auf „nur Lieferungen") → Verkauf an der Kasse (Beleg mit eigener
 * Steuerzeile) → Belegliste → Tagesabschluss (Z-Bon führt 4,9 % getrennt).
 *
 * Rechtsgrundlage: RKSV Anlage 1 Z 4 (BGBl. II Nr. 134/2026): der QR-Code führt 4,9 % im Feld „Betrag-Satz-Besonders
 * (19 %, 4,9 %)" — Bon, Berichte und Tagesabschluss der Kassa dagegen getrennt. Der QR-Code selbst ist im
 * Integrationstest (tests/integration/satz-4-9.test.ts) und im Burn-in mit dem unabhängigen Prüfer belegt; hier geht
 * es um die Oberfläche.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz) — daher zzz-. Eigene, eindeutig benannte Daten.
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
        firmenname: 'E2E Satz GmbH', uid: 'ATU87654332', kassenId: 'E2E-SATZ-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
  }
  return (await res.json()) as Login
}

async function anmelden(page: Page, login: Login) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })
}

/** Die Kachel über die Suche holen (es gibt keinen „Alle"-Reiter mehr). */
async function artikelKachel(page: Page, name: string) {
  await page.getByPlaceholder(/Artikel suchen/).fill(name)
  return page.getByRole('button', { name }).first()
}

test('4,9 %: Artikelformular mit Hinweis, Verkauf, Beleg-Anzeige, Tagesabschluss', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const name  = `Semmel Satz ${Date.now()}`
  let belegNummer = 0

  // Der Artikel startet mit dem alten Satz (10 %) — die Umstellung auf 4,9 % macht der Test über das Formular
  const angelegt = await request.post('/api/artikel', { headers: auth, data: { bezeichnung: name, preisBruttoCent: 60, mwstSatz: 'ermaessigt1' } })
  expect(angelegt.ok()).toBe(true)
  const artikelId = (await angelegt.json()).id as string

  await anmelden(page, login)

  await test.step('Formular: 4,9 % ist wählbar, der Hinweis erscheint nur dort und nennt „nur Lieferungen"', async () => {
    await page.goto('/artikel')
    await expect(page.getByRole('heading', { name: 'Artikel', exact: true })).toBeVisible()
    await page.getByLabel('Artikel suchen').fill(name)
    await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Bearbeiten', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Artikel bearbeiten' })).toBeVisible()

    // Das Feld „MwSt-Satz" hat keine verknüpfte Beschriftung → über seine Auswahlpunkte
    const satz = dialog.locator('select').filter({ has: page.locator('option', { hasText: '4,9 % (Ermäßigt 3)' }) })
    await expect(satz).toHaveCount(1)
    await expect(dialog.getByText(/gilt nur für die Lieferung ausgewählter Nahrungsmittel/)).toHaveCount(0)

    await satz.selectOption({ label: '4,9 % (Ermäßigt 3)' })
    await expect(dialog.getByText(/gilt nur für die Lieferung ausgewählter Nahrungsmittel/)).toBeVisible()
    await expect(dialog.getByText(/nicht für Speisen und Getränke zum Verzehr im Lokal/)).toBeVisible()

    await satz.selectOption({ label: '20 % (Normal)' })
    await expect(dialog.getByText(/gilt nur für die Lieferung ausgewählter Nahrungsmittel/)).toHaveCount(0)

    await satz.selectOption({ label: '4,9 % (Ermäßigt 3)' })
    await dialog.getByRole('button', { name: 'Speichern', exact: true }).click()
    await expect(dialog).toBeHidden()
  })

  await test.step('der Server hat den Satz gespeichert', async () => {
    const liste = (await (await request.get('/api/artikel', { headers: auth })).json()) as { id: string; mwstSatz: string }[]
    expect(liste.find(a => a.id === artikelId)!.mwstSatz).toBe('ermaessigt3')
  })

  await test.step('Kasse: verkaufen — der Beleg weist 4,9 % getrennt aus', async () => {
    await page.goto('/kasse')
    await (await artikelKachel(page, name)).click()
    await page.getByRole('button', { name: /^Bar \(/ }).click()
    await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
    // Steueraufteilung im Beleg-Dialog: 4,9 % mit dem Bruttobetrag der Semmel (0,60)
    const steuerzeile = page.locator('div', { hasText: /^4,9 % \(Ermäßigt 3\)/ }).filter({ hasText: '0,60' }).first()
    await expect(steuerzeile).toBeVisible()
  })

  await test.step('Server: Beleg mit eigener Betragsspalte, QR-Code trägt die Summe im Feld „Besonders"', async () => {
    const belege = (await (await request.get(`/api/belege?kasseId=${kasseId}&limit=50`, { headers: auth })).json()) as
      { belegNummer: number; betraege: Record<string, number>; maschinenlesbareCode: string; positionen: { bezeichnung: string }[] }[]
    const beleg = belege.filter(b => b.positionen.some(p => p.bezeichnung === name)).sort((a, b) => b.belegNummer - a.belegNummer)[0]!
    expect(beleg.betraege).toMatchObject({ ermaessigt3: 60, ermaessigt1: 0, besonders: 0 })
    expect(beleg.maschinenlesbareCode.split('_')[9]).toBe('0,60')
    belegNummer = beleg.belegNummer
  })

  await test.step('Tagesabschluss: die Steuerzeile 4,9 % erscheint getrennt', async () => {
    await page.goto('/tagesabschluss')       // heutiger Geschäftstag, lädt beim Öffnen
    await expect(page.getByRole('cell', { name: '4,9 % (Ermäßigt 3)' })).toBeVisible({ timeout: 15_000 })
  })

  await test.step('Beleg-Seite: der Beleg öffnet sich mit der Zeile „4,9 % (Ermäßigt 3)"', async () => {
    await page.goto('/belege')
    await page.getByRole('cell', { name: `#${belegNummer}`, exact: true }).click()
    await expect(page.getByRole('dialog').getByText('4,9 % (Ermäßigt 3)')).toBeVisible()
  })
})
