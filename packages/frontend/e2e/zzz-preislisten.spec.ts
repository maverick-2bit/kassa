import { test, expect, type APIRequestContext } from '@playwright/test'
import * as XLSX from 'xlsx'

/**
 * Preislisten über die Oberfläche: Liste mit Sonderpreis anlegen → im Kunden zuweisen → an der Kasse gilt der
 * Sonderpreis, sobald der Kunde gewählt ist (auch für schon im Warenkorb liegende Artikel), und fällt beim
 * Entfernen des Kunden auf den normalen Preis zurück. Dazu die Übernahme einer Preisgruppe aus der SelectLine-Datei.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet adminLogin() die Instanz selbst ein.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Preislisten GmbH',
        uid:        'ATU87654343',
        kassenId:   'E2E-PREISLISTEN-001',
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

test('Preislisten: Sonderpreis anlegen, Kunde zuweisen, an der Kasse wirksam; Übernahme aus SelectLine', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  const ts        = Date.now()
  const listeName = `Tersus ${ts}`
  const toner     = `Preisliste-Toner ${ts}`
  const kabel     = `Preisliste-Kabel ${ts}`
  const kundeName = `Tersus-Kunde ${ts}`
  const anderer   = `Anderer-Kunde ${ts}`

  const neuerArtikel = async (bezeichnung: string, preisBruttoCent: number, extra: Record<string, unknown> = {}) =>
    (await (await request.post('/api/artikel', { headers: authHeader, data: { bezeichnung, preisBruttoCent, mwstSatz: 'normal', ...extra } })).json() as { id: string }).id
  const tonerId = await neuerArtikel(toner, 6000)
  const kabelId = await neuerArtikel(kabel, 500)
  const kundeId = (await (await request.post('/api/kunden', { headers: authHeader, data: { firma: kundeName } })).json() as { id: string }).id
  await request.post('/api/kunden', { headers: authHeader, data: { firma: anderer } })

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

  const aufraeumen: (() => Promise<unknown>)[] = []
  try {
    // ---- Preisliste anlegen und Sonderpreis eintragen
    await page.goto('/preislisten')
    await page.getByTestId('preisliste-neu').click()
    await page.getByTestId('preisliste-neu-name').fill(listeName)
    await page.getByTestId('preisliste-anlegen').click()

    const editor = page.getByTestId('preisliste-editor')
    await expect(editor).toBeVisible()
    await editor.getByTestId('preisliste-suche').fill(toner)
    await editor.getByTestId('preisliste-artikel-hinzu').selectOption(tonerId)
    const zeile = editor.getByTestId('preisliste-zeile').filter({ hasText: toner })
    await expect(zeile).toHaveCount(1)
    await zeile.getByTestId('preisliste-preis').fill('54,00')
    await expect(zeile).toContainText('−10 %')                                  // Unterschied zum Normalpreis 60,00
    await editor.getByTestId('preisliste-speichern').click()
    await expect(editor.getByTestId('preisliste-hinweis')).toContainText('1 Preis gespeichert')

    const listen = await (await request.get('/api/preislisten', { headers: authHeader })).json() as { id: string; name: string; anzahlPreise: number }[]
    const liste = listen.find(l => l.name === listeName)!
    expect(liste.anzahlPreise).toBe(1)
    aufraeumen.push(() => request.delete(`/api/preislisten/${liste.id}`, { headers: authHeader }))
    await page.keyboard.press('Escape')

    // ---- im Kunden zuweisen (Formular)
    await page.goto('/kunden')
    await page.getByPlaceholder(/Suchen/).fill(kundeName)
    await page.getByRole('row', { name: new RegExp(kundeName) }).getByRole('button', { name: /Profil/ }).click()
    await page.getByRole('button', { name: 'Bearbeiten' }).click()
    await page.getByTestId('kunde-preisliste').selectOption({ label: `${listeName} · 1 Preise` })
    await page.getByRole('button', { name: 'Speichern', exact: true }).click()
    await expect.poll(async () => ((await (await request.get(`/api/kunden/${kundeId}`, { headers: authHeader })).json()) as { preislisteId: string | null }).preislisteId).toBe(liste.id)

    // ---- Kasse: erst normaler Preis, dann Kunde wählen → Sonderpreis (auch für bereits gewählten Artikel)
    await page.goto('/kasse')
    await page.getByPlaceholder(/Artikel suchen/).fill(toner)
    await page.getByRole('button', { name: new RegExp(toner) }).first().click()
    const bar = page.getByRole('button', { name: /^Bar \(/ })
    await expect(bar).toContainText('60,00')

    await page.getByPlaceholder('Kunde suchen…').fill(kundeName)
    await page.getByRole('button', { name: new RegExp(kundeName) }).click()
    await expect(page.getByTestId('kasse-preisliste-hinweis')).toContainText(listeName)
    await expect(bar).toContainText('54,00')                                    // Toner im Korb umgestellt

    // Artikel ohne Eintrag bleibt beim normalen Preis; weiterer Toner kommt zum Sonderpreis dazu
    await page.getByPlaceholder(/Artikel suchen/).fill(kabel)
    await page.getByRole('button', { name: new RegExp(kabel) }).first().click()
    await expect(bar).toContainText('59,00')                                    // 54,00 + 5,00
    await page.getByPlaceholder(/Artikel suchen/).fill(toner)
    await page.getByRole('button', { name: new RegExp(toner) }).first().click()
    await expect(bar).toContainText('113,00')                                   // 2 × 54,00 + 5,00

    // Kunden wieder entfernen → normale Preise (2 × 60,00 + 5,00)
    await page.getByRole('button', { name: /Kunde (entfernen|ändern)|✕|×/ }).first().click()
    await expect(page.getByTestId('kasse-preisliste-hinweis')).toHaveCount(0)
    await expect(bar).toContainText('125,00')

    // Anderer Kunde ohne Preisliste: normaler Preis, kein Hinweis
    await page.getByPlaceholder('Kunde suchen…').fill(anderer)
    await page.getByRole('button', { name: new RegExp(anderer) }).click()
    await expect(page.getByTestId('kasse-preisliste-hinweis')).toHaveCount(0)
    await expect(bar).toContainText('125,00')

    // ---- Übernahme einer Preisgruppe aus der SelectLine-Datei (Artikel kennen sich über die SelectLine-Nr.)
    const slNr = `SL-${ts}`
    const slArtikel = await neuerArtikel(`Preisliste-Import ${ts}`, 6000, { lieferantenArtikelnummer: slNr })
    aufraeumen.push(() => request.delete(`/api/artikel/${slArtikel}`, { headers: authHeader }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Artikelnummer', 'Bezeichnung', 'Preisgruppe 2 – Importiert (netto)'],
      [slNr, 'egal', 50.25],
      [`SL-GIBT-ES-NICHT-${ts}`, 'unbekannt', 10],
    ]), 'M10')
    const datei = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)

    await page.goto('/uebernahme')
    await page.getByTestId('uebernahme-preislisten-datei').setInputFiles({ name: 'Artikel.xlsx', mimeType: XLSX_MIME, buffer: datei })
    await expect(page.getByTestId('uebernahme-pg-2')).toBeVisible()
    await expect(page.getByTestId('uebernahme-preislisten-start')).toBeDisabled()   // nichts ausgewählt
    await page.getByTestId('uebernahme-pg-name-2').fill(`Importiert ${ts}`)
    await page.getByTestId('uebernahme-pg-2').check()
    await page.getByTestId('uebernahme-preislisten-start').click()
    await expect(page.getByTestId('uebernahme-preislisten-ergebnis')).toContainText('1 Sonderpreise übernommen, 1 Artikel nicht gefunden')

    const nachImport = await (await request.get('/api/preislisten', { headers: authHeader })).json() as { id: string; name: string }[]
    const importiert = nachImport.find(l => l.name === `Importiert ${ts}`)!
    aufraeumen.push(() => request.delete(`/api/preislisten/${importiert.id}`, { headers: authHeader }))
    const detail = await (await request.get(`/api/preislisten/${importiert.id}`, { headers: authHeader })).json() as { preise: { artikelId: string; preisBruttoCent: number }[] }
    expect(detail.preise).toEqual([expect.objectContaining({ artikelId: slArtikel, preisBruttoCent: 6030 })])  // 50,25 netto × 1,2

    // zweiter Lauf: überschreibt, legt keine zweite Liste an
    await page.getByTestId('uebernahme-preislisten-start').click()
    await expect(page.getByTestId('uebernahme-preislisten-ergebnis')).toContainText('1 Sonderpreise übernommen')
    const nachZweitem = await (await request.get('/api/preislisten', { headers: authHeader })).json() as { name: string }[]
    expect(nachZweitem.filter(l => l.name === `Importiert ${ts}`)).toHaveLength(1)
  } finally {
    for (const f of aufraeumen) await f().catch(() => undefined)
    for (const id of [tonerId, kabelId]) await request.delete(`/api/artikel/${id}`, { headers: authHeader })
    const kunden = await (await request.get('/api/kunden?nurAktive=false&limit=5000', { headers: authHeader })).json() as { id: string; firma: string | null }[]
    for (const k of kunden.filter(x => x.firma === kundeName || x.firma === anderer)) await request.delete(`/api/kunden/${k.id}`, { headers: authHeader })
  }
})
