import { test, expect, type APIRequestContext } from '@playwright/test'
import * as XLSX from 'xlsx'

/**
 * Optionen-Import über die Oberfläche: Excel hochladen → Vorschau zeigt je
 * Artikel + Gruppe den Status (gefunden / nicht gefunden) → Import legt die
 * Gruppe an, ordnet sie zu und meldet den unbekannten Artikel.
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
        firmenname: 'E2E Optionen GmbH',
        uid:        'ATU87654339',
        kassenId:   'E2E-OPTIONEN-001',
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

test('Optionen-Import: Vorschau mit Status, Import legt Gruppe an und meldet Unbekanntes', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const ts       = Date.now()
  const spritzer = `Import-Spritzer ${ts}`
  const gruppe   = `Sorte ${ts}`
  const artikel  = await (await request.post('/api/artikel', {
    headers: authHeader, data: { bezeichnung: spritzer, preisBruttoCent: 400, mwstSatz: 'normal' },
  })).json() as { id: string }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Artikel', 'Warengruppe', 'Optionsgruppe', 'Option', 'Aufpreis (EUR)', 'Pflicht', 'Mehrfachauswahl'],
    [spritzer,          '', gruppe, 'weiß',      '',      'Ja', 'Nein'],
    [spritzer,          '', gruppe, 'Ohne Soda', '-2,00', 'Ja', 'Nein'],
    [`Gibt es nicht ${ts}`, '', gruppe, 'weiß',  '',      'Ja', 'Nein'],
  ]), 'Optionen')
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

  try {
    await page.goto('/modifikatoren')
    await expect(page.getByRole('heading', { name: 'Artikel-Optionen' })).toBeVisible()
    await page.getByRole('button', { name: 'Importieren' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'optionen.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: datei,
    })

    // Vorschau: 2 Zuordnungen, eine davon ohne Artikel
    await expect(dialog.getByText('2 Zuordnungen · 3 Optionen')).toBeVisible()
    await expect(dialog.getByText('1 Artikel nicht eindeutig gefunden')).toBeVisible()
    await expect(dialog.getByText('⚠ Artikel nicht gefunden')).toBeVisible()
    await expect(dialog.getByText('✓ OK')).toHaveCount(1)

    await dialog.getByRole('button', { name: 'Optionen importieren' }).click()
    await expect(dialog.getByText('Import abgeschlossen')).toBeVisible()
    await expect(dialog.getByText('1 Einträge nicht zugeordnet:')).toBeVisible()
    await dialog.getByText('Schließen', { exact: true }).click()

    // Gruppe ist angelegt und dem Artikel zugeordnet — mit Pflicht + Minus-Aufpreis
    const zugeordnet = await (await request.get(`/api/artikel/${artikel.id}/modifikator-gruppen`, {
      headers: authHeader,
    })).json() as { name: string; typ: string; modifikatoren: { name: string; aufschlagCent: number }[] }[]
    expect(zugeordnet).toHaveLength(1)
    expect(zugeordnet[0]).toMatchObject({
      name: gruppe,
      typ:  'pflicht',
      modifikatoren: [{ name: 'weiß', aufschlagCent: 0 }, { name: 'Ohne Soda', aufschlagCent: -200 }],
    })
    await expect(page.getByText(gruppe).first()).toBeVisible()
  } finally {
    const gruppen = await (await request.get('/api/modifikator-gruppen', { headers: authHeader }))
      .json() as { id: string; name: string }[]
    for (const g of gruppen.filter(g => g.name === gruppe)) {
      await request.delete(`/api/modifikator-gruppen/${g.id}`, { headers: authHeader })
    }
    await request.delete(`/api/artikel/${artikel.id}`, { headers: authHeader })
  }
})
