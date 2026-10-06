import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Warengruppen als BAUM mit Pfad-Anzeige und EINER Sichtbarkeitslogik (Matrix „Warengruppen-Verteilung"
 * in den Einstellungen UND POS-Konfiguration):
 *
 *  - drei gleichnamige „Alkoholfrei" unter verschiedenen Elterngruppen sind per Elternzeile / Pfad unterscheidbar
 *  - Matrix: leere Liste = alle Haken gesetzt, Abhaken → alle außer dieser, „Alle sichtbar" stellt alles her
 *    und speichert [], ein Haken gilt NUR für seine Gruppe (die Untergruppen bleiben, wie sie sind; eine Gruppe
 *    ohne eigenen Haken, aber mit gewählter Untergruppe zeigt den Halbhaken = Zugang), der kleine Knopf
 *    „samt Untergruppen" schaltet Gruppe + alle Nachkommen auf einmal, letzte Gruppe nicht abhakbar
 *  - POS-Konfig: Reihenfolge ↑/↓ nur unter Geschwistern, „Reihenfolge speichern" schreibt Positionen
 *    UNTER GESCHWISTERN (keine globalen Indizes), „Artikelwahl öffnet mit" und Artikelformular zeigen Pfadlabel
 *
 * Liegt am Ende der Suite (zzz-): ändert die Sichtbarkeitsliste der Kasse (am Schluss wieder []).
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ serviceWorkers: 'block' })

type Login = { token: string; user: { id: string }; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }

/**
 * /api/auth/login ist auf 10 Anmeldungen je Minute und IP begrenzt (429). Die Suite meldet sich
 * gerade am Ende oft an — bei 429 daher abwarten und erneut versuchen, statt fälschlich in
 * /api/setup zu fallen („E-Mail bereits vergeben").
 */
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
test.setTimeout(150_000)

let gemerkterLogin: Login | null = null
async function adminLogin(request: APIRequestContext): Promise<Login> {
  if (gemerkterLogin) return gemerkterLogin
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-BAUM-001',
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

interface Gruppe { id: string; name: string; parentId: string | null; reihenfolge: number }

/** Genauer Textvergleich für Optionen/Zellen (hasText wäre ein Teilstring-Treffer: „A › B" träfe auch „A › B › C"). */
const genau = (text: string) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)

test('Warengruppen-Baum: Pfadlabel, Matrix „Warengruppen-Verteilung" und POS-Konfiguration mit gemeinsamer Sichtbarkeitslogik', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const kasseId = login.kassen[0]!.id
  const p = `Bm${Date.now() % 1_000_000}`

  const gruppe = async (name: string, parentId: string | null, reihenfolge: number): Promise<Gruppe> => {
    const res = await request.post('/api/kategorien', { headers: auth, data: { name, farbe: 'grau', reihenfolge, parentId } })
    expect(res.ok(), await res.text()).toBe(true)
    return (await res.json()) as Gruppe
  }
  // AKTIVE Gruppen — genau die Menge, die Kasse und Konfiguration sehen (die Betriebsseiten fragen ausdrücklich
  // nurAktive=true ab; ohne den Parameter lieferte die Route alle Gruppen, auch deaktivierte anderer Specs)
  const alleGruppen = async () => (await (await request.get('/api/kategorien?nurAktive=true', { headers: auth })).json()) as Gruppe[]
  const liste = async () =>
    ((await (await request.get(`/api/kassen/${kasseId}/pos-config`, { headers: auth })).json()) as { sichtbareKategorieIds: string[] }).sichtbareKategorieIds
  const setzeListe = async (ids: string[]) =>
    expect((await request.put(`/api/kassen/${kasseId}/pos-config`, { headers: auth, data: { sichtbareKategorieIds: ids } })).status()).toBe(204)

  // Baum wie nach dem Asello-Import: DREI gleichnamige „Alkoholfrei" (+ zwei „Bier") unter verschiedenen Eltern.
  // Hauptgruppen mit hohen Reihenfolgen, damit sie in dieser Reihenfolge NACH allen anderen stehen.
  const alko = `${p} Alkoholfrei`
  const bar    = await gruppe(`${p} Atriumbar`, null, 5001)
  const barAlk = await gruppe(alko,            bar.id, 0)
  const barLim = await gruppe(`${p} Limonaden`, barAlk.id, 0)
  const barBier = await gruppe(`${p} Bier`,    bar.id, 1)
  const kel    = await gruppe(`${p} Kellner`,  null, 5002)
  const kelAlk = await gruppe(alko,            kel.id, 0)
  const kelBier = await gruppe(`${p} Bier`,    kel.id, 1)
  const evt    = await gruppe(`${p} Event`,    null, 5003)
  const evtPak = await gruppe(`${p} Pakete`,   evt.id, 0)
  const evtAlk = await gruppe(alko,            evtPak.id, 0)

  const pfade = {
    bar: `${p} Atriumbar`, barAlk: `${p} Atriumbar › ${alko}`, barLim: `${p} Atriumbar › ${alko} › ${p} Limonaden`,
    barBier: `${p} Atriumbar › ${p} Bier`, kel: `${p} Kellner`, kelAlk: `${p} Kellner › ${alko}`, kelBier: `${p} Kellner › ${p} Bier`,
    evt: `${p} Event`, evtPak: `${p} Event › ${p} Pakete`, evtAlk: `${p} Event › ${p} Pakete › ${alko}`,
  }
  const erwarteteBaumreihenfolge = Object.values(pfade)

  await setzeListe([])
  await anmelden(page, login)

  try {
    // =================================================================================
    // 1. Matrix „Warengruppen-Verteilung" (Einstellungen → Kassen)
    // =================================================================================
    await page.goto('/einstellungen?bereich=kassen')
    const matrix = page.locator('section', { has: page.getByRole('heading', { name: 'Warengruppen-Verteilung' }) })
    // Die Matrix hat je Kasse eine Spalte (gleiche Reihenfolge wie GET /api/kassen) — wir prüfen die Spalte unserer Kasse
    const kassenListe = (await (await request.get('/api/kassen', { headers: auth })).json()) as { id: string }[]
    const spalte = Math.max(0, kassenListe.findIndex(k => k.id === kasseId))
    const zeile = (pfad: string) => matrix.locator(`[data-testid="verteilung-zeile"][data-pfad="${pfad}"]`)
    const haken = (pfad: string) => zeile(pfad).locator('input[type="checkbox"]').nth(spalte)
    await expect(zeile(pfade.bar)).toBeVisible({ timeout: 15_000 })

    // Zeilen im BAUM: Baumreihenfolge, Einrückung nach Tiefe, Pfad als Tooltip
    const gesehen = await matrix.locator('[data-testid="verteilung-zeile"]').evaluateAll(
      (els, praefix) => els.map(el => el.getAttribute('data-pfad')!).filter(pf => pf.includes(praefix as string)), p)
    expect(gesehen).toEqual(erwarteteBaumreihenfolge)
    // drei „Alkoholfrei", jede unter ihrer Elternzeile (Tiefe 1, 1, 2)
    await expect(zeile(pfade.barAlk)).toHaveAttribute('data-tiefe', '1')
    await expect(zeile(pfade.kelAlk)).toHaveAttribute('data-tiefe', '1')
    await expect(zeile(pfade.evtAlk)).toHaveAttribute('data-tiefe', '2')
    await expect(zeile(pfade.evtAlk).locator('td').first()).toHaveAttribute('title', pfade.evtAlk)
    const einrueckung = (pfad: string) => zeile(pfad).locator('td').first().locator('div').first().evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))
    expect(await einrueckung(pfade.bar)).toBe(0)
    expect(await einrueckung(pfade.barAlk)).toBeGreaterThan(await einrueckung(pfade.bar))
    expect(await einrueckung(pfade.barLim)).toBeGreaterThan(await einrueckung(pfade.barAlk))

    // Leere Liste = „alle sichtbar" — und ALLE Haken sind gesetzt (nicht leer)
    const status = matrix.getByTestId('verteilung-status').nth(spalte)
    const alleKnopf = matrix.getByTestId('verteilung-alle-sichtbar').nth(spalte)
    await expect(status).toHaveText('alle sichtbar')
    for (const pfad of erwarteteBaumreihenfolge) await expect(haken(pfad)).toBeChecked()
    await expect(alleKnopf).toHaveAttribute('aria-pressed', 'true')
    await expect(matrix.getByTestId('verteilung-alle-ausblenden').nth(spalte)).toHaveAttribute('aria-pressed', 'false')

    // Eine Gruppe abhaken (nur EINE der drei „Alkoholfrei") → gespeichert: alle außer dieser
    await haken(pfade.kelAlk).click()
    await expect(status).toContainText(/\d+ von \d+ sichtbar/, { timeout: 10_000 })
    await expect(haken(pfade.kelAlk)).not.toBeChecked()
    await expect(haken(pfade.barAlk)).toBeChecked()
    await expect(haken(pfade.evtAlk)).toBeChecked()
    // Jede Gruppe wird einzeln gewählt: die Elterngruppe bleibt, was sie war — angehakt
    await expect(haken(pfade.kel)).toHaveAttribute('data-zustand', 'an')
    await expect(haken(pfade.kel)).toBeChecked()
    await expect(haken(pfade.kelBier)).toBeChecked()
    const nachAbhaken = await liste()
    expect(nachAbhaken).not.toContain(kelAlk.id)
    for (const g of [bar, barAlk, barLim, barBier, kel, kelBier, evt, evtPak, evtAlk]) expect(nachAbhaken).toContain(g.id)
    expect(nachAbhaken).toHaveLength((await alleGruppen()).length - 1)

    // „Alle sichtbar" tut etwas Sichtbares: alles angehakt, Liste leer
    await expect(alleKnopf).toBeEnabled()
    await expect(alleKnopf).toHaveText('Alle sichtbar')
    await expect(alleKnopf).toHaveAttribute('aria-pressed', 'false')
    await alleKnopf.click()
    await expect(status).toHaveText('alle sichtbar', { timeout: 10_000 })
    for (const pfad of erwarteteBaumreihenfolge) await expect(haken(pfad)).toBeChecked()
    await expect(alleKnopf).toHaveAttribute('aria-pressed', 'true')
    expect(await liste()).toEqual([])

    // Ein Eltern-Haken gilt NUR für diese Gruppe: Atriumbar ab → Alkoholfrei, Limonaden und Bier darunter bleiben
    // angehakt; die Atriumbar selbst zeigt den Halbhaken (nicht gewählt, aber Zugang zu den gewählten Untergruppen)
    await haken(pfade.bar).click()
    await expect(status).toContainText(/\d+ von \d+ sichtbar/, { timeout: 10_000 })
    await expect(haken(pfade.bar)).toHaveAttribute('data-zustand', 'zugang')
    await expect(haken(pfade.bar)).toBeChecked({ indeterminate: true })
    for (const pfad of [pfade.barAlk, pfade.barLim, pfade.barBier]) await expect(haken(pfad)).toBeChecked()
    await expect(haken(pfade.kelAlk)).toBeChecked()
    const ohneBar = await liste()
    expect(ohneBar).not.toContain(bar.id)
    for (const g of [barAlk, barLim, barBier, kel, kelAlk, kelBier, evt, evtPak, evtAlk]) expect(ohneBar).toContain(g.id)
    // …wieder angehakt: alle Gruppen gewählt → [] gespeichert
    await haken(pfade.bar).click()
    await expect(status).toHaveText('alle sichtbar', { timeout: 10_000 })
    expect(await liste()).toEqual([])

    // Komfort „samt Untergruppen": der kleine Knopf neben der Atriumbar schaltet Gruppe + alle Nachkommen auf einmal
    const teilbaum = (pfad: string) => zeile(pfad).getByTestId('teilbaum-knopf').nth(spalte)
    await expect(zeile(pfade.kelAlk).getByTestId('teilbaum-knopf')).toHaveCount(0)       // Gruppen ohne Untergruppen haben ihn nicht
    await teilbaum(pfade.bar).click()                                                      // alle angehakt → alle vier ab
    await expect(status).toContainText(/\d+ von \d+ sichtbar/, { timeout: 10_000 })
    for (const pfad of [pfade.bar, pfade.barAlk, pfade.barLim, pfade.barBier]) await expect(haken(pfad)).not.toBeChecked()
    await expect(haken(pfade.kelAlk)).toBeChecked()
    await expect(haken(pfade.evtAlk)).toBeChecked()
    const ohneTeilbaum = await liste()
    for (const g of [bar, barAlk, barLim, barBier]) expect(ohneTeilbaum).not.toContain(g.id)
    for (const g of [kel, kelAlk, kelBier, evt, evtPak, evtAlk]) expect(ohneTeilbaum).toContain(g.id)
    await teilbaum(pfade.bar).click()                                                      // keine gewählt → alle vier wieder an
    await expect(status).toHaveText('alle sichtbar', { timeout: 10_000 })
    expect(await liste()).toEqual([])

    // Mindestens eine Gruppe bleibt sichtbar: ist nur noch EINE sichtbar, lässt sie sich nicht abhaken
    await setzeListe([kelBier.id])
    await page.reload()
    await expect(zeile(pfade.kelBier)).toBeVisible({ timeout: 15_000 })
    await expect(haken(pfade.kelBier)).toBeChecked()
    await expect(haken(pfade.kel)).toBeChecked({ indeterminate: true })   // Zugang zu Kellner Bier
    await haken(pfade.kelBier).click()
    await expect(matrix.getByTestId('verteilung-hinweis')).toContainText('Mindestens eine Warengruppe')
    await expect(haken(pfade.kelBier)).toBeChecked()
    expect(await liste()).toEqual([kelBier.id])
    await setzeListe([])

    // =================================================================================
    // 2. POS-Konfiguration → Warengruppen: Baum, Reihenfolge unter Geschwistern, Sichtbarkeit
    // =================================================================================
    await page.goto('/pos-konfiguration')
    const pzeile = (pfad: string) => page.locator(`[data-testid="wg-zeile"][data-pfad="${pfad}"]`)
    await expect(pzeile(pfade.bar)).toBeVisible({ timeout: 15_000 })
    const pGesehen = await page.locator('[data-testid="wg-zeile"]').evaluateAll(
      (els, praefix) => els.map(el => el.getAttribute('data-pfad')!).filter(pf => pf.includes(praefix as string)), p)
    expect(pGesehen).toEqual(erwarteteBaumreihenfolge)
    for (const [pfad, tiefe] of [[pfade.bar, 0], [pfade.barAlk, 1], [pfade.barLim, 2], [pfade.kelAlk, 1], [pfade.evtAlk, 2]] as const) {
      await expect(pzeile(pfad)).toHaveAttribute('data-tiefe', String(tiefe))
    }
    // Pfad als Tooltip; die drei „Alkoholfrei" sind unterscheidbar
    await expect(pzeile(pfade.evtAlk)).toHaveAttribute('title', pfade.evtAlk)

    // „Artikelwahl öffnet mit": Pfadlabel in Baumreihenfolge
    const start = page.getByLabel('Artikelwahl öffnet mit')
    for (const pfad of [pfade.barAlk, pfade.kelAlk, pfade.evtAlk]) {
      await expect(start.locator('option', { hasText: genau(pfad) })).toHaveCount(1)
    }

    // Reihenfolge ↑: „Bier" (Position 1 unter Atriumbar) vor „Alkoholfrei" — nur unter Geschwistern;
    // die erste Gruppe unter Atriumbar kann nicht weiter nach oben
    await expect(pzeile(pfade.barAlk).getByRole('button', { name: 'Nach oben' })).toBeDisabled()
    await pzeile(pfade.barBier).getByRole('button', { name: 'Nach oben' }).click()
    const speichern = page.getByRole('button', { name: 'Reihenfolge speichern' })
    await expect(speichern).toBeVisible()
    // vor dem Speichern ist nichts geschrieben
    expect((await alleGruppen()).find(g => g.id === barBier.id)!.reihenfolge).toBe(1)
    await speichern.click()
    await expect(speichern).toHaveCount(0)

    // Gespeichert wurden die Positionen UNTER GESCHWISTERN (0..n-1) — nur für Atriumbar-Kinder,
    // keine globalen Indizes; alle anderen Mengen unverändert
    await expect.poll(async () => (await alleGruppen()).find(g => g.id === barBier.id)!.reihenfolge).toBe(0)
    const nach = new Map((await alleGruppen()).map(g => [g.id, g.reihenfolge] as const))
    expect(nach.get(barBier.id)).toBe(0)
    expect(nach.get(barAlk.id)).toBe(1)
    expect(nach.get(barLim.id)).toBe(0)                         // Enkel unverändert
    expect([nach.get(kelAlk.id), nach.get(kelBier.id)]).toEqual([0, 1])
    expect(nach.get(evtAlk.id)).toBe(0)
    expect([nach.get(bar.id), nach.get(kel.id), nach.get(evt.id)]).toEqual([5001, 5002, 5003])   // Hauptgruppen unangetastet
    // Anzeige folgt: Bier steht jetzt vor Alkoholfrei, die drei „Alkoholfrei" bleiben unter ihren Eltern
    await expect.poll(async () => (await page.locator('[data-testid="wg-zeile"]').evaluateAll(
      (els, praefix) => els.map(el => el.getAttribute('data-pfad')!).filter(pf => pf.includes(praefix as string)), p)))
      .toEqual([pfade.bar, pfade.barBier, pfade.barAlk, pfade.barLim, pfade.kel, pfade.kelAlk, pfade.kelBier, pfade.evt, pfade.evtPak, pfade.evtAlk])
    // Verschieben unter den HAUPTGRUPPEN: Event nach oben → nur die drei Hauptgruppen-Positionen werden geschrieben
    await pzeile(pfade.evt).getByRole('button', { name: 'Nach oben' }).click()
    await speichern.click()
    await expect(speichern).toHaveCount(0)
    await expect.poll(async () => {
      const m = new Map((await alleGruppen()).map(g => [g.id, g.reihenfolge] as const))
      return m.get(evt.id)! < m.get(kel.id)!
    }).toBe(true)
    const hauptgruppen = (await alleGruppen()).filter(g => g.parentId === null)
    // Hauptgruppen tragen Positionen 0..n-1 unter sich — nie einen Index aus der Gesamtliste
    expect(Math.max(...hauptgruppen.map(g => g.reihenfolge))).toBeLessThan(hauptgruppen.length)
    const nach2 = new Map((await alleGruppen()).map(g => [g.id, g.reihenfolge] as const))
    expect([nach2.get(barAlk.id), nach2.get(barBier.id), nach2.get(barLim.id), nach2.get(kelAlk.id), nach2.get(kelBier.id), nach2.get(evtAlk.id)]).toEqual([1, 0, 0, 0, 1, 0])

    // Sichtbarkeit: derselbe Einzel-Schalter wie in der Matrix — jede Gruppe für sich, die Elterngruppe bleibt angehakt
    const schalter = (pfad: string) => pzeile(pfad).getByRole('switch')
    await expect(schalter(pfade.kelAlk)).toHaveAttribute('data-zustand', 'an')
    await schalter(pfade.kelAlk).click()
    await expect(schalter(pfade.kelAlk)).toHaveAttribute('data-zustand', 'aus')
    await expect(schalter(pfade.kel)).toHaveAttribute('data-zustand', 'an')
    await expect(schalter(pfade.barAlk)).toHaveAttribute('data-zustand', 'an')
    await expect.poll(async () => (await liste()).includes(kelAlk.id)).toBe(false)
    const startListe = await liste()
    expect(startListe).toContain(kelBier.id)
    // Start-Auswahl: die ausgeblendete „Kellner › Alkoholfrei" steht nicht mehr zur Wahl, die beiden anderen schon
    await expect(start.locator('option', { hasText: genau(pfade.kelAlk) })).toHaveCount(0)
    await expect(start.locator('option', { hasText: genau(pfade.barAlk) })).toHaveCount(1)
    await page.getByRole('button', { name: /^Alle sichtbar$/ }).click()
    await expect.poll(liste).toEqual([])

    // =================================================================================
    // 3. Artikelformular + Artikelliste: Pfadlabel
    // =================================================================================
    await page.goto('/artikel')
    await page.getByRole('button', { name: '+ Neuer Artikel' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('Espresso').fill(`${p} Soda`)
    await dialog.getByPlaceholder('3,50').fill('2,50')
    const wgSelect = dialog.locator('select').filter({ has: page.locator('option', { hasText: 'ohne Warengruppe' }) })
    for (const pfad of [pfade.barAlk, pfade.kelAlk, pfade.evtAlk]) {
      await expect(wgSelect.locator('option', { hasText: genau(pfad) })).toHaveCount(1)
    }
    const optionen = await wgSelect.locator('option').allTextContents()
    const idx = (pfad: string) => optionen.findIndex(t => t.trim() === pfad)
    expect(idx(pfade.bar)).toBeLessThan(idx(pfade.barAlk))        // Baumreihenfolge: Eltern vor Kindern
    expect(idx(pfade.barAlk)).toBeLessThan(idx(pfade.barLim))
    expect(idx(pfade.barLim)).toBeLessThan(idx(pfade.kel))
    await wgSelect.selectOption({ label: pfade.kelAlk })
    await dialog.getByRole('button', { name: 'Anlegen', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const artikel = (await (await request.get('/api/artikel?nurAktive=false', { headers: auth })).json()) as { bezeichnung: string; kategorieId: string | null }[]
    expect(artikel.find(a => a.bezeichnung === `${p} Soda`)?.kategorieId).toBe(kelAlk.id)
    // Artikelliste: Spalte „Warengruppe" nennt bei Namensgleichheit den Pfad
    await page.getByPlaceholder('Suchen (Bezeichnung, Nummer)…').fill(`${p} Soda`)
    await expect(page.locator('tr', { hasText: `${p} Soda` }).getByText(pfade.kelAlk, { exact: true })).toBeVisible()
  } finally {
    await setzeListe([])
  }
})
