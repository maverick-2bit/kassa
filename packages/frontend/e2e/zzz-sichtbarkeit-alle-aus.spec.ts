import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

/**
 * Warengruppen-Sichtbarkeit je Kasse — „Alle sichtbar" / „Alle ausblenden" und Gruppen einzeln wählbar.
 *
 *  - Matrix „Warengruppen-Verteilung" (Einstellungen → Kassen) UND POS-Konfiguration → Warengruppen haben
 *    dieselben zwei Knöpfe „Alle sichtbar" / „Alle ausblenden" mit Tooltips und dasselbe Verhalten:
 *      · derselbe Knopf schaltet zwischen „alle sichtbar" und „alle ausgeblendet" um (zweiter Klick)
 *      · „alle ausgeblendet" ist nur ein Auswahl-NEUSTART in der Oberfläche: alle Haken leer, Hinweis
 *        „Noch nichts gespeichert …", es wird NICHTS gespeichert (leer = alle auf dem Server) und beim
 *        Neuladen/Verlassen gilt wieder der Serverstand
 *      · die erste danach gewählte Gruppe legt die neue Auswahl fest — genau diese Gruppe, ohne Untergruppen
 *      · „Alle sichtbar" stellt [] wieder her; die letzte gewählte Gruppe bleibt nicht abwählbar
 *  - Jede Gruppe wird UNABHÄNGIG gewählt: ein Haken gilt nur für seine Gruppe; der kleine Knopf „samt
 *    Untergruppen" schaltet Gruppe + Nachkommen auf einmal; eine Gruppe ohne eigenen Haken mit gewählter
 *    Untergruppe zeigt den Halbhaken (Zugang)
 *  - Kasse: „nur Alkoholfrei" zeigt dessen Artikel, aber keine Kacheln für Limonaden/Säfte; die Obergruppe ist nur
 *    Zugang (ohne eigene Artikel); danach „Limonaden" zusätzlich gewählt → die Kachel erscheint
 *  - Zusammenspiel mit der Kassen-Anordnung (POS-Konfiguration → Artikel): der Editor bietet nur Gruppen an, die
 *    an der Kasse eigene Artikel zeigen (ein reiner Zugang erscheint nicht, dafür ein kurzer Hinweis); der
 *    Reiter-Zähler der Kasse zählt nur gewählte Gruppen und keine an der Kasse ausgeblendeten Artikel
 *
 * Liegt am Ende der Suite (zzz-): ändert die Sichtbarkeitsliste der Kasse (am Schluss wieder []).
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

// Wortlaut wie in lib/sichtbarkeit.ts (SICHTBARKEIT_TEXTE) — absichtlich hier ausgeschrieben
const STATUS_ALLE          = 'alle sichtbar'
const STATUS_KEINE         = 'alle ausgeblendet (Auswahl wird gleich neu begonnen)'
const NEUSTART_HINWEIS     = 'Noch nichts gespeichert — die erste Warengruppe, die du jetzt einschaltest, legt die neue Auswahl fest. Solange gilt die bisherige Auswahl weiter.'
const LETZTE_HINWEIS_TEIL  = 'Mindestens eine Warengruppe muss an'

test.use({ serviceWorkers: 'block' })
test.setTimeout(150_000)

type Login = { token: string; user: { id: string }; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }

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

let gemerkterLogin: Login | null = null
async function adminLogin(request: APIRequestContext): Promise<Login> {
  if (gemerkterLogin) return gemerkterLogin
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-SICHT-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
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

interface Gruppe { id: string; name: string }

/**
 * Baum mit eindeutigen Namen (Präfix je Testlauf), Hauptgruppen mit hohen Reihenfolgen — sie stehen nach allen anderen:
 *
 *   Atriumbar
 *     Alkoholfrei
 *       Limonaden
 *       Säfte
 *     Bier
 *   Kellner
 *   Grillen
 */
async function legeBaumAn(request: APIRequestContext, auth: { Authorization: string }, p: string) {
  const gruppe = async (name: string, parentId: string | null, reihenfolge: number): Promise<Gruppe> => {
    const res = await request.post('/api/kategorien', { headers: auth, data: { name, farbe: 'grau', reihenfolge, parentId } })
    expect(res.ok(), await res.text()).toBe(true)
    return (await res.json()) as Gruppe
  }
  const atr  = await gruppe(`${p} Atriumbar`,  null,   6001)
  const alko = await gruppe(`${p} Alkoholfrei`, atr.id, 0)
  const limo = await gruppe(`${p} Limonaden`,   alko.id, 0)
  const saft = await gruppe(`${p} Säfte`,       alko.id, 1)
  const bier = await gruppe(`${p} Bier`,        atr.id, 1)
  const kel  = await gruppe(`${p} Kellner`,     null,   6002)
  const gril = await gruppe(`${p} Grillen`,     null,   6003)
  const pfade = {
    atr:  `${p} Atriumbar`,
    alko: `${p} Atriumbar › ${p} Alkoholfrei`,
    limo: `${p} Atriumbar › ${p} Alkoholfrei › ${p} Limonaden`,
    saft: `${p} Atriumbar › ${p} Alkoholfrei › ${p} Säfte`,
    bier: `${p} Atriumbar › ${p} Bier`,
    kel:  `${p} Kellner`,
    gril: `${p} Grillen`,
  }
  return { atr, alko, limo, saft, bier, kel, gril, pfade }
}

async function legeArtikelAn(request: APIRequestContext, auth: { Authorization: string }, bezeichnung: string, kategorieId: string): Promise<string> {
  const res = await request.post('/api/artikel', { headers: auth, data: { bezeichnung, preisBruttoCent: 250, mwstSatz: 'normal', kategorieId } })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { id: string }).id
}

/** Schreibzugriffe auf die Sichtbarkeit (PUT …/pos-config) mitzählen — „nichts gespeichert" ist so beweisbar. */
function zaehleSchreibzugriffe(page: Page) {
  const zaehler = { anzahl: 0 }
  page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/pos-config')) zaehler.anzahl++ })
  return zaehler
}

test('Matrix und POS-Konfiguration: „Alle sichtbar" / „Alle ausblenden", Toggle, Neustart und erste Gruppe', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const p = `Sk${Date.now() % 1_000_000}`
  const g = await legeBaumAn(request, auth, p)

  // Die Liste der Kasse (genau das, was der Server gespeichert hat)
  const liste = async () =>
    ((await (await request.get(`/api/kassen/${kasseId}/pos-config`, { headers: auth })).json()) as { sichtbareKategorieIds: string[] }).sichtbareKategorieIds
  const setzeListe = async (ids: string[]) =>
    expect((await request.put(`/api/kassen/${kasseId}/pos-config`, { headers: auth, data: { sichtbareKategorieIds: ids } })).status()).toBe(204)
  const sortiert = (ids: string[]) => [...ids].sort()
  const nurUnsere = (ids: string[]) => ids.filter(id => [g.atr, g.alko, g.limo, g.saft, g.bier, g.kel, g.gril].some(x => x.id === id))

  await setzeListe([])
  await anmelden(page, login)
  const schreib = zaehleSchreibzugriffe(page)
  // kurz warten, damit ein (fälschlich) ausgelöster Schreibzugriff schon angekommen wäre
  const nichtsGeschrieben = async (erwartet: number) => { await page.waitForTimeout(400); expect(schreib.anzahl).toBe(erwartet) }

  try {
    // =================================================================================
    // 1. Matrix „Warengruppen-Verteilung" (Einstellungen → Kassen)
    // =================================================================================
    await page.goto('/einstellungen?bereich=kassen')
    const matrix = page.locator('section', { has: page.getByRole('heading', { name: 'Warengruppen-Verteilung' }) })
    const kassenListe = (await (await request.get('/api/kassen', { headers: auth })).json()) as { id: string; kassenId: string; bezeichnung: string | null }[]
    const spalte = Math.max(0, kassenListe.findIndex(k => k.id === kasseId))
    // Mit mehreren Kassen steht der Kassenname vor dem Hinweis („Bar bei Anna: Noch nichts gespeichert …") — je Spalte ein Hinweis
    const kassenName = kassenListe[spalte]?.bezeichnung || kassenListe[spalte]?.kassenId || ''
    const matrixHinweis = kassenListe.length > 1 ? `${kassenName}: ${NEUSTART_HINWEIS}` : NEUSTART_HINWEIS
    const zeile = (pfad: string) => matrix.locator(`[data-testid="verteilung-zeile"][data-pfad="${pfad}"]`)
    const haken = (pfad: string) => zeile(pfad).locator('input[type="checkbox"]').nth(spalte)
    const teilbaum = (pfad: string) => zeile(pfad).getByTestId('teilbaum-knopf').nth(spalte)
    const status = matrix.getByTestId('verteilung-status').nth(spalte)
    const sichtbarKnopf = matrix.getByTestId('verteilung-alle-sichtbar').nth(spalte)
    const ausblendenKnopf = matrix.getByTestId('verteilung-alle-ausblenden').nth(spalte)
    const neustartHinweis = matrix.getByTestId('verteilung-neustart-hinweis')
    const unsere = Object.values(g.pfade)
    await expect(zeile(g.pfade.atr)).toBeVisible({ timeout: 15_000 })

    // ---- (1) zwei klar beschriftete Knöpfe mit Tooltips; Ausgangslage: alle sichtbar ----
    await expect(sichtbarKnopf).toHaveText('Alle sichtbar')
    await expect(ausblendenKnopf).toHaveText('Alle ausblenden')
    await expect(sichtbarKnopf).toHaveAttribute('title', /blendet alle aus/)               // der zweite Klick blendet alle aus
    await expect(ausblendenKnopf).toHaveAttribute('title', /Bis dahin wird nichts gespeichert/)
    await expect(status).toHaveText(STATUS_ALLE)
    await expect(sichtbarKnopf).toHaveAttribute('aria-pressed', 'true')
    await expect(ausblendenKnopf).toHaveAttribute('aria-pressed', 'false')
    for (const pfad of unsere) await expect(haken(pfad)).toBeChecked()
    await expect(neustartHinweis).toHaveCount(0)

    // ---- (2) Toggle: „Alle sichtbar" bei „alle sichtbar" → alle ausgeblendet — nichts gespeichert ----
    await sichtbarKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    for (const pfad of unsere) await expect(haken(pfad)).not.toBeChecked()
    await expect(neustartHinweis).toHaveText(matrixHinweis)
    await expect(ausblendenKnopf).toHaveAttribute('aria-pressed', 'true')
    await expect(sichtbarKnopf).toHaveAttribute('aria-pressed', 'false')
    expect(await liste()).toEqual([])
    await nichtsGeschrieben(0)

    // „Alle ausblenden" im Ausblend-Zustand → zurück auf „alle sichtbar" (ebenfalls ohne zu speichern: Server stand schon auf [])
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_ALLE)
    for (const pfad of unsere) await expect(haken(pfad)).toBeChecked()
    await expect(neustartHinweis).toHaveCount(0)
    expect(await liste()).toEqual([])
    await nichtsGeschrieben(0)

    // ---- (3) „Alle ausblenden" aus „alle sichtbar": Neustart; Neuladen/Verlassen zeigt wieder den Serverstand ----
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    await page.reload()
    await expect(zeile(g.pfade.atr)).toBeVisible({ timeout: 15_000 })
    await expect(status).toHaveText(STATUS_ALLE)                                            // nie still „alle ausgeblendet"
    for (const pfad of unsere) await expect(haken(pfad)).toBeChecked()
    await expect(neustartHinweis).toHaveCount(0)
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    await page.goto('/einstellungen?bereich=hardware')                                       // Seite verlassen …
    await page.goto('/einstellungen?bereich=kassen')                                         // … und zurück
    await expect(zeile(g.pfade.atr)).toBeVisible({ timeout: 15_000 })
    await expect(status).toHaveText(STATUS_ALLE)
    await nichtsGeschrieben(0)

    // ---- (4) erste Gruppe nach „Alle ausblenden": genau diese wird gespeichert — ohne Untergruppen ----
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    await haken(g.pfade.alko).click()
    await expect.poll(async () => nurUnsere(await liste())).toEqual([g.alko.id])
    expect(await liste()).toEqual([g.alko.id])                                              // wirklich NUR diese Gruppe
    await expect(status).toHaveText(/^1 von \d+ sichtbar$/)
    await expect(neustartHinweis).toHaveCount(0)
    await expect(haken(g.pfade.alko)).toBeChecked()
    await expect(haken(g.pfade.limo)).not.toBeChecked()                                     // Untergruppen nicht automatisch dabei
    await expect(haken(g.pfade.saft)).not.toBeChecked()
    await expect(haken(g.pfade.atr)).toHaveAttribute('data-zustand', 'zugang')             // Obergruppe nur als Zugang
    await expect(haken(g.pfade.atr)).toBeChecked({ indeterminate: true })
    await expect(haken(g.pfade.kel)).not.toBeChecked()
    expect(schreib.anzahl).toBe(1)

    // ---- (5) „Alle ausblenden" aus „N von M": Neustart, Serverstand bleibt, nach Neuladen wieder N von M ----
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    for (const pfad of unsere) await expect(haken(pfad)).not.toBeChecked()
    expect(await liste()).toEqual([g.alko.id])
    await nichtsGeschrieben(1)
    await page.reload()
    await expect(zeile(g.pfade.atr)).toBeVisible({ timeout: 15_000 })
    await expect(status).toHaveText(/^1 von \d+ sichtbar$/)
    await expect(haken(g.pfade.alko)).toBeChecked()

    // ---- (6) „Alle sichtbar" aus „N von M": stellt [] wieder her ----
    await sichtbarKnopf.click()
    await expect(status).toHaveText(STATUS_ALLE, { timeout: 10_000 })
    await expect.poll(liste).toEqual([])
    for (const pfad of unsere) await expect(haken(pfad)).toBeChecked()
    await expect(sichtbarKnopf).toHaveAttribute('aria-pressed', 'true')

    // Neustart, dann „Alle sichtbar": zurück auf alle sichtbar
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    await sichtbarKnopf.click()
    await expect(status).toHaveText(STATUS_ALLE)
    expect(await liste()).toEqual([])

    // Neustart aus „N von M", dann „Alle sichtbar": speichert []
    await setzeListe([g.kel.id])
    await page.reload()
    await expect(status).toHaveText(/^1 von \d+ sichtbar$/, { timeout: 15_000 })
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    await sichtbarKnopf.click()
    await expect(status).toHaveText(STATUS_ALLE, { timeout: 10_000 })
    await expect.poll(liste).toEqual([])

    // ---- (7) Teilbaum-Komfort: „samt Untergruppen" schaltet Gruppe + alle Nachkommen auf einmal ----
    await expect(zeile(g.pfade.gril).getByTestId('teilbaum-knopf')).toHaveCount(0)          // Blätter haben den Knopf nicht
    await teilbaum(g.pfade.atr).click()                                                      // alle gewählt → alle fünf ab
    await expect(status).toHaveText(/^\d+ von \d+ sichtbar$/, { timeout: 10_000 })
    for (const pfad of [g.pfade.atr, g.pfade.alko, g.pfade.limo, g.pfade.saft, g.pfade.bier]) await expect(haken(pfad)).not.toBeChecked()
    await expect(haken(g.pfade.kel)).toBeChecked()
    const ohneAtriumbar = await liste()
    for (const x of [g.atr, g.alko, g.limo, g.saft, g.bier]) expect(ohneAtriumbar).not.toContain(x.id)
    for (const x of [g.kel, g.gril]) expect(ohneAtriumbar).toContain(x.id)
    await teilbaum(g.pfade.atr).click()                                                      // keine gewählt → alle fünf wieder an → alle → []
    await expect(status).toHaveText(STATUS_ALLE, { timeout: 10_000 })
    await expect.poll(liste).toEqual([])
    // im Neustart: genau dieser Teilbaum wird die neue Auswahl
    await ausblendenKnopf.click()
    await expect(status).toHaveText(STATUS_KEINE)
    await teilbaum(g.pfade.alko).click()
    await expect.poll(async () => nurUnsere(await liste()).sort()).toEqual(sortiert([g.alko.id, g.limo.id, g.saft.id]))
    expect(sortiert(await liste())).toEqual(sortiert([g.alko.id, g.limo.id, g.saft.id]))
    await expect(haken(g.pfade.bier)).not.toBeChecked()
    await expect(haken(g.pfade.atr)).toHaveAttribute('data-zustand', 'zugang')

    // ---- (8) die letzte gewählte Gruppe bleibt nicht abwählbar ----
    await setzeListe([g.gril.id])
    await page.reload()
    await expect(haken(g.pfade.gril)).toBeChecked({ timeout: 15_000 })
    await haken(g.pfade.gril).click()
    await expect(matrix.getByTestId('verteilung-hinweis')).toContainText(LETZTE_HINWEIS_TEIL)
    await expect(haken(g.pfade.gril)).toBeChecked()
    expect(await liste()).toEqual([g.gril.id])
    await setzeListe([])

    // ---- (9) mehrere Kassen: der Neustart einer Spalte lässt die anderen unberührt ----
    if (kassenListe.length > 1) {
      await page.reload()
      await expect(zeile(g.pfade.atr)).toBeVisible({ timeout: 15_000 })
      const alleStatus = matrix.getByTestId('verteilung-status')
      const vorher = await alleStatus.allTextContents()
      await ausblendenKnopf.click()
      await expect(status).toHaveText(STATUS_KEINE)
      const nachher = await alleStatus.allTextContents()
      expect(nachher.filter((_, i) => i !== spalte)).toEqual(vorher.filter((_, i) => i !== spalte))
      await sichtbarKnopf.click()
      await expect(status).toHaveText(STATUS_ALLE)
    }

    // =================================================================================
    // 2. POS-Konfiguration → Warengruppen: dieselben Knöpfe, dasselbe Verhalten
    // =================================================================================
    await setzeListe([])
    const vorPos = schreib.anzahl
    await page.goto('/pos-konfiguration')
    const pzeile = (pfad: string) => page.locator(`[data-testid="wg-zeile"][data-pfad="${pfad}"]`)
    const schalter = (pfad: string) => pzeile(pfad).getByRole('switch')
    const pTeilbaum = (pfad: string) => pzeile(pfad).getByTestId('teilbaum-knopf')
    const pStatus = page.getByTestId('wg-status')
    const pSichtbar = page.getByTestId('wg-alle-sichtbar')
    const pAusblenden = page.getByTestId('wg-alle-ausblenden')
    const pHinweis = page.getByTestId('wg-neustart-hinweis')
    await expect(pzeile(g.pfade.atr)).toBeVisible({ timeout: 15_000 })

    await expect(pSichtbar).toHaveText('Alle sichtbar')
    await expect(pAusblenden).toHaveText('Alle ausblenden')
    await expect(pSichtbar).toHaveAttribute('title', /blendet alle aus/)
    await expect(pAusblenden).toHaveAttribute('title', /Bis dahin wird nichts gespeichert/)
    await expect(pStatus).toHaveText(STATUS_ALLE)
    await expect(pSichtbar).toHaveAttribute('aria-pressed', 'true')
    for (const pfad of unsere) await expect(schalter(pfad)).toHaveAttribute('data-zustand', 'an')

    // Toggle: „Alle sichtbar" bei „alle sichtbar" → alle ausgeblendet, nichts gespeichert
    await pSichtbar.click()
    await expect(pStatus).toHaveText(STATUS_KEINE)
    for (const pfad of unsere) await expect(schalter(pfad)).toHaveAttribute('data-zustand', 'aus')
    await expect(pHinweis).toHaveText(NEUSTART_HINWEIS)
    await expect(pAusblenden).toHaveAttribute('aria-pressed', 'true')
    expect(await liste()).toEqual([])
    await nichtsGeschrieben(vorPos)
    // zurück
    await pAusblenden.click()
    await expect(pStatus).toHaveText(STATUS_ALLE)
    await expect(pHinweis).toHaveCount(0)
    for (const pfad of unsere) await expect(schalter(pfad)).toHaveAttribute('data-zustand', 'an')
    await nichtsGeschrieben(vorPos)

    // Neustart, Neuladen → Serverstand
    await pAusblenden.click()
    await expect(pStatus).toHaveText(STATUS_KEINE)
    await page.reload()
    await expect(pzeile(g.pfade.atr)).toBeVisible({ timeout: 15_000 })
    await expect(pStatus).toHaveText(STATUS_ALLE)
    await expect(pHinweis).toHaveCount(0)

    // erste Gruppe nach „Alle ausblenden": nur diese, ohne Untergruppen
    await pAusblenden.click()
    await expect(pStatus).toHaveText(STATUS_KEINE)
    await schalter(g.pfade.alko).click()
    await expect.poll(async () => nurUnsere(await liste())).toEqual([g.alko.id])
    expect(await liste()).toEqual([g.alko.id])
    await expect(pStatus).toHaveText(/^1 von \d+ sichtbar$/)
    await expect(pHinweis).toHaveCount(0)
    await expect(schalter(g.pfade.alko)).toHaveAttribute('data-zustand', 'an')
    await expect(schalter(g.pfade.limo)).toHaveAttribute('data-zustand', 'aus')
    await expect(schalter(g.pfade.saft)).toHaveAttribute('data-zustand', 'aus')
    await expect(schalter(g.pfade.atr)).toHaveAttribute('data-zustand', 'zugang')

    // Neustart aus „N von M": gespeichert bleibt die Auswahl; „Alle sichtbar" stellt []
    await pAusblenden.click()
    await expect(pStatus).toHaveText(STATUS_KEINE)
    expect(await liste()).toEqual([g.alko.id])
    await pSichtbar.click()
    await expect(pStatus).toHaveText(STATUS_ALLE, { timeout: 10_000 })
    await expect.poll(liste).toEqual([])

    // Teilbaum-Komfort und letzte Gruppe
    await expect(pTeilbaum(g.pfade.gril)).toHaveCount(0)
    await pAusblenden.click()
    await expect(pStatus).toHaveText(STATUS_KEINE)
    await pTeilbaum(g.pfade.atr).click()
    await expect.poll(async () => nurUnsere(await liste()).sort()).toEqual(sortiert([g.atr.id, g.alko.id, g.limo.id, g.saft.id, g.bier.id]))
    await expect(schalter(g.pfade.kel)).toHaveAttribute('data-zustand', 'aus')
    await setzeListe([g.gril.id])
    await page.reload()
    await expect(schalter(g.pfade.gril)).toHaveAttribute('data-zustand', 'an', { timeout: 15_000 })
    await schalter(g.pfade.gril).click()
    await expect(page.getByTestId('wg-hinweis')).toContainText(LETZTE_HINWEIS_TEIL)
    expect(await liste()).toEqual([g.gril.id])
  } finally {
    await setzeListe([])
  }
})

test('Kasse: nur „Alkoholfrei" gewählt zeigt dessen Artikel ohne Limonaden/Säfte — die Obergruppe ist nur Zugang', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const p = `Sk${Date.now() % 1_000_000}`
  const g = await legeBaumAn(request, auth, p)
  for (const [bez, gruppe] of [
    [`${p} Atrium-Spezial`, g.atr], [`${p} Mineral`, g.alko], [`${p} Cola`, g.limo], [`${p} Apfelsaft`, g.saft], [`${p} Pils`, g.bier], [`${p} Schnitzel`, g.kel],
  ] as const) await legeArtikelAn(request, auth, bez, gruppe.id)
  const setzeListe = async (ids: string[]) =>
    expect((await request.put(`/api/kassen/${kasseId}/pos-config`, { headers: auth, data: { sichtbareKategorieIds: ids } })).status()).toBe(204)

  // Texte der Kacheln im Raster: Untergruppen-Kacheln und Artikel-Kacheln getrennt
  const kacheln = (page: Page) => page.locator('[data-testid="untergruppe-kachel"]')
  const artikel = (page: Page) => page.locator('[data-testid="artikel-kachel"]')
  const texte = async (l: Locator) => (await l.allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
  const enthaelt = (liste: string[], ...teile: string[]) => teile.every(t => liste.some(x => x.includes(t)))

  await anmelden(page, login)
  try {
    // ---- nur „Alkoholfrei" gewählt ----
    await setzeListe([g.alko.id])
    await page.goto('/kasse')
    // Reiter: nur die Atriumbar (Zugang) — Ebene der Atriumbar: eine Kachel „Alkoholfrei", keine eigenen Artikel, kein Bier
    await expect.poll(async () => (await texte(kacheln(page))).length, { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(async () => texte(kacheln(page))).toEqual([`${p} Alkoholfrei`])
    await expect.poll(async () => texte(artikel(page))).toEqual([])
    await expect(page.getByRole('button', { name: new RegExp(`^${p} Atriumbar`) })).toBeVisible()
    await expect(page.getByRole('button', { name: new RegExp(`^${p} Kellner`) })).toHaveCount(0)

    // in „Alkoholfrei": dessen Artikel, aber KEINE Kacheln für Limonaden und Säfte
    await kacheln(page).filter({ hasText: `${p} Alkoholfrei` }).click()
    await expect.poll(async () => enthaelt(await texte(artikel(page)), `${p} Mineral`)).toBe(true)
    expect((await texte(artikel(page))).length).toBe(1)
    await expect(kacheln(page)).toHaveCount(0)
    await expect(page.getByText(`${p} Limonaden`)).toHaveCount(0)
    await expect(page.getByText(`${p} Säfte`)).toHaveCount(0)
    await expect(page.getByText(`${p} Cola`)).toHaveCount(0)

    // ---- danach „Limonaden" zusätzlich gewählt → die Kachel erscheint (Säfte bleibt weg) ----
    await setzeListe([g.alko.id, g.limo.id])
    await page.goto('/kasse')
    await expect.poll(async () => texte(kacheln(page)), { timeout: 20_000 }).toEqual([`${p} Alkoholfrei`])
    await kacheln(page).filter({ hasText: `${p} Alkoholfrei` }).click()
    await expect.poll(async () => texte(kacheln(page))).toEqual([`${p} Limonaden`])
    await expect.poll(async () => enthaelt(await texte(artikel(page)), `${p} Mineral`)).toBe(true)
    await kacheln(page).filter({ hasText: `${p} Limonaden` }).click()
    await expect.poll(async () => enthaelt(await texte(artikel(page)), `${p} Cola`)).toBe(true)
    await expect(page.getByText(`${p} Apfelsaft`)).toHaveCount(0)

    // ---- nur die Obergruppe gewählt: ihre eigenen Artikel, aber keine Untergruppen-Kacheln ----
    await setzeListe([g.atr.id])
    await page.goto('/kasse')
    await expect.poll(async () => enthaelt(await texte(artikel(page)), `${p} Atrium-Spezial`), { timeout: 20_000 }).toBe(true)
    await expect(kacheln(page)).toHaveCount(0)
    await expect(page.getByText(`${p} Mineral`)).toHaveCount(0)

    // ---- ältere Liste mit vollem Teilbaum: wie bisher der ganze Teilbaum ----
    await setzeListe([g.atr.id, g.alko.id, g.limo.id, g.saft.id, g.bier.id])
    await page.goto('/kasse')
    await expect.poll(async () => texte(kacheln(page)), { timeout: 20_000 }).toEqual([`${p} Alkoholfrei`, `${p} Bier`])
    await kacheln(page).filter({ hasText: `${p} Alkoholfrei` }).click()
    await expect.poll(async () => texte(kacheln(page))).toEqual([`${p} Limonaden`, `${p} Säfte`])
  } finally {
    await setzeListe([])
  }
})

test('Kassen-Anordnung und Reiter-Zähler passen zur Auswahl: Editor nur für Gruppen mit eigenen Artikeln, Ausgeblendetes zählt nicht', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const p = `Sk${Date.now() % 1_000_000}`
  const g = await legeBaumAn(request, auth, p)
  const mineral = await legeArtikelAn(request, auth, `${p} Mineral`, g.alko.id)
  const tonic   = await legeArtikelAn(request, auth, `${p} Tonic`, g.alko.id)
  await legeArtikelAn(request, auth, `${p} Cola`, g.limo.id)
  await legeArtikelAn(request, auth, `${p} Atrium-Spezial`, g.atr.id)
  const setzeListe = async (ids: string[]) =>
    expect((await request.put(`/api/kassen/${kasseId}/pos-config`, { headers: auth, data: { sichtbareKategorieIds: ids } })).status()).toBe(204)

  await anmelden(page, login)
  try {
    // Auswahl: „Alkoholfrei" und „Limonaden" — die Atriumbar ist nur Zugang; „Tonic" ist an dieser Kasse in „Alkoholfrei" ausgeblendet
    await setzeListe([g.alko.id, g.limo.id])
    expect((await request.put(`/api/kassen/${kasseId}/artikel-layouts/${g.alko.id}`, {
      headers: auth,
      data: { eintraege: [
        { artikelId: mineral, position: 1,    ausgeblendet: false },
        { artikelId: tonic,   position: null, ausgeblendet: true },
      ] },
    })).status()).toBe(204)

    // ---- Kasse: Reiter-Zähler der Atriumbar (Zugang) = Mineral + Cola; weder „Tonic" (ausgeblendet) noch „Atrium-Spezial" (Gruppe nicht gewählt) ----
    await page.goto('/kasse')
    const reiter = page.locator('button[aria-pressed]', { hasText: `${p} Atriumbar` })
    await expect(reiter).toHaveText(new RegExp(`^${p} Atriumbar\\s*2$`), { timeout: 20_000 })
    const kacheln = page.locator('[data-testid="untergruppe-kachel"]')
    const artikel = page.locator('[data-testid="artikel-kachel"]')
    const texte = async (l: Locator) => (await l.allTextContents()).map(t => t.replace(/\s+/g, ' ').trim())
    await expect.poll(async () => texte(kacheln)).toEqual([`${p} Alkoholfrei`])
    await expect.poll(async () => texte(artikel)).toEqual([])                                 // der Zugang hat keine eigenen Artikel
    await kacheln.filter({ hasText: `${p} Alkoholfrei` }).click()
    await expect.poll(async () => texte(kacheln)).toEqual([`${p} Limonaden`])
    await expect.poll(async () => (await texte(artikel)).length).toBe(1)                      // Mineral; Tonic ist ausgeblendet
    expect((await texte(artikel))[0]).toContain(`${p} Mineral`)

    // ---- POS-Konfiguration → Artikel: nur Gruppen, die die Kasse mit eigenen Artikeln zeigt ----
    await page.goto('/pos-konfiguration')
    await page.getByRole('button', { name: 'Artikel', exact: true }).click()
    await expect(page.getByTestId('anordnung-tab')).toBeVisible({ timeout: 20_000 })
    const chips = page.locator('[data-testid="wg-chip"]')
    const chip = (id: string) => page.locator(`[data-testid="wg-chip"][data-kategorie-id="${id}"]`)
    // „●" kennzeichnet eine Gruppe mit eigener Anordnung an dieser Kasse (hier: „Alkoholfrei") — der Name steht davor
    await expect.poll(async () => (await texte(chips)).map(t => t.replace('●', '').trim())).toEqual([`${p} Alkoholfrei`, `${p} Limonaden`])
    await expect(chip(g.alko.id)).toHaveAttribute('data-eigene', 'true')
    await expect(chip(g.limo.id)).toHaveAttribute('data-eigene', 'false')
    await expect(chip(g.atr.id)).toHaveCount(0)                                               // der reine Zugang wird nicht angeboten
    // kurzer Hinweis statt eines leeren Editors für den reinen Zugang
    const hinweis = page.getByTestId('anordnung-zugang-hinweis')
    await expect(hinweis).toContainText(`${p} Atriumbar`)
    await expect(hinweis).toContainText('nur als Zugang')
    // „Alkoholfrei" ist vorgewählt: eigene Anordnung (Tonic ausgeblendet), davor die Kachel der gewählten Untergruppe „Limonaden"
    await expect(page.getByTestId('anordnung-status')).toHaveAttribute('data-eigene', 'true')
    await expect(page.getByTestId('anordnung-tab')).toContainText('davor 1 Untergruppe als feste Kachel')
    // Standard-Ebene: alle aktiven Gruppen (auch die Atriumbar), der Hinweis entfällt
    await page.getByTestId('anordnung-modus-standard').click()
    await expect(chip(g.atr.id)).toHaveCount(1)
    await expect(hinweis).toHaveCount(0)
  } finally {
    await request.delete(`/api/kassen/${kasseId}/artikel-layouts/${g.alko.id}`, { headers: auth }).catch(() => undefined)
    await setzeListe([])
  }
})
