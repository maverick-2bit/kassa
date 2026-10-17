import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Einrichtungs-Übersicht (Einstellungen → Kassen & Drucker): alle Kassen, Drucker, Warengruppen und KDS auf
 * einen Blick — und alles direkt änderbar, ohne zwischen Kassen zu wechseln.
 *
 *  - Kassen: zwei auf einmal anlegen (nummeriert), in der Tabelle Drucker/Belegausgabe/Startseite/KDS/Bonierdrucker
 *    je Kasse setzen, in den Details Bezeichnung, Zahlungsarten (eine bleibt immer), Gast-Bestellung
 *  - Einrichtung einer Kasse auf eine andere übernehmen
 *  - Drucker & KDS-Station je Kasse: Warengruppen UND Einzelartikel, allgemein und als Ausnahme je Kasse, „keiner",
 *    Standard, Spalten-Sammelaktion; die Anzeige zeigt, was wirklich gilt
 *  - KDS-Stationen: Drucker + Backup-Drucker je Station
 *  - Drucker-Liste: Verwendung je Drucker, anlegen und löschen
 *
 * Liegt am Ende der Suite (zzz-): legt Kassen an (am Schluss stillgelegt) — Testdaten werden aufgeräumt.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ serviceWorkers: 'block' })
test.setTimeout(240_000)

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

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await loginAbwarten(request)
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Onboarding GmbH', uid: 'ATU87654331', kassenId: 'E2E-EINR-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return (await res.json()) as Login
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

interface Ausnahme { kasseId: string; kategorieId: string | null; artikelId: string | null; bonierdruckerId: string | null; keinDrucker: boolean; station: string | null; keineStation: boolean }
interface KasseListe { id: string; kassenId: string; bezeichnung: string | null }

test('Einrichtungs-Übersicht: Kassen anlegen und einrichten, Drucker/Station je Kasse, Backup-Drucker', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const p = `Ei${Date.now() % 1_000_000}`
  page.on('dialog', d => void d.accept())

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: auth, data })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const get = async <T>(url: string): Promise<T> => {
    const res = await request.get(url, { headers: auth })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const einrichtung = () => get<{ kassen: Record<string, unknown>[]; ausnahmen: Ausnahme[] }>('/api/einrichtung')
  const kasseDaten = async (id: string) => (await einrichtung()).kassen.find(k => k.id === id) as Record<string, unknown>
  const ausnahmeAn = async (kasseId: string, ziel: { kategorieId?: string; artikelId?: string }) =>
    (await einrichtung()).ausnahmen.find(a => a.kasseId === kasseId
      && (ziel.kategorieId ? a.kategorieId === ziel.kategorieId : a.artikelId === ziel.artikelId))

  // ---- Testdaten per API ----
  const rechnung = await post('/api/drucker', { name: `${p} Rechnung`, ip: '127.0.0.1', port: 9101 })
  const bar      = await post('/api/bonierdrucker', { name: `${p} Bar`,   ip: '127.0.0.1', port: 9102 })
  const kueche   = await post('/api/bonierdrucker', { name: `${p} Küche`, ip: '127.0.0.1', port: 9103 })
  const getraenke = await post('/api/kategorien', { name: `${p} Getränke`, farbe: 'blau', reihenfolge: 7001 })
  const speisen   = await post('/api/kategorien', { name: `${p} Speisen`,  farbe: 'rot',  reihenfolge: 7002 })
  const cola      = await post('/api/artikel', { bezeichnung: `${p} Cola`,      preisBruttoCent: 300,  mwstSatz: 'normal', kategorieId: getraenke.id })
  await post('/api/artikel', { bezeichnung: `${p} Schnitzel`, preisBruttoCent: 1450, mwstSatz: 'normal', kategorieId: speisen.id })

  const angelegteKassen: string[] = []
  try {
    await anmelden(page, login)
    await page.goto('/einstellungen?bereich=kassen')

    // =================================================================================
    // 1. Aufbau: alle Abschnitte auf einer Seite
    // =================================================================================
    await test.step('alle Abschnitte stehen auf einer Seite', async () => {
      await expect(page.getByRole('heading', { name: 'Kassen', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Drucker', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Warengruppen-Verteilung' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Drucker & KDS-Station je Kasse' })).toBeVisible()
      await expect(page.getByTestId('kassen-tabelle')).toBeVisible()
    })

    // =================================================================================
    // 2. Zwei Kassen auf einmal anlegen (nummeriert)
    // =================================================================================
    await test.step('zwei Kassen auf einmal anlegen', async () => {
      await page.getByRole('button', { name: '+ Weitere Kasse anlegen' }).click()
      await expect(page.getByLabel('Kassen-ID')).not.toHaveValue('')           // nächste freie ID ist vorgeschlagen
      await page.getByLabel('Anzahl').fill('2')
      await page.getByLabel('Bezeichnung', { exact: true }).fill(`${p} Stand`)
      await page.getByRole('button', { name: '2 Kassen anlegen' }).click()
      await expect(page.getByText(/2 Kassen angelegt:/)).toBeVisible({ timeout: 90_000 })
    })
    const liste = await get<KasseListe[]>('/api/kassen')
    const stand1 = liste.find(k => k.bezeichnung === `${p} Stand 1`)!
    const stand2 = liste.find(k => k.bezeichnung === `${p} Stand 2`)!
    expect(stand1, 'Stand 1 angelegt').toBeTruthy()
    expect(stand2, 'Stand 2 angelegt').toBeTruthy()
    angelegteKassen.push(stand1.id, stand2.id)
    const zeile1 = page.getByTestId(`kasse-zeile-${stand1.kassenId}`)
    const zeile2 = page.getByTestId(`kasse-zeile-${stand2.kassenId}`)
    await expect(zeile1).toContainText('provisorisch')
    await expect(zeile2).toContainText('provisorisch')

    // =================================================================================
    // 3. Je Kasse direkt in der Tabelle einstellen
    // =================================================================================
    await test.step('Drucker, Belegausgabe, Startseite, KDS und Bonierdrucker in der Zeile', async () => {
      const n = `${p} Stand 1`
      await zeile1.getByLabel(`Rechnungsdrucker ${n}`).selectOption(rechnung.id)
      await zeile1.getByLabel(`Belegausgabe ${n}`).selectOption('beides')
      await zeile1.getByLabel(`Startseite ${n}`).selectOption('kasse')
      await zeile1.getByRole('switch', { name: `KDS ${n}` }).click()
      await expect.poll(async () => {
        const k = await kasseDaten(stand1.id)
        return [k.druckerId, k.belegModus, k.startseite, k.kdsAktiv]
      }).toEqual([rechnung.id, 'beides', 'kasse', true])

      // Bonierdrucker: leer = alle aktiv; „Bar" abwählen → ausdrückliche Liste aller ANDEREN
      const chipBar = zeile1.getByRole('button', { name: new RegExp(`${p} Bar`) })
      await expect(chipBar).toHaveAttribute('aria-pressed', 'true')
      await chipBar.click()
      await expect(chipBar).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(async () => {
        const ids = (await kasseDaten(stand1.id)).sichtbareBonierdruckerIds as string[]
        return ids.includes(bar.id) ? 'Bar noch drin' : ids.includes(kueche.id) ? 'ok' : 'Küche fehlt'
      }).toBe('ok')
    })

    // =================================================================================
    // 4. Details: Bezeichnung, Zahlungsarten, Gast-Bestellung
    // =================================================================================
    await test.step('Details: umbenennen, Zahlungsarten (eine bleibt), Gast-Bestellung', async () => {
      await zeile1.getByRole('button', { name: /^Details/ }).click()
      const name = zeile1.getByLabel('Bezeichnung der Kasse')
      await name.fill(`${p} Nord`)
      await name.press('Enter')
      await expect(zeile1).toContainText(`${p} Nord`)
      await expect.poll(async () => (await get<KasseListe[]>('/api/kassen')).find(k => k.id === stand1.id)?.bezeichnung).toBe(`${p} Nord`)

      // Zahlungsarten-Chips (im Detailbereich, damit „Bar" nicht mit dem Bonierdrucker „… Bar" verwechselt wird)
      const chip = (label: string) => zeile1.getByTestId('kasse-details').getByRole('button', { name: new RegExp(`${label}$`) })
      await chip('Karte').click()
      await expect.poll(async () => (await kasseDaten(stand1.id)).erlaubteZahlungsarten).toEqual(['bar', 'sonstige'])
      await chip('Bar').click()
      await expect.poll(async () => (await kasseDaten(stand1.id)).erlaubteZahlungsarten).toEqual(['sonstige'])
      await chip('Sonstige').click()                                         // die letzte bleibt erlaubt
      await expect(page.getByText('Mindestens eine Zahlungsart muss erlaubt bleiben.')).toBeVisible()
      expect((await kasseDaten(stand1.id)).erlaubteZahlungsarten).toEqual(['sonstige'])

      const gast = zeile1.getByLabel('Gast-Bestellung per Tisch-QR')
      await gast.selectOption('tab')
      await expect(zeile1.getByText('Die Bestellung erscheint als offener Tisch')).toBeVisible()
      await expect.poll(async () => (await kasseDaten(stand1.id)).gastModus).toBe('tab')
    })

    // =================================================================================
    // 5. Einrichtung einer Kasse auf eine andere übernehmen
    // =================================================================================
    await test.step('Einrichtung von Stand Nord auf Stand 2 übernehmen', async () => {
      await zeile2.getByRole('button', { name: /^Details/ }).click()
      await zeile2.getByLabel(`Einrichtung für ${p} Stand 2 übernehmen von`).selectOption({ label: `${p} Nord` })
      await zeile2.getByRole('button', { name: 'Übernehmen' }).click()
      await expect(page.getByText(new RegExp(`Einrichtung von „${p} Nord" auf „${p} Stand 2" übernommen`))).toBeVisible({ timeout: 15_000 })
      const k2 = await kasseDaten(stand2.id)
      expect(k2).toMatchObject({ druckerId: rechnung.id, belegModus: 'beides', startseite: 'kasse', kdsAktiv: true, gastModus: 'tab' })
      expect(k2.erlaubteZahlungsarten).toEqual(['sonstige'])
      expect(k2.sichtbareBonierdruckerIds).toEqual((await kasseDaten(stand1.id)).sichtbareBonierdruckerIds)
      // Details wieder zuklappen
      await zeile2.getByRole('button', { name: /^Details/ }).click()
      await zeile1.getByRole('button', { name: /^Details/ }).click()
    })

    // =================================================================================
    // 6. Drucker je Warengruppe und Kasse
    // =================================================================================
    const matrix = page.locator('section', { has: page.getByRole('heading', { name: 'Drucker & KDS-Station je Kasse' }) })
    const zeile = (name: string) => matrix.locator(`[data-testid="routing-zeile"][data-name="${name}"]`)
    const zelle = (name: string, kassenId: string) => zeile(name).locator(`[data-testid="routing-zelle"][data-kasse="${kassenId}"]`)

    await test.step('Warengruppe: allgemein, Ausnahme an einer Kasse, „keiner", zurück auf Standard', async () => {
      await expect(matrix.getByTestId('routing-matrix')).toHaveAttribute('data-merkmal', 'drucker')
      const g = `${p} Getränke`
      await zeile(g).getByTestId('routing-allgemein').selectOption(bar.id)
      await expect.poll(async () =>
        (await get<{ id: string; bonierdruckerId: string | null }[]>('/api/kategorien')).find(k => k.id === getraenke.id)?.bonierdruckerId).toBe(bar.id)
      // an beiden Stand-Kassen gilt zunächst die allgemeine Vorgabe (grau, mit ↳)
      await expect(zelle(g, stand1.kassenId).locator('option:checked')).toHaveText(`↳ ${p} Bar`)
      await expect(zelle(g, stand1.kassenId)).toHaveAttribute('data-ausnahme', 'nein')

      await zelle(g, stand1.kassenId).selectOption(kueche.id)
      await expect(zelle(g, stand1.kassenId)).toHaveAttribute('data-ausnahme', 'ja')
      await expect.poll(async () => (await ausnahmeAn(stand1.id, { kategorieId: getraenke.id }))?.bonierdruckerId).toBe(kueche.id)
      await expect(zelle(g, stand2.kassenId).locator('option:checked')).toHaveText(`↳ ${p} Bar`)   // die andere Kasse bleibt bei der Vorgabe

      await zelle(g, stand1.kassenId).selectOption('keiner')
      await expect.poll(async () => (await ausnahmeAn(stand1.id, { kategorieId: getraenke.id }))?.keinDrucker).toBe(true)
      await expect(zelle(g, stand1.kassenId).locator('option:checked')).toHaveText('— keiner —')

      await zelle(g, stand1.kassenId).selectOption('')                      // Standard
      await expect.poll(async () => await ausnahmeAn(stand1.id, { kategorieId: getraenke.id })).toBeUndefined()
      await expect(zelle(g, stand1.kassenId)).toHaveAttribute('data-ausnahme', 'nein')
    })

    // =================================================================================
    // 7. KDS-Station je Warengruppe und Kasse
    // =================================================================================
    await test.step('KDS-Station: Ausnahme an einer Kasse (die Kopfzeile zeigt, ob das KDS an ist)', async () => {
      await matrix.getByTestId('routing-merkmal-station').click()
      await expect(matrix.getByTestId('routing-matrix')).toHaveAttribute('data-merkmal', 'station')
      await expect(matrix.getByRole('columnheader', { name: new RegExp(`${p} Nord.*KDS an`) })).toBeVisible()
      const s = `${p} Speisen`
      await zelle(s, stand1.kassenId).selectOption('kueche')
      await expect.poll(async () => (await ausnahmeAn(stand1.id, { kategorieId: speisen.id }))?.station).toBe('kueche')
      await zelle(s, stand1.kassenId).selectOption('keiner')
      await expect.poll(async () => (await ausnahmeAn(stand1.id, { kategorieId: speisen.id }))?.keineStation).toBe(true)
      await zelle(s, stand1.kassenId).selectOption('')
      await expect.poll(async () => await ausnahmeAn(stand1.id, { kategorieId: speisen.id })).toBeUndefined()
    })

    // =================================================================================
    // 8. Einzelartikel
    // =================================================================================
    await test.step('Einzelartikel: allgemein und Ausnahme je Kasse', async () => {
      await matrix.getByTestId('routing-merkmal-drucker').click()
      await matrix.getByTestId('routing-ebene-artikel').click()
      await matrix.getByLabel('Artikel suchen').fill(`${p} Cola`)
      const a = `${p} Cola`
      await expect(zeile(a)).toBeVisible()
      // Der Artikel folgt zunächst seiner Warengruppe (Getränke → Bar)
      await expect(zeile(a).getByTestId('routing-allgemein').locator('option:checked')).toHaveText(`↳ ${p} Bar`)

      await zeile(a).getByTestId('routing-allgemein').selectOption(kueche.id)
      await expect.poll(async () =>
        (await get<{ id: string; bonierdruckerId: string | null }[]>(`/api/artikel?mandantId=${login.mandant.id}&nurAktive=true`)).find(x => x.id === cola.id)?.bonierdruckerId).toBe(kueche.id)

      await zelle(a, stand2.kassenId).selectOption(bar.id)
      await expect.poll(async () => (await ausnahmeAn(stand2.id, { artikelId: cola.id }))?.bonierdruckerId).toBe(bar.id)
      await expect(zelle(a, stand1.kassenId).locator('option:checked')).toHaveText(`↳ ${p} Küche`)   // eigene Vorgabe des Artikels gilt
    })

    // =================================================================================
    // 9. Spalten-Sammelaktion (alle Warengruppen einer Kasse auf einen Drucker)
    // =================================================================================
    await test.step('Sammelaktion: alle Warengruppen einer Kasse auf einen Drucker, dann wieder Standard', async () => {
      await matrix.getByTestId('routing-ebene-warengruppen').click()
      await matrix.getByLabel(`Alle Warengruppen an ${p} Stand 2 setzen`).selectOption(kueche.id)
      await expect.poll(async () => {
        const a = await ausnahmeAn(stand2.id, { kategorieId: getraenke.id })
        const b = await ausnahmeAn(stand2.id, { kategorieId: speisen.id })
        return [a?.bonierdruckerId, b?.bonierdruckerId]
      }).toEqual([kueche.id, kueche.id])
      await expect(zelle(`${p} Speisen`, stand2.kassenId)).toHaveAttribute('data-ausnahme', 'ja')

      await matrix.getByLabel(`Alle Warengruppen an ${p} Stand 2 setzen`).selectOption('standard')
      await expect.poll(async () => (await einrichtung()).ausnahmen.filter(x => x.kasseId === stand2.id && x.kategorieId).length).toBe(0)
      // die Ausnahme des ARTIKELS bleibt (andere Ebene)
      expect((await ausnahmeAn(stand2.id, { artikelId: cola.id }))?.bonierdruckerId).toBe(bar.id)
    })

    // =================================================================================
    // 10. KDS-Stationen: Drucker + Backup-Drucker
    // =================================================================================
    await test.step('KDS-Station: Drucker und Backup-Drucker wählen', async () => {
      await page.getByLabel('Drucker für Küche', { exact: true }).selectOption(bar.id)
      await expect.poll(async () =>
        (await get<{ eintraege: { station: string; bonierdruckerId: string }[] }>('/api/kds/station-drucker')).eintraege.find(e => e.station === 'kueche')?.bonierdruckerId).toBe(bar.id)
      const backup = page.getByLabel('Backup-Drucker für Küche', { exact: true })
      await expect(backup).toBeEnabled()
      await backup.selectOption(kueche.id)
      await expect.poll(async () =>
        (await get<{ id: string; fallbackId: string | null }[]>('/api/bonierdrucker')).find(d => d.id === bar.id)?.fallbackId).toBe(kueche.id)
    })

    // =================================================================================
    // 11. Drucker-Liste: Verwendung, anlegen, löschen
    // =================================================================================
    await test.step('Drucker-Liste zeigt, wofür jeder Drucker eingesetzt ist; anlegen und löschen', async () => {
      const barZeile = page.getByTestId(`drucker-zeile-${p} Bar`)
      await expect(barZeile.getByTestId('drucker-verwendung')).toContainText(`Warengruppen: ${p} Getränke`)
      await expect(barZeile.getByTestId('drucker-verwendung')).toContainText('KDS-Papier: Küche')
      await expect(barZeile.getByTestId('drucker-verwendung')).toContainText(`Backup: ${p} Küche`)
      await expect(barZeile.getByTestId('drucker-verwendung')).toContainText('Kassen-Ausnahmen: 1')    // Cola an Stand 2
      await expect(page.getByTestId(`drucker-zeile-${p} Rechnung`).getByTestId('drucker-verwendung')).toContainText(`Rechnung: ${p} Nord, ${p} Stand 2`)
      // Der Backup-Drucker zeigt auch, für wen er einspringt (und ist deshalb nicht „nicht zugeordnet")
      await expect(page.getByTestId(`drucker-zeile-${p} Küche`).getByTestId('drucker-verwendung')).toContainText(`Backup für: ${p} Bar`)

      await page.getByRole('button', { name: '+ weiteren Drucker einrichten' }).click()
      await page.getByRole('radio', { name: /Bonierdrucker/ }).click()
      // Zwei verschiedene Dinge, zwei Namen: Backup-Drucker = Ersatz bei Ausfall, Zweitdrucker = Kopie jedes Bons
      await expect(page.getByText('Backup-Drucker (optional)')).toBeVisible()
      await expect(page.getByText('Zweitdrucker', { exact: true })).toBeVisible()
      await expect(page.getByText('Springt ein, wenn dieser Drucker nicht erreichbar ist', { exact: false })).toBeVisible()
      await page.getByLabel('Name', { exact: true }).fill(`${p} Neu`)
      await page.getByLabel('IP-Adresse').fill('127.0.0.1')
      await page.getByLabel('Port', { exact: true }).fill('9104')
      await page.getByRole('button', { name: 'Anlegen', exact: true }).click()
      const neu = page.getByTestId(`drucker-zeile-${p} Neu`)
      await expect(neu).toBeVisible()
      await expect(neu.getByTestId('drucker-verwendung')).toContainText('nicht zugeordnet')
      await neu.getByRole('button', { name: 'Löschen' }).click()
      await expect(neu).toHaveCount(0)
    })

    // =================================================================================
    // 11b. Einzelartikel auf die Warengruppe zurücksetzen; Artikel ohne Zuordnung finden
    // =================================================================================
    await test.step('Einzelartikel: auf Warengruppe zurücksetzen und „ohne Zuordnung" filtern', async () => {
      await matrix.getByTestId('routing-ebene-artikel').click()
      await matrix.getByLabel('Artikel suchen').fill(`${p} Cola`)
      // Cola hat einen eigenen Drucker (Küche) und eine Ausnahme an Stand 2 (Bar)
      await matrix.getByLabel(`${p} Cola markieren`).check()
      await matrix.getByRole('button', { name: /Markierte auf Warengruppe zurücksetzen \(1\)/ }).click()
      await expect(matrix.getByText('1 Artikel folgen jetzt ihrer Warengruppe.')).toBeVisible()
      await expect.poll(async () =>
        (await get<{ id: string; bonierdruckerId: string | null }[]>(`/api/artikel?mandantId=${login.mandant.id}&nurAktive=true`)).find(x => x.id === cola.id)?.bonierdruckerId).toBeNull()
      await expect.poll(async () => await ausnahmeAn(stand2.id, { artikelId: cola.id })).toBeUndefined()
      await expect(zeile(`${p} Cola`).getByTestId('routing-allgemein').locator('option:checked')).toHaveText(`↳ ${p} Bar`)

      // „Ohne Zuordnung": Speisen haben weder Drucker noch Station, Getränke gehen an die Bar
      await matrix.getByLabel('Artikel zeigen').selectOption('ohne')
      await matrix.getByLabel('Artikel suchen').fill(`${p} `)
      await expect(zeile(`${p} Schnitzel`)).toBeVisible()
      await expect(zeile(`${p} Cola`)).toHaveCount(0)
    })

    // =================================================================================
    // 12. Alte Adressen führen auf die neue Seite
    // =================================================================================
    await test.step('Lesezeichen /bonierdrucker, /kassen-startseite und /kds-zuordnung führen auf die Übersicht', async () => {
      for (const alt of ['/bonierdrucker', '/kassen-startseite', '/kds-zuordnung']) {
        await page.goto(alt)
        await expect(page).toHaveURL(/\/einstellungen\?bereich=kassen/)
        await expect(page.getByTestId('kassen-tabelle')).toBeVisible()
      }
      // der frühere Bereich „Hardware" ist aufgegangen: die Adresse zeigt die Übersicht (Standardbereich)
      await page.goto('/einstellungen?bereich=hardware')
      await expect(page.getByTestId('kassen-tabelle')).toBeVisible()
    })
  } finally {
    // ---- aufräumen: Kassen stilllegen, Testdaten entfernen ----
    for (const id of angelegteKassen) await request.post(`/api/kassen/${id}/ausser-betrieb`, { headers: auth, data: {} })
    await request.delete(`/api/kategorien/${getraenke.id}`, { headers: auth })
    await request.delete(`/api/kategorien/${speisen.id}`, { headers: auth })
    for (const d of [bar, kueche]) await request.delete(`/api/bonierdrucker/${d.id}`, { headers: auth })
    await request.delete(`/api/drucker/${rechnung.id}`, { headers: auth })
  }
})

/**
 * Die Kassen-Tabelle passt bei 1280 px Fensterbreite ohne seitliches Scrollen. Der Kassen-PC hat 1280×800, davon
 * 15 px Scrollbalken (der Browser im Test zeigt keinen) → gemessen wird bei 1265 px Seitenbreite. Mit Gastro hat die
 * Tabelle 9 Spalten; weder ihr Wrapper (overflow-x-auto) noch die Seite darf seitlich scrollen — auch nicht mit den
 * breitesten Inhalten (Bonierdrucker-Chip mit „· Zweitdrucker"). Neue Spalten oder Mindestbreiten in
 * KassenSektion.tsx müssen sich an diesem Test messen lassen.
 */
test('Kassen-Tabelle: passt bei 1280 px Fensterbreite ohne seitliches Scrollen (mit Gastro, 9 Spalten)', async ({ page, request }) => {
  const login = await adminLogin(request)
  const auth = { Authorization: `Bearer ${login.token}` }
  const p = `Br${Date.now() % 1_000_000}`
  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await request.post(url, { headers: auth, data })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  // Die breitesten Inhalte: Chips in jeder Zeile (ein gewöhnlicher Bonierdrucker und ein Zweitdrucker mit einem langen
  // Wort im Namen — das längste Wort darf die Mindestbreite der Spalte nicht vorgeben) und eine zweite aktive Kasse —
  // nur Zeilen anderer Kassen haben den Knopf „Wechseln" (bei nur einer Kasse wäre die Tabelle schmaler)
  const normal = await post('/api/bonierdrucker', { name: `${p} Küche`, ip: '127.0.0.1', port: 9106 })
  const zweit  = await post('/api/bonierdrucker', { name: `${p} Getränkeausgabe`, ip: '127.0.0.1', port: 9107, istBackup: true })
  const kasse  = await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-BR-${p}`, bezeichnung: `${p} Zweite Kasse`, umgebung: 'test' })
  try {
    await anmelden(page, login)
    await page.setViewportSize({ width: 1280 - 15, height: 800 })
    await page.goto('/einstellungen?bereich=kassen')

    const tabelle = page.getByTestId('kassen-tabelle')
    await expect(tabelle).toBeVisible()
    await expect(tabelle.locator('thead th')).toHaveCount(9)                   // mit Gastro: die Bonierdrucker-Spalte ist da
    // Erst messen, wenn die Zeilen vollständig sind: Auswahlfelder (bzw. „öffnet … automatisch"), Chips und Knöpfe stehen da
    await expect(tabelle.locator('select[aria-label^="Artikelwahl startet mit"], [data-testid^="start-reiter-einzige-"]').first()).toBeVisible()
    await expect(tabelle.getByRole('button', { name: new RegExp(`${p} Getränkeausgabe`) }).first()).toBeVisible()
    await expect(tabelle.getByRole('button', { name: new RegExp(`${p} Küche`) }).first()).toBeVisible()
    await expect(tabelle.getByTestId(`kasse-zeile-E2E-BR-${p}`).getByRole('button', { name: 'Wechseln' })).toBeVisible()

    const mass = () => tabelle.evaluate(t => {
      const wrapper = t.parentElement!
      const seite = document.documentElement
      return { wrapperScroll: wrapper.scrollWidth, wrapperClient: wrapper.clientWidth, seiteScroll: seite.scrollWidth, seiteClient: seite.clientWidth }
    })
    await expect.poll(async () => { const m = await mass(); return m.wrapperScroll - m.wrapperClient },
      { message: 'Überbreite der Kassen-Tabelle in px (> 0 = scrollt seitlich)' }).toBeLessThanOrEqual(0)
    const m = await mass()
    expect(m.seiteScroll, 'die Seite selbst scrollt nicht seitlich').toBeLessThanOrEqual(m.seiteClient)
  } finally {
    await request.post(`/api/kassen/${kasse.kasseId}/ausser-betrieb`, { headers: auth, data: {} })
    for (const d of [normal, zweit]) await request.delete(`/api/bonierdrucker/${d.id}`, { headers: auth })
  }
})
