import { test, expect, type APIRequestContext } from '@playwright/test'
import { eanPruefziffer } from '@kassa/shared'

/**
 * EAN als Artikelkennzeichnung:
 *  - Formular: falsche Prüfziffer und eine schon vergebene EAN werden am Feld gemeldet, nichts gespeichert;
 *  - Artikelliste: Spalte „EAN", die Suche findet nach EAN;
 *  - Kasse: Handscanner (schnelle Ziffern + Enter) ohne Fokus in einem Feld bucht den Artikel; Scan ins
 *    Suchfeld ebenso; unbekannte EAN → Hinweis, nichts gebucht;
 *  - Beleg: die Position trägt die EAN.
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
        firmenname: 'E2E EAN GmbH',
        uid:        'ATU87654351',
        kassenId:   'E2E-EAN-001',
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

/** Hauseigene EAN-13 (Präfix 2), eindeutig je Lauf, mit gültiger Prüfziffer */
const hausEan = (zahl: number) => {
  const rumpf = '2' + String(zahl).slice(-11).padStart(11, '0')
  return rumpf + eanPruefziffer(rumpf)
}

test('EAN: Prüfung im Formular, Suche in der Liste, Scan an der Kasse bucht, EAN am Beleg', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  const ts      = Date.now()
  const name    = `Scan-Milch ${ts}`
  const andere  = `Scan-Butter ${ts}`
  const ean     = hausEan(ts)
  const anlegen = await request.post('/api/artikel', { headers: authHeader, data: { bezeichnung: name, preisBruttoCent: 129, mwstSatz: 'ermaessigt1', ean } })
  expect(anlegen.ok(), await anlegen.text()).toBe(true)
  const butter = await request.post('/api/artikel', { headers: authHeader, data: { bezeichnung: andere, preisBruttoCent: 249, mwstSatz: 'ermaessigt1' } })
  expect(butter.ok(), await butter.text()).toBe(true)

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

  // ---- Artikelliste: Spalte + Suche nach EAN
  await page.goto('/artikel')
  await expect(page.getByRole('heading', { name: 'Artikel', exact: true })).toBeVisible()
  await page.getByLabel('Artikel suchen').fill(ean)
  const zeile = page.getByRole('row').filter({ hasText: name })
  await expect(zeile).toHaveCount(1)
  await expect(zeile.getByTestId('artikel-zeile-ean')).toHaveText(ean)

  // ---- Formular: falsche Prüfziffer, dann die EAN eines anderen Artikels → Meldung am Feld, Dialog bleibt offen
  await page.getByLabel('Artikel suchen').fill(andere)
  await page.getByRole('row').filter({ hasText: andere }).getByRole('button', { name: 'Bearbeiten', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Artikel bearbeiten' })).toBeVisible()
  const falsch = ean.slice(0, -1) + String((Number(ean.slice(-1)) + 1) % 10)
  await dialog.getByTestId('artikel-ean').fill(falsch)
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect(dialog.getByText(/Prüfziffer stimmt nicht/)).toBeVisible()
  await dialog.getByTestId('artikel-ean').fill(ean)
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect(dialog.getByText(`EAN gehört schon zum Artikel „${name}"`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).last().click()
  await expect(dialog).toBeHidden()
  const liste = await (await request.get(`/api/artikel?mandantId=${login.mandant.id}&nurAktive=false`, { headers: authHeader })).json() as { bezeichnung: string; ean: string | null }[]
  expect(liste.find(a => a.bezeichnung === andere)?.ean).toBeNull()

  // ---- Kasse: Scan ohne Fokus (Handscanner = schnelle Tastatur + Enter)
  await page.goto('/kasse')
  const bar = page.getByRole('button', { name: /^Bar \(/ })
  await expect(page.getByTestId('artikel-grid')).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.type(ean, { delay: 5 })
  await page.keyboard.press('Enter')
  await expect(bar).toContainText('1,29')

  // Scan ins Suchfeld: bucht ebenso und leert das Feld
  const suche = page.getByPlaceholder(/Artikel suchen/)
  await suche.fill(ean)
  await suche.press('Enter')
  await expect(bar).toContainText('2,58')
  await expect(suche).toHaveValue('')

  // Unbekannte EAN: Hinweis, nichts gebucht
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const unbekannt = hausEan(ts + 1)
  await page.keyboard.type(unbekannt, { delay: 5 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('scan-hinweis')).toContainText(`Kein Artikel mit EAN ${unbekannt}`)
  await expect(bar).toContainText('2,58')

  // ---- Bezahlen: die Belegposition trägt die EAN
  await page.getByRole('checkbox', { name: /Ausgabe wählen/ }).check()
  await bar.click()
  await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
  const belege = await (await request.get(`/api/belege?kasseId=${login.kassen[0]!.id}`, { headers: authHeader })).json() as
    { positionen: { bezeichnung: string; menge: number; ean?: string }[] }[]
  const position = belege.flatMap(b => b.positionen).find(p => p.bezeichnung === name)
  expect(position).toMatchObject({ ean })
})
