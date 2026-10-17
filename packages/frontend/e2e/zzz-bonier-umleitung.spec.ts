import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'

/**
 * Bon am Backup-Drucker: Das Personal sieht es sofort.
 *
 * Der Küchendrucker ist nicht erreichbar (Port ohne Listener), sein Backup-Drucker — der Schankdrucker — ist
 * es. Der Bon kommt an, aber am falschen Gerät. Das ist kein Fehlschlag (keine rote Meldung, kein 207), und
 * ohne Hinweis holt ihn in der Küche niemand ab. Erwartet wird ein bernsteinfarbener, nicht blockierender
 * Hinweis, der bis „Verstanden" stehen bleibt:
 *
 *  - Direktverkauf (Kasse): im Ergebnisdialog der Bonierung
 *  - Tisch (Kasse): nach dem Parken; reist beim Verlassen der Tischseite in die Tischübersicht mit;
 *    „Nochmal senden" der roten Leiste, das über den Backup-Drucker gelingt, zeigt ihn ebenfalls
 *  - Kellner-App: neben der Bestätigung nach dem Bonieren; und im Storno-Bon-Blatt nach „Nochmal senden"
 *
 * Gegenprobe jeweils: ein Bon an einen erreichbaren Drucker bleibt ohne Hinweis. Dass der Bon wirklich am
 * Schankdrucker liegt, zeigt ein TCP-Listener in diesem Prozess (das Backend läuft auf demselben Rechner).
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript — es wird kein Passwort in die Maske getippt
 * (Kellner-App: PIN über das Numpad). Alles läuft in einer eigenen Kasse mit einer einzigen Warengruppe und
 * wird am Ende wieder entfernt.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const KELLNER_URL    = 'http://127.0.0.1:5178'
const KELLNER_PIN    = '7351'

test.use({ serviceWorkers: 'block' })
test.setTimeout(180_000)

interface Login { token: string; user: unknown; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }
interface Attrappe { server: Server; port: number; empfangen: () => number }

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
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Umleitung GmbH', uid: 'ATU87654333', kassenId: 'E2E-UMLEITUNG-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
  }
  return (await res.json()) as Login
}

/** Meldet die Seite an und stellt sie auf die Kasse `kasseId` ein (Init-Skript: nur beim ersten Laden je Tab). */
async function anmelden(page: Page, login: Login, kasseId: string) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    if (sessionStorage.getItem('e2e:angemeldet')) return
    sessionStorage.setItem('e2e:angemeldet', '1')
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId,
  })
}

/** Der Keep-Alive-Ping des Backends (alle 60 s an jeden aktiven Drucker, DLE EOT 1): druckt nichts, ist kein Bon. */
const KEEPALIVE_PING = Buffer.from([0x10, 0x04, 0x01])

/**
 * TCP-Drucker-Attrappe: zählt, wie viele Verbindungen einen Bon brachten (= gedruckte Bons).
 * Der Keep-Alive-Ping zählt nicht mit: fiel er in ein Zählfenster, sah der Test einen Ausdruck zu viel
 * („Expected 5, Received 6“ — Flake, der im Gesamtlauf nur gelegentlich auftrat).
 */
function druckerAttrappe(): Promise<Attrappe> {
  return new Promise(resolve => {
    let n = 0
    const server = createServer(socket => {
      const teile: Buffer[] = []
      socket.on('data', c => teile.push(c))
      socket.on('close', () => {
        const daten = Buffer.concat(teile)
        if (daten.length > 0 && !daten.equals(KEEPALIVE_PING)) n++
      })
      socket.on('error', () => undefined)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, empfangen: () => n }))
  })
}

/** Der Satz, den das Personal liest. */
const hinweisText = (von: string, an: string) => `${von} nicht erreichbar — Bon kam an ${an}. Bitte weitergeben.`

test.describe.serial('Bon am Backup-Drucker: Hinweis für das Personal', () => {
  let api: APIRequestContext
  let login: Login
  let auth: { Authorization: string }
  const p = `Um${Date.now() % 1_000_000}`
  let schank: Attrappe
  const name = {
    schank: `Schankdrucker ${p}`,
    kueche: `Küchendrucker ${p}`,     // nicht erreichbar, Backup-Drucker = Schankdrucker
    kuehlB: `Kühlraum B ${p}`,        // nicht erreichbar, zunächst OHNE Backup-Drucker (Tisch: Nochmal senden)
    kuehlD: `Kühlraum D ${p}`,        // dito (Kellner-App: Storno-Bon nachsenden)
  }
  const ids: Record<'schank' | 'kueche' | 'kuehlB' | 'kuehlD', string> = { schank: '', kueche: '', kuehlB: '', kuehlD: '' }
  const artikel: Record<'schnitzel' | 'cola' | 'salatB' | 'salatD', { id: string; bezeichnung: string }> = {
    schnitzel: { id: '', bezeichnung: `${p} Schnitzel` },   // → Küchendrucker (Backup: Schankdrucker)
    cola:      { id: '', bezeichnung: `${p} Cola` },        // → Schankdrucker (erreichbar)
    salatB:    { id: '', bezeichnung: `${p} Salat B` },     // → Kühlraum B
    salatD:    { id: '', bezeichnung: `${p} Salat D` },     // → Kühlraum D
  }
  let gruppeId = '', kasseId = '', kellnerId = ''
  const tabs: string[] = []

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await api.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const legeTabAn = async (tischNummer: string, artikelListe: { id: string; bezeichnung: string }[] = []) => {
    const tab = await post('/api/tisch-tabs', { kasseId, tischNummer, kellner: 'E2E Service' })
    tabs.push(tab.id)
    if (artikelListe.length > 0) {
      const put = await api.put(`/api/tisch-tabs/${tab.id}/positionen`, {
        headers: auth,
        data: { positionen: artikelListe.map(a => ({ artikelId: a.id, bezeichnung: a.bezeichnung, preisBruttoCent: 1000, menge: 1 })) },
      })
      expect(put.ok(), await put.text()).toBe(true)
    }
    return tab
  }
  /** Backup-Drucker eintragen — als hätte der Kellner/Chef das Problem inzwischen bemerkt und behoben. */
  const setzeBackup = async (druckerId: string) => {
    const res = await api.patch(`/api/bonierdrucker/${druckerId}`, { headers: auth, data: { fallbackId: ids.schank } })
    expect(res.ok(), await res.text()).toBe(true)
  }

  test.beforeAll(async ({ playwright }) => {
    api   = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5173' })
    login = await adminLogin(api)
    auth  = { Authorization: `Bearer ${login.token}` }
    schank = await druckerAttrappe()

    // Port 9 hat keinen Listener → sofort „Connection refused"; der Schankdrucker ist ein echter Listener
    ids.schank = (await post('/api/bonierdrucker', { name: name.schank, ip: '127.0.0.1', port: schank.port })).id
    ids.kueche = (await post('/api/bonierdrucker', { name: name.kueche, ip: '127.0.0.1', port: 9, fallbackId: ids.schank })).id
    ids.kuehlB = (await post('/api/bonierdrucker', { name: name.kuehlB, ip: '127.0.0.1', port: 9 })).id
    ids.kuehlD = (await post('/api/bonierdrucker', { name: name.kuehlD, ip: '127.0.0.1', port: 9 })).id

    gruppeId = (await post('/api/kategorien', { name: `${p} Bonier-Umleitung`, farbe: 'blau', reihenfolge: 7301 })).id
    const legeArtikelAn = async (a: { id: string; bezeichnung: string }, bonierdruckerId: string) => {
      a.id = (await post('/api/artikel', {
        bezeichnung: a.bezeichnung, preisBruttoCent: 1000, mwstSatz: 'normal', kategorieId: gruppeId, bonierdruckerId,
      })).id
    }
    await legeArtikelAn(artikel.schnitzel, ids.kueche)
    await legeArtikelAn(artikel.cola,      ids.schank)
    await legeArtikelAn(artikel.salatB,    ids.kuehlB)
    await legeArtikelAn(artikel.salatD,    ids.kuehlD)

    // Eigene Kasse mit genau EINER Warengruppe: sie öffnet sich von selbst, die Kacheln stehen sofort da
    kasseId = (await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-UM-${p}`, bezeichnung: `${p} Umleitung`, umgebung: 'test' })).kasseId
    const konfig = await api.put(`/api/kassen/${kasseId}/pos-config`, { headers: auth, data: { sichtbareKategorieIds: [gruppeId] } })
    expect(konfig.ok(), await konfig.text()).toBe(true)

    kellnerId = (await post('/api/users', {
      name: 'Umleit Kellner', email: `umleitung-kellner-${p}@test.at`, passwort: 'kellner-passwort-123', rolle: 'kellner',
      berechtigungen: ['tische'], kassenIds: [kasseId], pin: KELLNER_PIN,
    })).id
  })

  test.afterAll(async () => {
    try {
      // Offene Tische schließen (das verwerfen schickt Storno-Bons ins Leere — gewollt egal)
      for (const id of tabs) await api.post(`/api/tisch-tabs/${id}/verwerfen`, { headers: auth, data: {} })
      if (kellnerId) await api.delete(`/api/users/${kellnerId}`, { headers: auth })
      if (kasseId) await api.post(`/api/kassen/${kasseId}/ausser-betrieb`, { headers: auth, data: {} })
      for (const a of Object.values(artikel)) if (a.id) await api.delete(`/api/artikel/${a.id}`, { headers: auth })
      if (gruppeId) await api.delete(`/api/kategorien/${gruppeId}`, { headers: auth })
      for (const id of Object.values(ids)) if (id) await api.delete(`/api/bonierdrucker/${id}`, { headers: auth })
    } finally {
      schank?.server.close()
      await api?.dispose()
    }
  })

  // ===========================================================================================================
  // Direktverkauf
  // ===========================================================================================================
  test('Direktverkauf: Bon am Backup-Drucker → Hinweis im Ergebnisdialog; erreichbarer Drucker → keiner', async ({ page }) => {
    await anmelden(page, login, kasseId)
    await page.goto('/kasse')
    const kachel  = (n: string) => page.getByTestId('artikel-kachel').filter({ hasText: n })
    const dialog  = page.getByRole('dialog')
    const hinweis = page.getByTestId('bonier-umleitung')

    await test.step('Küchendrucker nicht erreichbar: der Bon liegt am Schankdrucker — der Dialog sagt es', async () => {
      const vorher = schank.empfangen()
      await kachel(artikel.schnitzel.bezeichnung).click()
      await page.getByRole('button', { name: 'Bonieren', exact: true }).click()
      await expect(dialog.getByTestId('bonier-umleitung')).toContainText(hinweisText(name.kueche, name.schank))
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)       // er liegt wirklich dort
      await dialog.getByRole('button', { name: 'Verstanden' }).click()
      await expect(dialog).toHaveCount(0)
    })

    await test.step('Erreichbarer Drucker: der Dialog zeigt das Ergebnis, aber keinen Hinweis', async () => {
      await page.getByRole('button', { name: 'Leeren', exact: true }).click()
      await kachel(artikel.cola.bezeichnung).click()
      await page.getByRole('button', { name: 'Bonieren', exact: true }).click()
      await expect(dialog.getByText(name.schank)).toBeVisible()          // das Ergebnis ist da …
      await expect(hinweis).toHaveCount(0)                                // … ohne Hinweis
    })
  })

  // ===========================================================================================================
  // Tisch (Kasse)
  // ===========================================================================================================
  test('Tisch: Parken → Hinweis bleibt bis „Verstanden" und geht in die Tischübersicht mit; Nochmal senden über den Backup-Drucker', async ({ page }) => {
    const tisch = `U${Date.now() % 100_000}`
    const tab = await legeTabAn(tisch)
    await anmelden(page, login, kasseId)
    const kachel  = (n: string) => page.getByTestId('artikel-kachel').filter({ hasText: n })
    const hinweis = page.getByTestId('bonier-umleitung')
    const rot     = page.getByText('⚠ Bon NICHT angekommen — bitte prüfen')
    const geparkt = page.getByText('✓ Geparkt — auf den Tisch gebucht')
    const oeffneTisch = async () => {
      await page.goto(`/tische/${tab.id}`)
      await expect(page.getByRole('heading', { name: `Tisch ${tisch}` })).toBeVisible()
    }
    await oeffneTisch()

    await test.step('Parken: der Bon kommt an (Schankdrucker), kein Fehler — dafür der Hinweis, auch nach dem Verschwinden der grünen Bestätigung', async () => {
      const vorher = schank.empfangen()
      await kachel(artikel.schnitzel.bezeichnung).click()
      await page.getByRole('button', { name: 'Parken', exact: true }).click()
      await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
      await expect(geparkt).toBeVisible()
      await expect(rot).toHaveCount(0)
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await expect(geparkt).toHaveCount(0, { timeout: 8_000 })            // die grüne Bestätigung ist weg …
      await expect(hinweis).toBeVisible()                                  // … der Hinweis nicht
    })

    await test.step('Zurück zu den Tischen: der Hinweis reist mit; „Verstanden" nimmt ihn weg', async () => {
      await page.getByRole('button', { name: '← Tische' }).click()
      await expect(page).toHaveURL(/\/tische$/)
      // Erst die Tischübersicht abwarten — sonst träfe die Prüfung noch den Hinweis der alten Tischseite
      await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
      await expect(hinweis).toHaveCount(1)
      await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Erreichbarer Drucker: Parken ohne Hinweis', async () => {
      await oeffneTisch()
      await kachel(artikel.cola.bezeichnung).click()
      await page.getByRole('button', { name: 'Parken', exact: true }).click()
      await expect(geparkt).toBeVisible()
      await expect(hinweis).toHaveCount(0)
      await expect(rot).toHaveCount(0)
    })

    await test.step('Drucker ohne Backup: rote Leiste; nach Eintragen des Backups meldet „Nochmal senden" den Hinweis', async () => {
      await kachel(artikel.salatB.bezeichnung).click()
      await page.getByRole('button', { name: 'Parken', exact: true }).click()
      await expect(rot).toBeVisible()
      await expect(hinweis).toHaveCount(0)

      await setzeBackup(ids.kuehlB)
      const vorher = schank.empfangen()
      await page.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toHaveCount(0)                                     // angekommen …
      await expect(hinweis).toContainText(hinweisText(name.kuehlB, name.schank))   // … aber am Schankdrucker
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })
  })

  // ===========================================================================================================
  // Kellner-App
  // ===========================================================================================================
  /** Kellner-App auf dem Handy: PIN-Login über das Numpad, danach auf die Kasse dieses Tests eingestellt. */
  const kellnerOeffnen = async (browser: import('@playwright/test').Browser) => {
    const kontext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    await kontext.addInitScript((d: { mandantId: string; kasseId: string }) => {
      localStorage.setItem('kellner:mandantId', d.mandantId)
      localStorage.setItem('kellner:kasseId', d.kasseId)
    }, { mandantId: login.mandant.id, kasseId })
    const kellner = await kontext.newPage()
    await expect.poll(async () => (await kellner.request.get(`${KELLNER_URL}/api/health`)).status(), { timeout: 35_000, intervals: [500, 1000, 2000, 3000] }).toBe(200)
    await kellner.goto(`${KELLNER_URL}/login`)
    await expect(kellner.getByText('PIN eingeben')).toBeVisible({ timeout: 15_000 })
    for (const ziffer of KELLNER_PIN) await kellner.getByRole('button', { name: ziffer, exact: true }).click()
    await expect(kellner.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 15_000 })
    return { kontext, kellner }
  }

  test('Kellner-App: Bonieren → Hinweis neben der Bestätigung, bleibt bis „Verstanden"; erreichbarer Drucker → keiner', async ({ browser }) => {
    const mitSchnitzel = await legeTabAn(`KS${Date.now() % 100_000}`, [artikel.schnitzel])
    const mitCola      = await legeTabAn(`KC${Date.now() % 100_000}`, [artikel.cola])
    const { kontext, kellner } = await kellnerOeffnen(browser)
    try {
      const hinweis = kellner.getByTestId('bonier-umleitung')
      const gesendet = kellner.getByText('✓ Bon wurde gesendet')
      const rot = kellner.getByText('⚠ Bon NICHT angekommen')

      await test.step('Küchendrucker nicht erreichbar: der Bon liegt am Schankdrucker — der Kellner erfährt es', async () => {
        const vorher = schank.empfangen()
        await kellner.goto(`${KELLNER_URL}/tab/${mitSchnitzel.id}`)
        await kellner.getByRole('button', { name: /Bonieren$/ }).click()
        await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
        await expect(gesendet).toBeVisible()                               // zugestellt ist zugestellt …
        await expect(rot).toHaveCount(0)                                   // … kein Fehler
        await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
        await expect(gesendet).toHaveCount(0, { timeout: 8_000 })          // die Bestätigung geht nach ein paar Sekunden …
        await expect(hinweis).toBeVisible()                                // … der Hinweis bleibt
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
        await expect(hinweis).toHaveCount(0)
      })

      await test.step('Erreichbarer Drucker: Bestätigung, aber kein Hinweis', async () => {
        await kellner.goto(`${KELLNER_URL}/tab/${mitCola.id}`)
        await kellner.getByRole('button', { name: /Bonieren$/ }).click()
        await expect(gesendet).toBeVisible()
        await expect(hinweis).toHaveCount(0)
        await expect(rot).toHaveCount(0)
      })
    } finally {
      await kontext.close()
    }
  })

  test('Kellner-App: Tisch verwerfen, Storno-Bon nicht angekommen → „Nochmal senden" über den Backup-Drucker meldet den Hinweis', async ({ browser }) => {
    const tab = await legeTabAn(`KV${Date.now() % 100_000}`, [artikel.salatD])
    const { kontext, kellner } = await kellnerOeffnen(browser)
    try {
      await kellner.goto(`${KELLNER_URL}/tab/${tab.id}`)
      await kellner.getByRole('button', { name: 'Tisch-Aktionen' }).click()
      await kellner.getByRole('button', { name: /Tisch verwerfen/ }).first().click()
      await kellner.getByRole('button', { name: '🗑 Tisch verwerfen' }).click()

      // Der Kühlraum-Drucker ist nicht erreichbar, einen Backup-Drucker gibt es noch nicht → rote Meldung
      await expect(kellner.getByText('⚠ Der Tisch ist verworfen — der Storno-Bon ist NICHT überall angekommen')).toBeVisible({ timeout: 15_000 })
      await expect(kellner.getByTestId('bonier-umleitung')).toHaveCount(0)

      await setzeBackup(ids.kuehlD)
      const vorher = schank.empfangen()
      await kellner.getByRole('button', { name: 'Nochmal senden' }).click()
      const hinweis = kellner.getByTestId('bonier-umleitung')
      await expect(hinweis).toContainText(hinweisText(name.kuehlD, name.schank))
      await expect(kellner.getByText('⚠ Der Tisch ist verworfen')).toHaveCount(0)   // nichts mehr nachzusenden
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)

      // Ohne offene Fehlschläge ist „Verstanden" der Weg zurück zur Übersicht
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(kellner.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 10_000 })
    } finally {
      await kontext.close()
    }
  })
})
