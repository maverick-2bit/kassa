import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Asello-Layout in der Kasse:
 *  1. Untergruppen-Baum: Kachel (Gruppenfarbe), hineinklicken, „◂ Zurück", leere Rasterfelder
 *     an fehlenden Slots, Hex-Farben als berechnete Hintergrundfarbe
 *  2. Layout-Import in der Artikelverwaltung (JSON): Vorschau schreibt nichts, „Anwenden"
 *     setzt Baum/Slots/Farben, Favoriten in fester Reihenfolge, Raster auf 3 Spalten
 *
 * Liegt bewusst am Ende der Suite (zzz-): der Import setzt die Favoriten und die Spaltenzahl
 * ALLER Kassen des Mandanten zurück.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ serviceWorkers: 'block' })

type Login = { token: string; user: { id: string }; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }

let gemerkterLogin: Login | null = null
async function adminLogin(request: APIRequestContext): Promise<Login> {
  if (gemerkterLogin) return gemerkterLogin
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-ASELLO-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  gemerkterLogin = (await res.json()) as Login
  return gemerkterLogin
}

async function anmelden(page: Page, login: Login) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId: login.kassen[0]!.id,
  })
}

const KACHEL = '[data-testid="untergruppe-kachel"], [data-testid="artikel-kachel"], [data-testid="raster-leer"]'

/** Raster in Dokumentreihenfolge: je Zelle Typ + Text */
async function raster(page: Page) {
  return page.locator(KACHEL).evaluateAll(els => els.map(el => ({
    typ: el.getAttribute('data-testid')!,
    text: ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim(),
  })))
}

async function post<T>(request: APIRequestContext, token: string, url: string, data: object): Promise<T> {
  const res = await request.post(url, { headers: { Authorization: `Bearer ${token}` }, data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test('Asello-Layout: Untergruppen-Kacheln, Zurück, leere Felder, Hex-Farben, Layout-Import mit Favoriten', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const token = login.token
  const auth = { Authorization: `Bearer ${token}` }
  const p = `Asl${Date.now() % 1_000_000}`

  // ---- Baum per API: Bar ▸ (Alkoholfrei ▸ Limonaden, Bier) -----------------------------
  const bar  = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Bar`, farbe: '#e76815', reihenfolge: 900 })
  const alko = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Alkoholfrei`, farbe: '#60aa30', reihenfolge: 0, parentId: bar.id })
  await post(request, token, '/api/kategorien', { name: `${p} Bier`, farbe: '#0072bb', reihenfolge: 1, parentId: bar.id })
  const limo = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Limonaden`, farbe: '#db3385', reihenfolge: 0, parentId: alko.id })
  const artikel = (bezeichnung: string, kategorieId: string, extra: object = {}) =>
    post<{ id: string }>(request, token, '/api/artikel', { bezeichnung, preisBruttoCent: 350, mwstSatz: 'normal', kategorieId, ...extra })
  await artikel(`${p} Cola`, bar.id, { rasterPosition: 2, farbe: '#463123' })
  await artikel(`${p} Radler`, bar.id, { rasterPosition: 5 })
  await artikel(`${p} Soda`, alko.id, { rasterPosition: 1 })
  await artikel(`${p} Limo`, limo.id, { rasterPosition: 2 })

  await anmelden(page, login)
  await page.goto('/kasse')
  const tab = page.getByRole('button', { name: new RegExp(`^${p} Bar`) })
  await tab.click()
  // Reiter in der Hex-Farbe der Hauptgruppe (#e76815)
  await expect(tab).toHaveCSS('background-color', 'rgb(231, 104, 21)')

  // ---- Hauptgruppe: 2 Untergruppen-Kacheln, dann Slot 1 leer, Cola (2), 3+4 leer, Radler (5)
  await expect(page.locator(KACHEL)).toHaveCount(7)
  const wurzel = await raster(page)
  expect(wurzel.map(z => z.typ)).toEqual([
    'untergruppe-kachel', 'untergruppe-kachel', 'raster-leer', 'artikel-kachel', 'raster-leer', 'raster-leer', 'artikel-kachel',
  ])
  expect(wurzel[0]!.text).toContain(`${p} Alkoholfrei`)
  expect(wurzel[1]!.text).toContain(`${p} Bier`)
  expect(wurzel[3]!.text).toContain(`${p} Cola`)
  expect(wurzel[6]!.text).toContain(`${p} Radler`)
  // Hex-Farben als berechnete Hintergrundfarbe: Kachel in Gruppenfarbe, Artikel-Akzent in eigener Farbe
  await expect(page.locator('[data-testid="untergruppe-kachel"]').first()).toHaveCSS('background-color', 'rgb(96, 170, 48)')
  await expect(page.locator('[data-testid="artikel-kachel"]').first().getByTestId('artikel-farbe')).toHaveCSS('background-color', 'rgb(70, 49, 35)')
  // Leere Felder sind nicht klickbar (kein Button)
  expect(await page.locator('[data-testid="raster-leer"]').first().evaluate(el => el.tagName)).toBe('DIV')

  // ---- hinein: Alkoholfrei → [Limonaden-Kachel, Soda]; Zurück-Zeile zeigt die Elterngruppe
  await page.locator('[data-testid="untergruppe-kachel"]').first().click()
  await expect(page.getByTestId('untergruppe-zurueck')).toHaveText(`◂ ${p} Bar`)
  expect((await raster(page)).map(z => z.typ)).toEqual(['untergruppe-kachel', 'artikel-kachel'])
  // eine Ebene tiefer: Limonaden → [leer (Slot 1), Limo (Slot 2)]
  await page.locator('[data-testid="untergruppe-kachel"]').first().click()
  await expect(page.getByTestId('untergruppe-zurueck')).toHaveText(`◂ ${p} Alkoholfrei`)
  const tief = await raster(page)
  expect(tief.map(z => z.typ)).toEqual(['raster-leer', 'artikel-kachel'])
  expect(tief[1]!.text).toContain(`${p} Limo`)
  // zurück, zurück
  await page.getByTestId('untergruppe-zurueck').click()
  await expect(page.getByTestId('untergruppe-zurueck')).toHaveText(`◂ ${p} Bar`)
  await page.getByTestId('untergruppe-zurueck').click()
  await expect(page.getByTestId('untergruppe-zurueck')).toHaveCount(0)
  expect((await raster(page)).map(z => z.typ)).toHaveLength(7)

  // ---- Layout-Import in der Artikelverwaltung ------------------------------------------
  const flach = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Flach`, farbe: 'grau' })
  const impA = await artikel(`${p} Imp A`, flach.id)
  const impPfad = `${p} Imp/${p} ImpSub`
  const layout = {
    spalten: 3,
    gruppen: [{
      name: `${p} Imp`, farbe: '#112233', farbeGesetzt: true, reihenfolge: 1, artikel: [],
      untergruppen: [{
        name: `${p} ImpSub`, farbe: '#445566', farbeGesetzt: true, reihenfolge: 1, untergruppen: [],
        artikel: [
          { name: `${p} Imp B`, preisCent: 280, mwst: 0.1, farbe: null, slot: 1 },
          { name: `${p} Imp A`, preisCent: 999, mwst: 0.2, farbe: '#AABBCC', slot: 3 },
        ],
      }],
    }],
    favoriten: [{ name: `${p} Imp B`, pfad: impPfad }, { name: `${p} Imp A`, pfad: impPfad }],
  }
  const kategorienAlle = async () => (await (await request.get('/api/kategorien', { headers: auth })).json()) as { id: string; name: string; parentId: string | null; farbe: string }[]
  const artikelAlle = async () => (await (await request.get('/api/artikel?nurAktive=false', { headers: auth })).json()) as
    { id: string; bezeichnung: string; kategorieId: string | null; rasterPosition: number | null; farbe: string | null; preisBruttoCent: number; istFavorit: boolean; favoritenReihenfolge: number }[]

  await page.goto('/artikel')
  await page.getByRole('button', { name: 'Layout importieren (JSON)' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(layout)),
  })
  // Vorschau mit Bericht und den beiden Haken — geschrieben wird noch nichts
  await expect(dialog.getByText(/Vorschau — noch nichts geändert/)).toBeVisible()
  await expect(dialog.getByTestId('layout-bericht')).toContainText('2 im Layout')
  await expect(dialog.getByTestId('layout-bericht')).toContainText('1 neu angelegt')
  await expect(dialog.getByLabel('Fehlende Artikel anlegen')).toBeChecked()
  await expect(dialog.getByLabel(/Raster auf die Spaltenzahl/)).toBeChecked()
  expect((await kategorienAlle()).some(k => k.name === `${p} Imp`)).toBe(false)
  expect((await artikelAlle()).some(a => a.bezeichnung === `${p} Imp B`)).toBe(false)
  // Haken „Fehlende Artikel anlegen" aus → Vorschau rechnet neu: Imp B nicht angelegt
  await dialog.getByLabel('Fehlende Artikel anlegen').uncheck()
  await expect(dialog.getByTestId('layout-bericht')).toContainText('0 neu angelegt')
  await dialog.getByLabel('Fehlende Artikel anlegen').check()
  await expect(dialog.getByTestId('layout-bericht')).toContainText('1 neu angelegt')

  await dialog.getByRole('button', { name: 'Anwenden' }).click()
  await expect(dialog.getByText('Layout angewendet')).toBeVisible()
  await dialog.getByRole('button', { name: 'Fertig' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const kats = await kategorienAlle()
  const imp = kats.find(k => k.name === `${p} Imp`)!
  const sub = kats.find(k => k.name === `${p} ImpSub`)!
  expect(imp).toMatchObject({ parentId: null, farbe: '#112233' })
  expect(sub).toMatchObject({ parentId: imp.id, farbe: '#445566' })
  const arts = await artikelAlle()
  const a = arts.find(x => x.id === impA.id)!
  expect(a).toMatchObject({ kategorieId: sub.id, rasterPosition: 3, farbe: '#aabbcc', preisBruttoCent: 350, istFavorit: true, favoritenReihenfolge: 2 })
  const b = arts.find(x => x.bezeichnung === `${p} Imp B`)!
  expect(b).toMatchObject({ kategorieId: sub.id, rasterPosition: 1, preisBruttoCent: 280, istFavorit: true, favoritenReihenfolge: 1 })
  // Alle anderen Favoriten sind zurückgesetzt
  expect(arts.filter(x => x.istFavorit).map(x => x.bezeichnung).sort()).toEqual([`${p} Imp A`, `${p} Imp B`].sort())

  // ---- Kasse: Favoriten in fester Reihenfolge, 3 Spalten, Untergruppe mit Slot-Lücke --------
  await page.goto('/kasse')
  await page.getByRole('button', { name: /^⭐ Favoriten/ }).click()
  const favs = await raster(page)
  expect(favs.map(z => z.typ)).toEqual(['artikel-kachel', 'artikel-kachel'])
  expect(favs[0]!.text).toContain(`${p} Imp B`)
  expect(favs[1]!.text).toContain(`${p} Imp A`)
  const spalten = await page.locator('[data-testid="artikel-kachel"]').first().evaluate(
    el => getComputedStyle(el.parentElement!).gridTemplateColumns.split(' ').length)
  expect(spalten).toBe(3)

  await page.getByRole('button', { name: new RegExp(`^${p} Imp \\d`) }).click()
  await page.locator('[data-testid="untergruppe-kachel"]').first().click()
  // Imp B (Slot 1), Slot 2 leer, Imp A (Slot 3)
  const imSub = await raster(page)
  expect(imSub.map(z => z.typ)).toEqual(['artikel-kachel', 'raster-leer', 'artikel-kachel'])
  expect(imSub[0]!.text).toContain(`${p} Imp B`)
  expect(imSub[2]!.text).toContain(`${p} Imp A`)
  await expect(page.locator('[data-testid="artikel-kachel"]').nth(1).getByTestId('artikel-farbe')).toHaveCSS('background-color', 'rgb(170, 187, 204)')
})


// ---------------------------------------------------------------------------
// Retoure: Pfand-Rückgabe (negativer Artikelpreis) → Gesamt unter 0 → bar zurück
// ---------------------------------------------------------------------------

test('Kasse: Becher retour (−2,00) in den Warenkorb → Gesamt negativ → Rückzahlung bar abschließen', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const token = login.token
  const auth = { Authorization: `Bearer ${token}` }
  const p = `Neg${Date.now() % 1_000_000}`

  const kat = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Pfand`, farbe: 'grau' })
  const becher = await post<{ id: string; preisBruttoCent: number }>(request, token, '/api/artikel', {
    bezeichnung: `${p} Becher retour`, preisBruttoCent: -200, mwstSatz: 'null', kategorieId: kat.id,
  })
  expect(becher.preisBruttoCent).toBe(-200)

  await anmelden(page, login)
  await page.goto('/kasse')
  await page.getByPlaceholder(/Artikel suchen/).fill(`${p} Becher`)
  await page.getByRole('button', { name: new RegExp(`^${p} Becher retour`) }).first().click()

  // Gesamt: −2,00 € (Anzeige mit Minus), der Bar-Knopf zeigt den negativen Betrag, nicht 0
  const zuZahlen = page.getByText('Zu zahlen').locator('..')
  await expect(zuZahlen).toContainText(/[-−–]\s*(€\s*)?2,00|2,00\s*[-−–]/)
  const barKnopf = page.getByRole('button', { name: /^Bar \(/ })
  await expect(barKnopf).toContainText(/[-−–]/)
  await barKnopf.click()
  await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible()

  // Beleg wurde mit negativem Gesamtbetrag gebucht
  const liste = await (await request.get(`/api/belege?kasseId=${login.kassen[0]!.id}&limit=5`, { headers: auth })).json() as
    { gesamtbetragCent: number; positionen: { bezeichnung: string; einzelpreisBreutto: number; menge: number }[] }[]
  const retoure = liste.find(b => b.positionen.some(x => x.bezeichnung === `${p} Becher retour`))!
  expect(retoure.gesamtbetragCent).toBe(-200)
  expect(retoure.positionen[0]).toMatchObject({ einzelpreisBreutto: -200, menge: 1 })
})

// ---------------------------------------------------------------------------
// Sauberer Neustart: Haken, rote Warnung, Tipp-Bestätigung, Ergebnis in der Kasse
// (löscht den GESAMTEN Katalog der E2E-Instanz — deshalb als letzter Test der Suite)
// ---------------------------------------------------------------------------

test('Layout-Import Sauberer Neustart: rote Warnung, Anwenden erst nach LOESCHEN, Ergebnis in der Kasse', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const token = login.token
  const auth = { Authorization: `Bearer ${token}` }
  const p = `Clean${Date.now() % 1_000_000}`

  const alt = await post<{ id: string }>(request, token, '/api/kategorien', { name: `${p} Altgruppe`, farbe: 'rot' })
  await post(request, token, '/api/artikel', { bezeichnung: `${p} Altartikel`, preisBruttoCent: 100, mwstSatz: 'normal', kategorieId: alt.id })

  const layout = {
    spalten: 3,
    gruppen: [{
      name: `${p} Neu`, farbe: '#336699', farbeGesetzt: true, reihenfolge: 1, station: 'schank', untergruppen: [],
      artikel: [{
        name: `${p} Neuartikel`, preisCent: 450, mwst: 0.2, slot: 2, farbe: null,
        optionen: [{ gruppe: 'Variante', pflicht: false, mehrfach: false, optionen: [{ name: 'mit Eis', aufschlagCent: 0 }, { name: 'Ohne Soda', aufschlagCent: -200 }] }],
      }],
    }],
    favoriten: [{ name: `${p} Neuartikel`, pfad: `${p} Neu` }],
  }

  await anmelden(page, login)
  await page.goto('/artikel')
  await page.getByRole('button', { name: 'Layout importieren (JSON)' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(layout)) })
  await expect(dialog.getByText(/Vorschau — noch nichts geändert/)).toBeVisible()

  // Standard AUS: keine Warnung, Anwenden frei
  const haken = dialog.getByLabel(/Sauberer Neustart/)
  await expect(haken).not.toBeChecked()
  await expect(dialog.getByTestId('loesch-warnung')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Anwenden' })).toBeEnabled()

  // Haken an: Vorschau rechnet neu, roter Warnblock mit Zahlen, Anwenden gesperrt
  await haken.check()
  const warnung = dialog.getByTestId('loesch-warnung')
  await expect(warnung).toBeVisible()
  await expect(warnung).toContainText('LÖSCHT den bisherigen Katalog')
  await expect(warnung).toContainText('auch bei Wiederholung')
  await expect(warnung).toHaveClass(/border-red/)
  const anwenden = dialog.getByRole('button', { name: 'Anwenden' })
  await expect(anwenden).toBeDisabled()
  const artikelAlle = async () => (await (await request.get('/api/artikel?nurAktive=false', { headers: auth })).json()) as { id: string; bezeichnung: string; aktiv: boolean }[]
  expect((await artikelAlle()).some(a => a.bezeichnung === `${p} Altartikel`)).toBe(true)   // Vorschau löscht nichts

  const eingabe = dialog.getByLabel('Bestätigung: LOESCHEN eintippen')
  await eingabe.fill('loeschen')
  await expect(anwenden).toBeDisabled()
  await eingabe.fill('LOESCHEN')
  await expect(anwenden).toBeEnabled()
  await anwenden.click()
  await expect(dialog.getByText('Layout angewendet')).toBeVisible()
  await dialog.getByRole('button', { name: 'Fertig' }).click()

  // Altbestand hart gelöscht, neuer Katalog mit Optionen und Station da
  const nachher = await artikelAlle()
  expect(nachher.some(a => a.bezeichnung === `${p} Altartikel`)).toBe(false)
  expect(nachher.filter(a => a.aktiv).map(a => a.bezeichnung)).toEqual([`${p} Neuartikel`])
  const kats = (await (await request.get('/api/kategorien', { headers: auth })).json()) as { name: string; station: string | null }[]
  expect(kats.some(k => k.name === `${p} Altgruppe`)).toBe(false)
  expect(kats.find(k => k.name === `${p} Neu`)).toMatchObject({ station: 'schank' })
  const mods = (await (await request.get('/api/modifikator-gruppen', { headers: auth })).json()) as { name: string; modifikatoren: { name: string; aufschlagCent: number }[] }[]
  expect(mods.map(m => m.name)).toEqual(['Variante (mit Eis / Ohne Soda)'])
  expect(mods[0]!.modifikatoren.map(m => [m.name, m.aufschlagCent])).toEqual([['mit Eis', 0], ['Ohne Soda', -200]])

  // Kasse zeigt den neuen Katalog (Slot-Lücke), nicht den alten
  await page.goto('/kasse')
  await page.getByRole('button', { name: new RegExp(`^${p} Neu \\d`) }).click()
  const zellen = await raster(page)
  expect(zellen.map(z => z.typ)).toEqual(['raster-leer', 'artikel-kachel'])
  expect(zellen[1]!.text).toContain(`${p} Neuartikel`)
  await expect(page.getByText(`${p} Altgruppe`)).toHaveCount(0)
})
