import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import * as XLSX from 'xlsx'

/**
 * Stammdaten: deaktivierte Warengruppen und Artikel sind in der Verwaltung sichtbar und
 * reaktivierbar — und tauchen dort, wo nur Aktives zählt (Kasse, Auswahlfelder, Konfiguration),
 * nicht auf.
 *
 * Regressions-Guard: der Server las `?nurAktive=false` als true (z.coerce.boolean →
 * Boolean("false") === true). Die Verwaltung zeigte Deaktiviertes nie, es gab keinen
 * Reaktivieren-Knopf, und der Excel-Import fand deaktivierte Artikel nicht als Duplikate.
 * Seit der Korrektur bekommen Betriebsseiten ausdrücklich nur Aktives (nurAktive=true) —
 * sonst stünden plötzlich deaktivierte Gruppen in Auswahlfeldern und an der Kasse.
 *
 * Jede „nicht sichtbar"-Prüfung steht hinter einer Positivkontrolle (eine aktive Gruppe
 * derselben Seite ist da) — sonst bestünde sie auch gegen eine noch leere Seite.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet
 * adminLogin() die Instanz notfalls selbst ein.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

type Login = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }

// Einmal je Datei anmelden: /api/auth/login ist je IP auf 10/min begrenzt,
// und die ganze Suite teilt sich 127.0.0.1 (Muster ensureAuth in onboarding).
let gemerkterLogin: Login | null = null

async function adminLogin(request: APIRequestContext): Promise<Login> {
  gemerkterLogin ??= await neuerAdminLogin(request)
  return gemerkterLogin
}

async function neuerAdminLogin(request: APIRequestContext): Promise<Login> {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Stammdaten GmbH',
        uid:        'ATU76543210',
        kassenId:   'E2E-STAMM-001',
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
  return res.json() as Promise<Login>
}

/** Auth + Kassen-Identität in den Browser injizieren (statt Login-Oberfläche) */
async function anmelden(page: Page, login: Login) {
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
}

async function anlegen(request: APIRequestContext, auth: Record<string, string>, url: string, data: object): Promise<{ id: string }> {
  const res = await request.post(url, { headers: auth, data })
  expect(res.ok(), `POST ${url}: ${await res.text()}`).toBe(true)
  return res.json() as Promise<{ id: string }>
}

async function deaktivieren(request: APIRequestContext, auth: Record<string, string>, url: string): Promise<void> {
  const res = await request.delete(url, { headers: auth })
  expect(res.ok(), `DELETE ${url}: ${await res.text()}`).toBe(true)
}

/** Aufräumen im finally: nie werfen (sonst verdeckt es den eigentlichen Fehler) — Folge-Specs teilen sich die Instanz */
async function aufraeumen(request: APIRequestContext, auth: Record<string, string>, urls: string[]): Promise<void> {
  for (const url of urls) await request.delete(url, { headers: auth }).catch(() => undefined)
}

/** Über das Kopfmenü navigieren (client-seitig, ohne Neuladen — der React-Query-Cache bleibt erhalten) */
async function ueberMenue(page: Page, gruppe: string, eintrag: string) {
  await page.getByRole('button', { name: gruppe, exact: true }).click()
  await page.getByRole('link', { name: eintrag, exact: true }).click()
}

const artikelTabelle = (page: Page) =>
  page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Bezeichnung' }) })
const kategorieTabelle = (page: Page) =>
  page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Farbe' }) })

test.beforeEach(async ({ page, request }) => {
  await anmelden(page, await adminLogin(request))
})

// ---------------------------------------------------------------------------

test('Warengruppen: deaktivierte sichtbar und reaktivierbar — in Kasse und Auswahlfeldern nicht', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const ts       = Date.now()
  const aktiv    = `Aktivgruppe ${ts}`
  const inaktiv  = `Sommerkarte ${ts}`
  const cola     = `Cola ${ts}`
  const hugo     = `Hugo ${ts}`

  const gAktiv   = await anlegen(request, auth, '/api/kategorien', { name: aktiv,   farbe: 'blau', reihenfolge: 90 })
  const gInaktiv = await anlegen(request, auth, '/api/kategorien', { name: inaktiv, farbe: 'grau', reihenfolge: 91 })
  const aCola    = await anlegen(request, auth, '/api/artikel', { bezeichnung: cola, preisBruttoCent: 390, mwstSatz: 'normal', kategorieId: gAktiv.id })
  // Aktiver Artikel in einer Gruppe, die gleich deaktiviert wird
  const aHugo    = await anlegen(request, auth, '/api/artikel', { bezeichnung: hugo, preisBruttoCent: 650, mwstSatz: 'normal', kategorieId: gInaktiv.id })
  await deaktivieren(request, auth, `/api/kategorien/${gInaktiv.id}`)

  const kasseReiter = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) })

  try {
    // ---- Artikelverwaltung: Warengruppe ist sichtbar (Filter, Artikelzeile, Tabelle) ----
    await page.goto('/artikel')
    const hugoZeile = artikelTabelle(page).getByRole('row').filter({ hasText: hugo })
    await expect(artikelTabelle(page).getByRole('row').filter({ hasText: cola })).toBeVisible()
    // Name der (deaktivierten) Warengruppe wird aufgelöst, statt „—" zu zeigen
    await expect(hugoZeile).toContainText(inaktiv)

    const filter = page.getByLabel('Nach Warengruppe filtern')
    await expect(filter.getByRole('option', { name: aktiv, exact: true })).toHaveCount(1)
    await expect(filter.getByRole('option', { name: `${inaktiv} (deaktiviert)`, exact: true })).toHaveCount(1)

    await page.getByRole('button', { name: /^Kategorien/ }).click()
    const aktivZeile   = kategorieTabelle(page).getByRole('row').filter({ hasText: aktiv })
    const inaktivZeile = kategorieTabelle(page).getByRole('row').filter({ hasText: inaktiv })
    await expect(aktivZeile.getByRole('button', { name: 'Deaktivieren' })).toBeVisible()
    await expect(aktivZeile.getByRole('button', { name: 'Reaktivieren' })).toHaveCount(0)
    await expect(inaktivZeile).toContainText('deaktiviert')
    await expect(inaktivZeile.getByRole('button', { name: 'Reaktivieren' })).toBeVisible()
    await expect(inaktivZeile.getByRole('button', { name: 'Deaktivieren' })).toHaveCount(0)

    // ---- Artikel-Formular: Auswahl Warengruppe ----
    // Artikel in der deaktivierten Gruppe: sie steht als Auswahl da (statt einer leeren, die beim
    // Speichern den Artikel still aus seiner Gruppe löste)
    await hugoZeile.getByRole('button', { name: 'Bearbeiten' }).click()
    const dialog = page.getByRole('dialog')
    const warengruppe = dialog.locator('select').filter({ has: page.locator('option', { hasText: '— ohne Warengruppe —' }) })
    await expect(warengruppe).toHaveValue(gInaktiv.id)
    await expect(warengruppe.locator('option:checked')).toHaveText(`${inaktiv} (deaktiviert)`)
    await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // Neuer Artikel: nur aktive Gruppen wählbar
    await page.getByRole('button', { name: '+ Neuer Artikel' }).click()
    const neuWarengruppe = dialog.locator('select').filter({ has: page.locator('option', { hasText: '— ohne Warengruppe —' }) })
    await expect(neuWarengruppe.getByRole('option', { name: aktiv, exact: true })).toHaveCount(1)
    await expect(neuWarengruppe.getByRole('option', { name: new RegExp(inaktiv) })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // ---- Kasse (per Menü, ohne Neuladen: die Verwaltung hat „alle" Gruppen im Cache) ----
    await ueberMenue(page, 'Verkauf', 'Kasse')
    await expect(kasseReiter(aktiv)).toBeVisible()
    await expect(kasseReiter(inaktiv)).toHaveCount(0)

    // ---- Aktionen: Warengruppen-Auswahl ----
    await ueberMenue(page, 'Artikel & Lager', 'Aktionen')
    await page.getByRole('button', { name: '+ Neue Aktion' }).click()
    await expect(page.getByRole('button', { name: aktiv, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: inaktiv, exact: true })).toHaveCount(0)
    await expect(page.getByRole('option', { name: inaktiv, exact: true })).toHaveCount(0)
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen', exact: true }).click()

    // ---- Lagerstand: „Warengruppe in Lagerführung aufnehmen" ----
    await ueberMenue(page, 'Artikel & Lager', 'Lagerstand')
    const lagerAuswahl = page.locator('select').filter({ has: page.locator('option', { hasText: 'Alle Artikel (ohne Kategorie)' }) })
    await expect(lagerAuswahl.getByRole('option', { name: aktiv, exact: true })).toHaveCount(1)
    await expect(lagerAuswahl.getByRole('option', { name: inaktiv, exact: true })).toHaveCount(0)

    // ---- POS-Konfiguration: Reihenfolge/Sichtbarkeit nur für aktive Gruppen ----
    await ueberMenue(page, 'Einstellungen', 'POS-Konfig')
    await expect(page.getByText(aktiv, { exact: true }).first()).toBeAttached()
    await expect(page.getByText(inaktiv, { exact: true })).toHaveCount(0)

    // ---- Einstellungen → Warengruppen-Verteilung (Matrix Warengruppe × Kasse) ----
    await ueberMenue(page, 'Einstellungen', 'Einstellungen')
    await expect(page.getByRole('cell', { name: aktiv, exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: inaktiv, exact: true })).toHaveCount(0)

    // ---- Zurück in die Verwaltung: Warengruppe reaktivieren ----
    await ueberMenue(page, 'Artikel & Lager', 'Artikel')
    await page.getByRole('button', { name: /^Kategorien/ }).click()
    await expect(inaktivZeile).toContainText('deaktiviert')
    await inaktivZeile.getByRole('button', { name: 'Reaktivieren' }).click()
    await expect(inaktivZeile.getByRole('button', { name: 'Deaktivieren' })).toBeVisible()
    await expect(inaktivZeile.getByRole('button', { name: 'Reaktivieren' })).toHaveCount(0)
    await expect(inaktivZeile).not.toContainText('deaktiviert')

    const aktiveGruppen = await (await request.get('/api/kategorien?nurAktive=true', { headers: auth })).json() as { id: string }[]
    expect(aktiveGruppen.map(k => k.id)).toContain(gInaktiv.id)

    // ---- …und nun auch an der Kasse und in den Auswahlfeldern da ----
    await ueberMenue(page, 'Verkauf', 'Kasse')
    await expect(kasseReiter(aktiv)).toBeVisible()
    await expect(kasseReiter(inaktiv)).toBeVisible()

    await ueberMenue(page, 'Artikel & Lager', 'Aktionen')
    await page.getByRole('button', { name: '+ Neue Aktion' }).click()
    await expect(page.getByRole('button', { name: inaktiv, exact: true })).toBeVisible()
  } finally {
    await aufraeumen(request, auth, [
      `/api/artikel/${aCola.id}`, `/api/artikel/${aHugo.id}`,
      `/api/kategorien/${gAktiv.id}`, `/api/kategorien/${gInaktiv.id}`,
    ])
  }
})

// ---------------------------------------------------------------------------

test('Artikel: deaktivierte per Häkchen sichtbar und reaktivierbar', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }

  const ts       = Date.now()
  const aktiv    = `Almdudler ${ts}`
  const inaktiv  = `Spritzer ${ts}`
  const kandidat = `Kandidat ${ts}`
  const a1 = await anlegen(request, auth, '/api/artikel', { bezeichnung: aktiv,    preisBruttoCent: 390, mwstSatz: 'normal' })
  const a2 = await anlegen(request, auth, '/api/artikel', { bezeichnung: inaktiv,  preisBruttoCent: 450, mwstSatz: 'normal' })
  const a3 = await anlegen(request, auth, '/api/artikel', { bezeichnung: kandidat, preisBruttoCent: 120, mwstSatz: 'normal' })
  await deaktivieren(request, auth, `/api/artikel/${a2.id}`)

  try {
    await page.goto('/artikel')
    const aktivZeile   = artikelTabelle(page).getByRole('row').filter({ hasText: aktiv })
    const inaktivZeile = artikelTabelle(page).getByRole('row').filter({ hasText: inaktiv })

    // Standard „Nur aktive Artikel anzeigen": Liste geladen (aktiver da), der deaktivierte fehlt
    await expect(aktivZeile).toBeVisible()
    await expect(inaktivZeile).toHaveCount(0)

    // Häkchen weg → er erscheint, als deaktiviert gekennzeichnet und mit „Reaktivieren"
    await page.getByLabel('Nur aktive Artikel anzeigen').uncheck()
    await expect(inaktivZeile).toBeVisible()
    await expect(inaktivZeile).toContainText('deaktiviert')
    await expect(inaktivZeile.getByRole('button', { name: 'Deaktivieren' })).toHaveCount(0)
    await expect(aktivZeile.getByRole('button', { name: 'Reaktivieren' })).toHaveCount(0)

    // Rezept-Auswahl im Formular: Bestandteile nur aus aktiven Artikeln — auch wenn die Liste
    // gerade Deaktiviertes zeigt
    await aktivZeile.getByRole('button', { name: 'Bearbeiten' }).click()
    const dialog      = page.getByRole('dialog')
    const bestandteil = dialog.getByLabel('Bestandteil wählen')
    await expect(bestandteil.getByRole('option', { name: new RegExp(kandidat) })).toHaveCount(1)
    await expect(bestandteil.getByRole('option', { name: new RegExp(inaktiv) })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    await inaktivZeile.getByRole('button', { name: 'Reaktivieren' }).click()
    await expect(inaktivZeile.getByRole('button', { name: 'Deaktivieren' })).toBeVisible()
    await expect(inaktivZeile.getByRole('button', { name: 'Reaktivieren' })).toHaveCount(0)

    const aktive = await (await request.get('/api/artikel?nurAktive=true', { headers: auth })).json() as { id: string }[]
    expect(aktive.map(a => a.id)).toContain(a2.id)

    // Häkchen wieder an: der reaktivierte bleibt, jetzt als regulär aktiver
    await page.getByLabel('Nur aktive Artikel anzeigen').check()
    await expect(inaktivZeile).toBeVisible()
    await expect(inaktivZeile).not.toContainText('deaktiviert')
  } finally {
    await aufraeumen(request, auth, [`/api/artikel/${a1.id}`, `/api/artikel/${a2.id}`, `/api/artikel/${a3.id}`])
  }
})

// ---------------------------------------------------------------------------

test('Excel-Import: ein deaktivierter Artikel wird als bereits vorhanden erkannt und lässt sich aktivieren', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth  = { Authorization: `Bearer ${login.token}` }

  const ts     = Date.now()
  const radler = `Radler ${ts}`
  const alt = await anlegen(request, auth, '/api/artikel', { bezeichnung: radler, preisBruttoCent: 400, mwstSatz: 'normal' })
  await deaktivieren(request, auth, `/api/artikel/${alt.id}`)

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Bezeichnung', 'Preis (EUR)', 'MwSt-Satz', 'KDS-Station', 'Kategorie', 'Lagerstand', 'Anfangsbestand', 'Mindestbestand'],
    [radler.toUpperCase(), '4,80', '20 %', '', '', 'Nein', '', ''],
  ]), 'Artikel')
  const datei = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)

  const artikelMitName = async () =>
    ((await (await request.get('/api/artikel?nurAktive=false', { headers: auth })).json()) as
      { id: string; bezeichnung: string; aktiv: boolean; preisBruttoCent: number }[])
      .filter(a => a.bezeichnung === radler)

  try {
    await page.goto('/artikel')
    await expect(page.getByRole('heading', { name: 'Artikel', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Importieren', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'artikel.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: datei,
    })

    // Der deaktivierte Artikel zählt als vorhanden (Groß-/Kleinschreibung egal) — samt Hinweis
    await expect(dialog.getByText('1 Artikel gibt es in derselben Warengruppe schon')).toBeVisible()
    await expect(dialog.getByText(new RegExp(`Schon vorhanden: ${radler}.*deaktiviert`))).toBeVisible()
    // Standard: überspringen → es gäbe nichts zu tun
    await expect(dialog.getByRole('button', { name: '0 Artikel importieren', exact: true })).toBeDisabled()

    await dialog.getByRole('button', { name: 'Vorhandene aktualisieren' }).click()
    await expect(dialog.getByRole('option', { name: 'Vorhandenen aktualisieren + aktivieren' })).toBeAttached()
    await dialog.getByRole('button', { name: '1 aktualisieren', exact: true }).click()
    await expect(dialog.getByText('Import abgeschlossen')).toBeVisible()
    await expect(dialog.getByText('1 vorhandene aktualisiert.')).toBeVisible()
    await dialog.getByText('Schließen', { exact: true }).click()

    // Kein zweiter Radler; der vorhandene ist wieder aktiv und hat den neuen Preis
    const danach = await artikelMitName()
    expect(danach).toHaveLength(1)
    expect(danach[0]).toMatchObject({ id: alt.id, aktiv: true, preisBruttoCent: 480 })
  } finally {
    await aufraeumen(request, auth, (await artikelMitName().catch(() => [])).map(a => `/api/artikel/${a.id}`))
  }
})
