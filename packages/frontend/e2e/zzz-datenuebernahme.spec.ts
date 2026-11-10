import { test, expect, type APIRequestContext } from '@playwright/test'
import * as XLSX from 'xlsx'

/**
 * Datenübernahme aus SelectLine über die Oberfläche (/uebernahme):
 * Lieferanten → Kunden → Artikel per Excel; Artikel verknüpfen sich mit dem Lieferanten (Markierung in der
 * Notiz) und der Warengruppe; erneutes Übernehmen erkennt Vorhandenes und legt nichts doppelt an.
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
        firmenname: 'E2E Uebernahme GmbH',
        uid:        'ATU87654341',
        kassenId:   'E2E-UEBERNAHME-001',
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

function excel(blatt: string, kopf: string[], zeilen: (string | number)[][]): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([kopf, ...zeilen]), blatt)
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
}

test('Datenübernahme: Lieferanten, Kunden und Artikel mit Preisen aus Excel; zweiter Lauf legt nichts doppelt an', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const ts          = Date.now()
  const lieferantNr = `E2E${ts}`
  const kundeNr     = `K${ts}`
  const lieferant   = `Übernahme-Lieferant ${ts}`
  const kunde       = `Übernahme-Kunde ${ts}`
  const gruppe      = `Übernahme-Gruppe ${ts}`
  const artikel     = `Übernahme-Artikel ${ts}`
  const artikelOhne = `Übernahme-ohne-Preis ${ts}`
  const ean         = String(ts).padStart(13, '9').slice(-13)

  const dateiLieferanten = excel('Lieferanten',
    ['Nummer', 'Firma', 'Name', 'Vorname', 'Straße', 'PLZ', 'Ort', 'Land', 'Telefon', 'E-Mail', 'UID', 'Zahlungsbed.', 'Notiz'],
    [[lieferantNr, lieferant, '', '', 'Carl-Miele-Straße 3', '38112', 'Braunschweig', 'D', '+49 531 1', 'info@lief.de', 'DE 123 456 789', '14 Tage netto', 'Vorkasse'],
     ['E2E-LEER', '', '', '', '', '', '', '', '', '', '', '', '']])
  const dateiKunden = excel('Kunden M10',
    ['Nummer', 'Firma', 'Name', 'Vorname', 'Straße', 'PLZ', 'Ort', 'Land', 'Telefon', 'E-Mail', 'UID'],
    [[kundeNr, kunde, '', '', 'Hauptplatz 1', '8750', 'Judenburg', 'A', '03572 1', 'k@kunde.at', 'ATU11111111']])
  const dateiArtikel = excel('M10',
    ['Artikelnummer', 'EAN', 'Bezeichnung', 'Warengruppe', 'Steuer %', 'VK netto (Listenpreis)', 'VK brutto', 'Einkaufspreis (letzter)', 'Lieferant', 'Hersteller', 'Hersteller-Art.Nr.', 'Inaktiv'],
    [[`SL-${ts}`, ean, artikel, gruppe, 20, 40.83, 49, 33.33, lieferantNr, 'Epson', 'C13T10H44010', ''],
     [`SL-OHNE-${ts}`, '', artikelOhne, gruppe, 20, '', '', '', lieferantNr, '', '', '']])

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
    await page.goto('/uebernahme')
    await expect(page.getByRole('heading', { name: 'Datenübernahme' })).toBeVisible()

    // 1. Lieferanten
    await page.getByTestId('uebernahme-lieferanten-datei').setInputFiles({ name: 'Lieferanten.xlsx', mimeType: XLSX_MIME, buffer: dateiLieferanten })
    await expect(page.getByText('1 Lieferanten bereit zur Übernahme.')).toBeVisible()
    await expect(page.getByText('1 Zeilen werden nicht übernommen')).toBeVisible()
    await page.getByTestId('uebernahme-lieferanten-start').click()
    await expect(page.getByTestId('uebernahme-ergebnis').first()).toContainText('1 neu angelegt')
    // zweiter Lauf: nichts doppelt
    await page.getByTestId('uebernahme-lieferanten-start').click()
    await expect(page.getByTestId('uebernahme-ergebnis').first()).toContainText('0 neu angelegt, 1 waren schon vorhanden')

    const lieferanten = await (await request.get('/api/lieferanten', { headers: authHeader })).json() as
      { id: string; name: string; land: string; uid: string | null; strasse: string | null; zahlungsbedingung: string | null; notiz: string | null }[]
    const l = lieferanten.filter(x => x.name === lieferant)
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ land: 'DE', uid: 'DE123456789', strasse: 'Carl-Miele-Straße 3', zahlungsbedingung: '14 Tage netto' })
    expect(l[0]!.notiz).toContain(`SelectLine-Nr. ${lieferantNr}`)

    // 2. Kunden
    await page.getByTestId('uebernahme-kunden-datei').setInputFiles({ name: 'Kunden.xlsx', mimeType: XLSX_MIME, buffer: dateiKunden })
    await expect(page.getByText('1 Kunden bereit zur Übernahme.')).toBeVisible()
    await page.getByTestId('uebernahme-kunden-start').click()
    await expect(page.getByTestId('uebernahme-ergebnis').nth(1)).toContainText('1 neu angelegt')
    await page.getByTestId('uebernahme-kunden-start').click()
    await expect(page.getByTestId('uebernahme-ergebnis').nth(1)).toContainText('0 neu angelegt, 1 waren schon vorhanden')

    const kunden = await (await request.get('/api/kunden?nurAktive=false&limit=5000', { headers: authHeader })).json() as
      { id: string; firma: string | null; land: string; ort: string | null; uid: string | null; notizen: string | null }[]
    const k = kunden.filter(x => x.firma === kunde)
    expect(k).toHaveLength(1)
    expect(k[0]).toMatchObject({ land: 'AT', ort: 'Judenburg', uid: 'ATU11111111' })
    expect(k[0]!.notizen).toContain(`SelectLine Kd.-Nr. ${kundeNr}`)

    // 3. Artikel (ohne Preis zunächst nicht)
    await page.getByTestId('uebernahme-artikel-datei').setInputFiles({ name: 'Artikel.xlsx', mimeType: XLSX_MIME, buffer: dateiArtikel })
    await expect(page.getByText('1 Artikel bereit zur Übernahme.')).toBeVisible()
    await page.getByTestId('uebernahme-artikel-start').click()
    await expect(page.getByTestId('uebernahme-ergebnis').nth(2)).toContainText('1 neu angelegt')

    const liste = async () => await (await request.get(`/api/artikel?mandantId=${login.mandant.id}&nurAktive=false`, { headers: authHeader })).json() as
      { id: string; bezeichnung: string; preisBruttoCent: number; mwstSatz: string; ean: string | null; einkaufspreisCent: number | null
        lieferantenArtikelnummer: string | null; hersteller: string | null; lieferantId: string | null; kategorieId: string | null }[]
    let a = (await liste()).filter(x => x.bezeichnung === artikel)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({
      preisBruttoCent: 4900, mwstSatz: 'normal', ean, einkaufspreisCent: 3333, lieferantenArtikelnummer: `SL-${ts}`,
      hersteller: 'Epson', lieferantId: l[0]!.id,
    })
    expect(a[0]!.kategorieId).not.toBeNull()
    expect((await liste()).filter(x => x.bezeichnung === artikelOhne)).toHaveLength(0)

    // Zweiter Lauf, jetzt auch Artikel ohne Preis: der erste wird als vorhanden erkannt
    await page.getByTestId('uebernahme-auch-ohne-preis').check()
    await expect(page.getByText('2 Artikel bereit zur Übernahme.')).toBeVisible()
    await page.getByTestId('uebernahme-artikel-start').click()
    await expect(page.getByTestId('uebernahme-ergebnis').nth(2)).toContainText('1 neu angelegt, 1 waren schon vorhanden')
    a = (await liste()).filter(x => x.bezeichnung === artikel)
    expect(a).toHaveLength(1)
    const ohne = (await liste()).filter(x => x.bezeichnung === artikelOhne)
    expect(ohne).toHaveLength(1)
    expect(ohne[0]!.preisBruttoCent).toBe(0)
    expect(ohne[0]!.kategorieId).toBe(a[0]!.kategorieId) // Warengruppe nur einmal angelegt
  } finally {
    for (const x of (await (await request.get(`/api/artikel?mandantId=${login.mandant.id}&nurAktive=false`, { headers: authHeader })).json() as { id: string; bezeichnung: string }[])
      .filter(x => [artikel, artikelOhne].includes(x.bezeichnung))) {
      await request.delete(`/api/artikel/${x.id}`, { headers: authHeader })
    }
    for (const x of (await (await request.get('/api/lieferanten', { headers: authHeader })).json() as { id: string; name: string }[]).filter(x => x.name === lieferant)) {
      await request.delete(`/api/lieferanten/${x.id}`, { headers: authHeader })
    }
    for (const x of (await (await request.get('/api/kunden?nurAktive=false&limit=5000', { headers: authHeader })).json() as { id: string; firma: string | null }[]).filter(x => x.firma === kunde)) {
      await request.delete(`/api/kunden/${x.id}`, { headers: authHeader })
    }
  }
})
