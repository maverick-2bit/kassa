import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

/**
 * Artikel BEARBEITEN speichert alle Felder des Formulars.
 *
 * Fehler bis v0.8.35: Das Speichern eines BESTEHENDEN Artikels schickte nur einen Teil der Formularfelder mit —
 * „Eigene Farbe", Lieferant, Mindestbestand, Rohstoff-Flag, Bonierbon-Option, Seriennummern und die
 * Zusammensetzung (Rezept) gingen still verloren (Meldung „Gespeichert" gab es gar nicht erst, der Dialog schloss
 * sich einfach). Zusätzlich kannte der Server den Lieferanten eines Artikels nicht (Bestellliste ohne Lieferant)
 * und beim NEU-Anlegen auch den Mindestbestand nicht.
 *
 * Jede Änderung wird dreifach geprüft: im Formular nach frischem Laden der Seite, in GET /api/artikel und — wo es
 * eine Folgeseite gibt — dort (Bestellliste).
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet adminLogin() die Instanz notfalls
 * selbst ein. Legt nur eigene, eindeutig benannte Daten an und räumt nichts anderes ab — daher ein normales
 * Spec (kein zzz-).
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

interface ArtikelDto {
  id: string
  bezeichnung: string
  preisBruttoCent: number
  farbe: string | null
  lieferantId: string | null
  lagerstandAktiv: boolean
  lagerstandMenge: number | null
  mindestbestand: number | null
  bonierBeiDirektverkauf: boolean
  seriennummernAktiv: boolean
  istBestandteil: boolean
  bestandteile: { bestandteilArtikelId: string; menge: number }[]
  verfuegbareMenge?: number | null
}

type AuthHeader = { Authorization: string }

/** Instanz bereit, Admin angemeldet, Browser-Sitzung vorbelegt. */
async function vorbereiten(page: Page, request: APIRequestContext): Promise<AuthHeader> {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login = await adminLogin(request)
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
  return { Authorization: `Bearer ${login.token}` }
}

async function legeAn<T = { id: string }>(request: APIRequestContext, auth: AuthHeader, pfad: string, data: object): Promise<T> {
  const res = await request.post(pfad, { headers: auth, data })
  if (!res.ok()) throw new Error(`POST ${pfad} (${res.status()}): ${await res.text()}`)
  return res.json() as Promise<T>
}

/** Der Artikel, wie ihn die API jetzt liefert (nicht die Oberfläche). */
async function ausDerApi(request: APIRequestContext, auth: AuthHeader, id: string): Promise<ArtikelDto> {
  const liste = (await (await request.get('/api/artikel', { headers: auth })).json()) as ArtikelDto[]
  const a = liste.find(x => x.id === id)
  if (!a) throw new Error(`Artikel ${id} fehlt in GET /api/artikel`)
  return a
}

/** Artikelliste frisch laden (volle Navigation = neu geladene Seite), Artikel suchen, „Bearbeiten" öffnen. */
async function oeffneBearbeiten(page: Page, bezeichnung: string): Promise<Locator> {
  await page.goto('/artikel')
  await expect(page.getByRole('heading', { name: 'Artikel', exact: true })).toBeVisible()
  await page.getByLabel('Artikel suchen').fill(bezeichnung)
  await page.getByRole('row').filter({ hasText: bezeichnung }).getByRole('button', { name: 'Bearbeiten', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Artikel bearbeiten' })).toBeVisible()
  return dialog
}

/** „Speichern" und warten, bis sich der Dialog schließt (bei einem Fehler bleibt er mit roter Meldung offen). */
async function speichern(dialog: Locator, knopf: 'Speichern' | 'Anlegen' = 'Speichern') {
  await dialog.getByRole('button', { name: knopf, exact: true }).click()
  await expect(dialog).toBeHidden()
}

/**
 * „Eigene Farbe" ist ein nativer Farbwähler. fill() setzt dessen Wert direkt an der Instanz und React
 * merkt die Änderung dann nicht — daher über den Prototyp-Setter + input-Ereignis, wie es ein Anwender auslöst.
 */
async function setzeEigeneFarbe(dialog: Locator, hex: string) {
  await dialog.locator('input[type="color"]').evaluate((el, wert) => {
    const feld = el as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(feld, wert)
    feld.dispatchEvent(new Event('input', { bubbles: true }))
  }, hex)
  // React hat die Farbe übernommen: der Farbwähler gilt jetzt als „eigene Farbe" (Rahmen hervorgehoben)
  await expect(dialog.locator('label[title^="Eigene Farbe"]')).toHaveClass(/ring-2/)
}

// Felder ohne verknüpfte Beschriftung (Field hat kein htmlFor) — über Platzhalter bzw. über ihre Auswahlpunkte.
// Der innere Locator von `has` wird relativ zum <select> ausgewertet und muss daher von der Seite aus gebaut sein.
const bestandFeld        = (d: Locator) => d.getByPlaceholder('z. B. 12', { exact: true })
const mindestbestandFeld = (d: Locator) => d.getByPlaceholder('z. B. 3',  { exact: true })
const lieferantAuswahl   = (d: Locator) =>
  d.locator('select', { has: d.page().locator('option', { hasText: 'Kein Lieferant' }) })

const lagerFuehren    = (d: Locator) => d.getByRole('checkbox', { name: /Lager führen/ })
const seriennummern   = (d: Locator) => d.getByRole('checkbox', { name: /Seriennummern verwalten/ })
const bonierbonDirekt = (d: Locator) => d.getByRole('checkbox', { name: /Bonierbon auch beim Direktverkauf/ })
const rohstoffFlag    = (d: Locator) => d.getByRole('checkbox', { name: /Rohstoff \(nur Lager/ })

test('Bearbeiten speichert Eigene Farbe, Lieferant, Mindestbestand, Bonierbon-Option und Seriennummern', async ({ page, request }) => {
  const auth = await vorbereiten(page, request)
  const ts   = Date.now()
  const name = `Farbtest ${ts}`

  const lieferant1 = await legeAn<{ id: string; name: string }>(request, auth, '/api/lieferanten', { name: `E2E-Lieferant A ${ts}` })
  const lieferant2 = await legeAn<{ id: string; name: string }>(request, auth, '/api/lieferanten', { name: `E2E-Lieferant B ${ts}` })
  const kategorie  = await legeAn(request, auth, '/api/kategorien', { name: `Felder-WG ${ts}`, farbe: 'grau' })
  const artikel    = await legeAn(request, auth, '/api/artikel', {
    bezeichnung: name, preisBruttoCent: 350, mwstSatz: 'normal', kategorieId: kategorie.id,
    lieferantId: lieferant1.id, lagerstandAktiv: true, lagerstandMenge: 20, mindestbestand: 10,
  })

  // Ausgangslage: schon das ANLEGEN speichert Lieferant und Mindestbestand
  const vorher = await ausDerApi(request, auth, artikel.id)
  expect(vorher.lieferantId, 'Anlegen speichert den Lieferanten').toBe(lieferant1.id)
  expect(vorher.mindestbestand, 'Anlegen speichert den Mindestbestand').toBe(10)
  expect(vorher.farbe).toBeNull()
  expect(vorher.bonierBeiDirektverkauf).toBe(false)
  expect(vorher.seriennummernAktiv).toBe(false)

  // ---- bearbeiten ----
  let dialog = await oeffneBearbeiten(page, name)
  await expect(lieferantAuswahl(dialog)).toHaveValue(lieferant1.id)
  await expect(mindestbestandFeld(dialog)).toHaveValue('10')

  await setzeEigeneFarbe(dialog, '#336699')
  await lieferantAuswahl(dialog).selectOption(lieferant2.id)
  await bestandFeld(dialog).fill('2')              // unter dem Mindestbestand → die Bestellliste führt den Artikel auf
  await mindestbestandFeld(dialog).fill('4')
  await bonierbonDirekt(dialog).check()
  await seriennummern(dialog).check()
  await speichern(dialog)

  // ---- 1) die API liefert, was gespeichert wurde ----
  const nachher = await ausDerApi(request, auth, artikel.id)
  expect(nachher.farbe, 'Eigene Farbe').toBe('#336699')
  expect(nachher.lieferantId, 'Lieferant').toBe(lieferant2.id)
  expect(nachher.lagerstandAktiv).toBe(true)
  expect(nachher.lagerstandMenge, 'Bestand').toBe(2)
  expect(nachher.mindestbestand, 'Mindestbestand').toBe(4)
  expect(nachher.bonierBeiDirektverkauf, 'Bonierbon beim Direktverkauf').toBe(true)
  expect(nachher.seriennummernAktiv, 'Seriennummern').toBe(true)
  expect(nachher.bezeichnung).toBe(name)
  expect(nachher.preisBruttoCent).toBe(350)

  // ---- 2) das Formular zeigt es nach frischem Laden der Seite ----
  dialog = await oeffneBearbeiten(page, name)
  await expect(dialog.locator('input[type="color"]'), 'Eigene Farbe im Formular').toHaveValue('#336699')
  await expect(dialog.locator('label[title^="Eigene Farbe"]')).toHaveClass(/ring-2/)
  await expect(lieferantAuswahl(dialog), 'Lieferant im Formular').toHaveValue(lieferant2.id)
  await expect(lagerFuehren(dialog)).toBeChecked()
  await expect(bestandFeld(dialog)).toHaveValue('2')
  await expect(mindestbestandFeld(dialog), 'Mindestbestand im Formular').toHaveValue('4')
  await expect(bonierbonDirekt(dialog)).toBeChecked()
  await expect(seriennummern(dialog)).toBeChecked()
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()

  // ---- 3) Folgeseite: die Bestellliste kennt jetzt den Lieferanten des Artikels ----
  await page.goto('/bestellliste')
  await expect(page.getByRole('heading', { name: 'Bestellliste' })).toBeVisible()
  await page.getByRole('button', { name: lieferant2.name, exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()
})

test('Bearbeiten: das Rohstoff-Flag („ist Bestandteil") wird gespeichert und lässt sich wieder abwählen', async ({ page, request }) => {
  const auth = await vorbereiten(page, request)
  const name = `Rohstoff-Flag ${Date.now()}`
  const artikel = await legeAn(request, auth, '/api/artikel', { bezeichnung: name, preisBruttoCent: 0, mwstSatz: 'normal' })
  expect((await ausDerApi(request, auth, artikel.id)).istBestandteil).toBe(false)

  // anwählen
  let dialog = await oeffneBearbeiten(page, name)
  await expect(rohstoffFlag(dialog)).not.toBeChecked()
  await rohstoffFlag(dialog).check()
  await speichern(dialog)
  expect((await ausDerApi(request, auth, artikel.id)).istBestandteil, 'Rohstoff-Flag in der API').toBe(true)

  dialog = await oeffneBearbeiten(page, name)
  await expect(rohstoffFlag(dialog), 'Rohstoff-Flag im Formular').toBeChecked()

  // wieder abwählen
  await rohstoffFlag(dialog).uncheck()
  await speichern(dialog)
  expect((await ausDerApi(request, auth, artikel.id)).istBestandteil, 'abgewählt in der API').toBe(false)

  dialog = await oeffneBearbeiten(page, name)
  await expect(rohstoffFlag(dialog)).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()
})

test('Bearbeiten: Bestandteile (Rezept) hinzufügen, ändern und entfernen werden gespeichert', async ({ page, request }) => {
  const auth = await vorbereiten(page, request)
  const ts   = Date.now()
  const name = `Cappuccino ${ts}`
  const bohnen = { name: `Rohstoff Bohnen ${ts}`, menge: 50 }
  const milch  = { name: `Rohstoff Milch ${ts}`,  menge: 40 }

  const bohnenId = (await legeAn(request, auth, '/api/artikel', {
    bezeichnung: bohnen.name, preisBruttoCent: 0, mwstSatz: 'normal', istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: bohnen.menge,
  })).id
  const milchId = (await legeAn(request, auth, '/api/artikel', {
    bezeichnung: milch.name, preisBruttoCent: 0, mwstSatz: 'normal', istBestandteil: true, lagerstandAktiv: true, lagerstandMenge: milch.menge,
  })).id
  const artikel = await legeAn(request, auth, '/api/artikel', { bezeichnung: name, preisBruttoCent: 350, mwstSatz: 'normal' })

  const zeile  = (d: Locator, bestandteil: { name: string }) => d.getByRole('listitem').filter({ hasText: bestandteil.name })
  const rezept = async () => (await ausDerApi(request, auth, artikel.id)).bestandteile
    .map(b => ({ id: b.bestandteilArtikelId, menge: b.menge }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const sortiert = (...e: { id: string; menge: number }[]) => e.sort((a, b) => a.id.localeCompare(b.id))

  async function hinzufuegen(d: Locator, bestandteilId: string, bestandteil: { name: string }, menge: number) {
    await d.getByLabel('Bestandteil wählen', { exact: true }).selectOption(bestandteilId)
    await d.getByRole('button', { name: '+ Hinzufügen' }).click()
    await zeile(d, bestandteil).getByLabel('Menge', { exact: true }).fill(String(menge))
  }

  // ---- hinzufügen: 3 × Bohnen, 2 × Milch ----
  let dialog = await oeffneBearbeiten(page, name)
  await expect(dialog.getByRole('listitem')).toHaveCount(0)
  await hinzufuegen(dialog, bohnenId, bohnen, 3)
  await hinzufuegen(dialog, milchId, milch, 2)
  await speichern(dialog)

  expect(await rezept(), 'Rezept in der API').toEqual(sortiert({ id: bohnenId, menge: 3 }, { id: milchId, menge: 2 }))
  // abgeleitete Verfügbarkeit: min(50 / 3, 40 / 2) = 16 — das gespeicherte Rezept wirkt wirklich
  expect((await ausDerApi(request, auth, artikel.id)).verfuegbareMenge).toBe(16)

  dialog = await oeffneBearbeiten(page, name)
  await expect(dialog.getByRole('listitem'), 'Rezept im Formular').toHaveCount(2)
  await expect(zeile(dialog, bohnen).getByLabel('Menge', { exact: true })).toHaveValue('3')
  await expect(zeile(dialog, milch).getByLabel('Menge', { exact: true })).toHaveValue('2')

  // ---- ändern: Milch entfernen, Bohnen auf 5 ----
  await zeile(dialog, milch).getByRole('button', { name: 'Bestandteil entfernen' }).click()
  await zeile(dialog, bohnen).getByLabel('Menge', { exact: true }).fill('5')
  await speichern(dialog)

  expect(await rezept(), 'geändertes Rezept in der API').toEqual([{ id: bohnenId, menge: 5 }])
  expect((await ausDerApi(request, auth, artikel.id)).verfuegbareMenge).toBe(10)   // 50 / 5

  dialog = await oeffneBearbeiten(page, name)
  await expect(dialog.getByRole('listitem')).toHaveCount(1)
  await expect(zeile(dialog, bohnen).getByLabel('Menge', { exact: true })).toHaveValue('5')

  // ---- leeren ----
  await zeile(dialog, bohnen).getByRole('button', { name: 'Bestandteil entfernen' }).click()
  await speichern(dialog)

  expect(await rezept(), 'geleertes Rezept in der API').toEqual([])
  dialog = await oeffneBearbeiten(page, name)
  await expect(dialog.getByRole('listitem')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()
})

test('Neuer Artikel: Lieferant, Bestand, Mindestbestand und Eigene Farbe werden beim Anlegen gespeichert', async ({ page, request }) => {
  const auth = await vorbereiten(page, request)
  const ts   = Date.now()
  const name = `Neu-Artikel ${ts}`
  const lieferant = await legeAn<{ id: string; name: string }>(request, auth, '/api/lieferanten', { name: `E2E-Lieferant N ${ts}` })

  await page.goto('/artikel')
  await expect(page.getByRole('heading', { name: 'Artikel', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '+ Neuer Artikel' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Neuer Artikel' })).toBeVisible()

  await dialog.getByPlaceholder('Espresso', { exact: true }).fill(name)
  await dialog.getByPlaceholder('3,50', { exact: true }).fill('4,20')
  await setzeEigeneFarbe(dialog, '#aa5500')
  await lieferantAuswahl(dialog).selectOption(lieferant.id)
  await lagerFuehren(dialog).check()
  await bestandFeld(dialog).fill('8')
  await mindestbestandFeld(dialog).fill('2')
  await speichern(dialog, 'Anlegen')

  const liste = (await (await request.get('/api/artikel', { headers: auth })).json()) as ArtikelDto[]
  const neu   = liste.find(a => a.bezeichnung === name)
  expect(neu, 'der neue Artikel steht in GET /api/artikel').toBeTruthy()
  expect(neu!.preisBruttoCent).toBe(420)
  expect(neu!.farbe, 'Eigene Farbe').toBe('#aa5500')
  expect(neu!.lieferantId, 'Lieferant').toBe(lieferant.id)
  expect(neu!.lagerstandAktiv).toBe(true)
  expect(neu!.lagerstandMenge, 'Bestand').toBe(8)
  expect(neu!.mindestbestand, 'Mindestbestand').toBe(2)

  // …und das Formular zeigt es nach frischem Laden
  const bearbeiten = await oeffneBearbeiten(page, name)
  await expect(lieferantAuswahl(bearbeiten)).toHaveValue(lieferant.id)
  await expect(mindestbestandFeld(bearbeiten)).toHaveValue('2')
  await expect(bearbeiten.locator('input[type="color"]')).toHaveValue('#aa5500')
  await bearbeiten.getByRole('button', { name: 'Abbrechen' }).click()
})
