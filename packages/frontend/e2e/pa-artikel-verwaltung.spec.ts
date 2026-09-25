import { test, expect, type APIRequestContext } from '@playwright/test'
import * as XLSX from 'xlsx'

/**
 * Artikelverwaltung:
 *  - Import meldet Artikel, die es in derselben Warengruppe schon gibt, und fragt,
 *    ob sie erneut importiert werden sollen (hier: vorhandenen aktualisieren)
 *  - Spalten sortierbar + Warengruppen-Filter
 *  - Favorit per Schieberegler direkt in der Liste
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet
 * adminLogin() die Instanz notfalls selbst ein.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Artikel GmbH',
        uid:        'ATU87654339',
        kassenId:   'E2E-ARTIKEL-001',
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
  return res.json() as Promise<{
    token: string
    user: unknown
    mandant: { id: string }
    kassen: { id: string }[]
  }>
}

interface ArtikelDto { id: string; bezeichnung: string; preisBruttoCent: number; istFavorit: boolean; kategorieId: string | null }

test('Artikelverwaltung: Import-Doppelte, Sortierung, Favoriten-Schalter', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const ts      = Date.now()
  const katName = `Import-WG ${ts}`
  const radler  = `Radler ${ts}`
  const neu     = `Almdudler ${ts}`
  const kat = await (await request.post('/api/kategorien', {
    headers: authHeader, data: { name: katName, farbe: 'grau' },
  })).json() as { id: string }
  const vorhanden = await (await request.post('/api/artikel', {
    headers: authHeader, data: { bezeichnung: radler, preisBruttoCent: 400, mwstSatz: 'normal', kategorieId: kat.id },
  })).json() as ArtikelDto

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Bezeichnung', 'Preis (EUR)', 'MwSt-Satz', 'KDS-Station', 'Kategorie', 'Lagerstand', 'Anfangsbestand', 'Mindestbestand'],
    [radler.toUpperCase(), '4,80', '20 %', '', katName, 'Nein', '', ''],
    [neu,                  '3,20', '20 %', '', katName, 'Nein', '', ''],
  ]), 'Artikel')
  const datei = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)

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

  const artikelDerWg = async () =>
    ((await (await request.get('/api/artikel?nurAktive=false', { headers: authHeader })).json()) as ArtikelDto[])
      .filter(a => a.kategorieId === kat.id)

  try {
    await page.goto('/artikel')
    await expect(page.getByRole('heading', { name: 'Artikel', exact: true })).toBeVisible()

    // ---- Import: Radler gibt es schon (Groß-/Kleinschreibung egal) ----
    await page.getByRole('button', { name: 'Importieren' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'artikel.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: datei,
    })

    await expect(dialog.getByText('1 Artikel gibt es in derselben Warengruppe schon')).toBeVisible()
    await expect(dialog.getByText(`⚠ Schon vorhanden: ${radler}`)).toBeVisible()
    // Standard: überspringen → nur der neue Artikel würde angelegt
    await expect(dialog.getByRole('button', { name: '1 Artikel importieren', exact: true })).toBeVisible()

    await dialog.getByRole('button', { name: 'Vorhandene aktualisieren' }).click()
    await dialog.getByRole('button', { name: '1 Artikel importieren + 1 aktualisieren' }).click()
    await expect(dialog.getByText('Import abgeschlossen')).toBeVisible()
    await expect(dialog.getByText('1 vorhandene aktualisiert.')).toBeVisible()
    await dialog.getByText('Schließen', { exact: true }).click()

    // Kein zweiter Radler, der vorhandene hat den neuen Preis
    const nachImport = await artikelDerWg()
    expect(nachImport.map(a => a.bezeichnung).sort()).toEqual([neu, radler])
    expect(nachImport.find(a => a.id === vorhanden.id)?.preisBruttoCent).toBe(480)

    // ---- Filter + Sortierung ----
    await page.getByLabel('Nach Warengruppe filtern').selectOption(kat.id)
    const zeilen = page.locator('tbody').first().locator('tr')
    await expect(zeilen).toHaveCount(2)
    await page.getByRole('button', { name: 'Preis', exact: true }).click()
    await expect(zeilen.nth(0)).toContainText(neu)          // 3,20 vor 4,80
    await page.getByRole('button', { name: 'Preis ▲' }).click()
    await expect(zeilen.nth(0)).toContainText(radler)       // absteigend
    // Verschieben geht nur in der Kassen-Reihenfolge
    await expect(zeilen.nth(0).getByRole('button', { name: 'Nach unten' })).toBeDisabled()

    // ---- Favorit per Schieberegler ----
    const schalter = page.getByRole('switch', { name: `${radler} als Favorit` })
    await expect(schalter).toHaveAttribute('aria-checked', 'false')
    await schalter.click()
    await expect(schalter).toHaveAttribute('aria-checked', 'true')
    expect((await artikelDerWg()).find(a => a.id === vorhanden.id)?.istFavorit).toBe(true)
  } finally {
    for (const a of await artikelDerWg()) {
      await request.delete(`/api/artikel/${a.id}`, { headers: authHeader })
    }
    await request.delete(`/api/kategorien/${kat.id}`, { headers: authHeader })
  }
})
