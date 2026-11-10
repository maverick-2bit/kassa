import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Aktionen über die Oberfläche: Mengenaktion „3 zum Preis von 2" mit Ende nach X Aktionstagen anlegen,
 * an der Kasse wirksam (Rabattzeile, Summe, Beleg); Umstellung auf „über die ganze Auswahl".
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
        firmenname: 'E2E Aktionen GmbH',
        uid:        'ATU87654344',
        kassenId:   'E2E-AKTIONEN-001',
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

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

test('Aktionen: „3 für 2" mit Ende nach Aktionstagen anlegen; an der Kasse als Rabattzeile, im Beleg, Umstellung auf „Auswahl"', async ({ page, request }) => {
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }

  const ts      = Date.now()
  const pizza   = `Aktion-Pizza ${ts}`
  const cola    = `Aktion-Cola ${ts}`
  const eis     = `Aktion-Eis ${ts}`
  const aktion  = `Dreier ${ts}`
  const neuerArtikel = async (bezeichnung: string, preisBruttoCent: number, mwstSatz = 'normal') =>
    (await (await request.post('/api/artikel', { headers: authHeader, data: { bezeichnung, preisBruttoCent, mwstSatz } })).json() as { id: string }).id
  const pizzaId = await neuerArtikel(pizza, 800, 'ermaessigt1')
  const colaId  = await neuerArtikel(cola, 300)
  const eisId   = await neuerArtikel(eis, 500, 'ermaessigt1')

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

  let regelId = ''
  try {
    // ---- Aktion anlegen: alle Wochentage, ganztägig, ab heute, Ende nach 4 Aktionstagen, Mengenaktion 3 für 2
    await page.goto('/preisregeln')
    await page.getByRole('button', { name: '+ Neue Aktion' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('z. B. Happy Hour').fill(aktion)
    for (const tag of ['Sa', 'So']) await dialog.getByRole('button', { name: tag, exact: true }).click()   // Mo–Fr sind vorbelegt
    const zeiten = dialog.locator('input[type="time"]')
    await zeiten.nth(0).fill('00:00')
    await zeiten.nth(1).fill('23:59')

    await dialog.getByTestId('aktion-ab').fill(iso(new Date()))
    await dialog.getByTestId('aktion-ende-modus').selectOption('anzahl')
    await dialog.getByTestId('aktion-wiederholungen').fill('4')
    const heute = new Date()
    const letzter = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + 3)       // alle 7 Tage aktiv → 4. Tag = heute + 3
    await expect(dialog.getByTestId('aktion-ende-vorschau')).toContainText(`${String(letzter.getDate()).padStart(2, '0')}.${String(letzter.getMonth() + 1).padStart(2, '0')}.${letzter.getFullYear()}`)

    await dialog.getByTestId('aktion-art-menge').click()
    await expect(dialog.getByTestId('aktion-menge-block')).toBeVisible()
    await expect(dialog.getByTestId('aktion-menge-kauf')).toHaveValue('3')
    await expect(dialog.getByTestId('aktion-menge-zahle')).toHaveValue('2')
    // ungültig: zahle ≥ kaufe sperrt das Speichern
    await dialog.getByTestId('aktion-menge-zahle').fill('3')
    await expect(dialog.getByRole('button', { name: 'Anlegen' })).toBeDisabled()
    await dialog.getByTestId('aktion-menge-zahle').fill('2')

    // nur die Pizza gehört zur Aktion
    await dialog.getByPlaceholder('Artikel suchen …').fill(pizza)
    await dialog.getByRole('button', { name: new RegExp(pizza) }).first().click()
    await expect(dialog.getByPlaceholder('Aktionspreis')).toHaveCount(0)           // bei der Mengenaktion keine Preisfelder
    await dialog.getByRole('button', { name: 'Anlegen' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const regeln = await (await request.get('/api/preisregeln', { headers: authHeader })).json() as
      { id: string; name: string; mengeKauf: number | null; mengeZahle: number | null; mengeModus: string | null; wiederholungen: number | null; gueltigBis: string | null; artikelIds: string[]; rabattProzent: number }[]
    const regel = regeln.find(r => r.name === aktion)!
    regelId = regel.id
    expect(regel).toMatchObject({ mengeKauf: 3, mengeZahle: 2, mengeModus: 'artikel', wiederholungen: 4, gueltigBis: iso(letzter), artikelIds: [pizzaId], rabattProzent: 0 })
    // die Liste nennt Art und Laufzeit
    await expect(page.getByText('3 für 2 · je Artikel')).toBeVisible()
    await expect(page.getByText(/4 Aktionstage bis/)).toBeVisible()

    // ---- Kasse: 2 Pizzen → kein Nachlass; 3 → eine gratis; 6 → zwei gratis; Cola zählt nicht mit
    await page.goto('/kasse')
    const bar = page.getByRole('button', { name: /^Bar \(/ })
    const kachel = async (name: string) => {
      await page.getByPlaceholder(/Artikel suchen/).fill(name)
      await page.getByRole('button', { name: new RegExp(name) }).first().click()
    }
    await kachel(pizza); await kachel(pizza)
    await expect(bar).toContainText('16,00')
    await expect(page.getByTestId('kasse-aktionszeile')).toHaveCount(0)

    await kachel(pizza)
    await expect(page.getByTestId('kasse-aktionszeile')).toHaveCount(1)
    await expect(page.getByTestId('kasse-aktionszeile')).toContainText('3 für 2')
    await expect(bar).toContainText('16,00')                                           // 3 × 8,00 − 8,00

    await kachel(cola)
    await expect(bar).toContainText('19,00')                                           // Cola nicht rabattiert

    for (let i = 0; i < 3; i++) await kachel(pizza)                                    // 6 Pizzen
    await expect(page.getByTestId('kasse-aktionszeile')).toContainText('× 2')
    await expect(bar).toContainText('35,00')                                           // 4 × 8,00 + 3,00

    // ---- Beleg: Rabattzeile steht mit dem Steuersatz der Pizza (10 %) auf dem Beleg
    await page.getByRole('checkbox', { name: /Ausgabe wählen/ }).check()
    await bar.click()
    await expect(page.getByText(/Beleg #\d+ erstellt/)).toBeVisible({ timeout: 20_000 })
    const belege = await (await request.get(`/api/belege?kasseId=${login.kassen[0]!.id}`, { headers: authHeader })).json() as
      { belegTyp: string; gesamtbetragCent: number; betraege: { ermaessigt1: number; normal: number }; positionen: { bezeichnung: string; einzelpreisBreutto: number; menge: number; mwstSatz: string }[] }[]
    const beleg = belege.find(b => b.positionen.some(p => p.bezeichnung.includes(`Dreier ${ts}`)))!
    expect(beleg.gesamtbetragCent).toBe(3500)
    expect(beleg.betraege).toMatchObject({ ermaessigt1: 3200, normal: 300 })
    expect(beleg.positionen.find(p => p.bezeichnung.includes(`Dreier ${ts}`))).toMatchObject({ einzelpreisBreutto: -800, menge: 2, mwstSatz: 'ermaessigt1' })

    // ---- Umstellung auf „über die ganze Auswahl" (Pizza, Eis, Cola → die günstigste Einheit je 3er-Gruppe ist gratis)
    const upd = await request.patch(`/api/preisregeln/${regelId}`, { headers: authHeader, data: { mengeModus: 'auswahl', artikelIds: [pizzaId, eisId, colaId] } })
    expect(upd.ok(), await upd.text()).toBe(true)
    await page.goto('/kasse')
    await kachel(pizza); await kachel(eis); await kachel(cola)
    await expect(page.getByTestId('kasse-aktionszeile')).toHaveCount(1)
    await expect(page.getByTestId('kasse-aktionszeile')).toContainText(cola)           // günstigster Artikel (3,00)
    await expect(bar).toContainText('13,00')                                           // 8,00 + 5,00 + 3,00 − 3,00
  } finally {
    if (regelId) await request.delete(`/api/preisregeln/${regelId}`, { headers: authHeader })
    for (const id of [pizzaId, colaId, eisId]) await request.delete(`/api/artikel/${id}`, { headers: authHeader })
  }
})
