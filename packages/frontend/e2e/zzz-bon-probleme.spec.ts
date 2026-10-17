import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'

/**
 * Bon-Probleme: Das Bonierergebnis erreicht das Personal auch dort, wo der SERVER selbst boniert.
 *
 * Drei Wege warfen das Ergebnis weg (niemand wartet dort auf die Antwort, bezahlt ist längst):
 *  1. Direktverkauf-Beleg mit Küchenartikeln (`bonierBeiDirektverkauf`, fire-and-forget NACH dem Beleg),
 *  2. Gast-Bestellung (der Gast hat per Karte bezahlt),
 *  3. SB-Terminal.
 * Ein toter Küchendrucker bzw. ein Bon am Backup-Drucker blieb dort völlig stumm. Jetzt merkt sich der Server eine
 * Meldung je Bestellung; die Kasse (und die Kellner-App) zeigen sie als rote Leiste „Bon NICHT angekommen“ mit
 * „Nochmal senden“ bzw. als bernsteinfarbenen Hinweis „X nicht erreichbar — Bon kam an Y. Bitte weitergeben.“
 * bis „Verstanden“. Auch eine Kasse, die beim Ausfall zu war, zeigt die Meldung beim Öffnen (kein flüchtiges Ereignis).
 *
 * „Nochmal senden“ geht mit der Bestell-ID des ersten Versuchs durch: ein Ziel, das den Bon schon hat, bekommt ihn NICHT
 * noch einmal — das zeigt der TCP-Listener dieses Prozesses (das Backend läuft auf demselben Rechner). Gegenprobe
 * jeweils: ein Bon an einen erreichbaren Drucker bleibt ohne Meldung; eine andere Kasse desselben Mandanten sieht nichts.
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript — es wird kein Passwort in die Maske getippt
 * (Kellner-App: PIN über das Numpad). Alles läuft in einer eigenen Kasse mit einer einzigen Warengruppe und wird am Ende
 * wieder entfernt. „Toter Drucker“ = 127.0.0.1:9 (kein Listener).
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const KELLNER_URL    = 'http://127.0.0.1:5178'
const KELLNER_PIN    = '7353'

test.use({ serviceWorkers: 'block' })
test.setTimeout(180_000)

interface Login { token: string; user: unknown; mandant: { id: string } & Record<string, unknown>; kassen: { id: string }[] }
interface Attrappe { server: Server; port: number; empfangen: () => number }
interface Art { id: string; bezeichnung: string }

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
        firmenname: 'E2E BonProbleme GmbH', uid: 'ATU87654335', kassenId: 'E2E-BONPROBLEME-001',
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
  const mandant = { ...login.mandant, modulSbTerminalAktiv: true }
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    if (sessionStorage.getItem('e2e:angemeldet')) return
    sessionStorage.setItem('e2e:angemeldet', '1')
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token,
    authJson: JSON.stringify({ user: login.user, mandant, kassen: login.kassen }),
    mandantId: login.mandant.id, kasseId,
  })
}

/** Der Keep-Alive-Ping des Backends (alle 60 s an jeden aktiven Drucker, DLE EOT 1): druckt nichts, ist kein Bon. */
const KEEPALIVE_PING = Buffer.from([0x10, 0x04, 0x01])

/** TCP-Drucker-Attrappe: zählt, wie viele Verbindungen einen Bon brachten (= gedruckte Bons). */
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
const ROT = '⚠ Bon NICHT angekommen — bitte prüfen'

test.describe.serial('Bon-Probleme: Direktverkauf-Beleg, Gast- und SB-Bestellung melden sich an der Kasse', () => {
  let api: APIRequestContext
  let login: Login
  let auth: { Authorization: string }
  const p = `Bp${Date.now() % 1_000_000}`
  let schank: Attrappe

  /** Name je Drucker; `kuehl*` sind tot und haben zunächst KEINEN Backup-Drucker (er kommt mitten im Test dazu) */
  const name = {
    schank: `Schankdrucker ${p}`,
    cola:   `Cola-Bar ${p}`,
    kuehlA: `Kühlraum A ${p}`,        // Kasse: Direktverkauf über die Oberfläche
    kuehlB: `Kühlraum B ${p}`,        // Kasse: Direktverkauf, Kasse war zu
    kuehlC: `Kühlraum C ${p}`,        // Kasse: Gast-Bestellung
    kuehlD: `Kühlraum D ${p}`,        // Kasse: SB-Bestellung
    kuehlE: `Kühlraum E ${p}`,        // Kellner-App: Gast-Bestellung
    kuehlF: `Kühlraum F ${p}`,        // andere Kasse sieht nichts
  }
  type DruckerSchluessel = keyof typeof name
  const ids = Object.fromEntries(Object.keys(name).map(k => [k, ''])) as Record<DruckerSchluessel, string>
  type ArtikelSchluessel = 'cola' | 'salatA' | 'salatB' | 'salatC' | 'salatD' | 'salatE' | 'salatF'
  const artikel: Record<ArtikelSchluessel, Art> = {
    cola:   { id: '', bezeichnung: `${p} Cola` },       // Schankdrucker (erreichbar)
    salatA: { id: '', bezeichnung: `${p} Salat A` },
    salatB: { id: '', bezeichnung: `${p} Salat B` },
    salatC: { id: '', bezeichnung: `${p} Salat C` },
    salatD: { id: '', bezeichnung: `${p} Salat D` },
    salatE: { id: '', bezeichnung: `${p} Salat E` },
    salatF: { id: '', bezeichnung: `${p} Salat F` },
  }
  const zuDrucker: Record<ArtikelSchluessel, DruckerSchluessel> = {
    cola: 'schank', salatA: 'kuehlA', salatB: 'kuehlB', salatC: 'kuehlC', salatD: 'kuehlD', salatE: 'kuehlE', salatF: 'kuehlF',
  }
  let gruppeId = '', kasseId = '', kasse2Id = '', kellnerId = ''
  let gastModusVorher = 'aus'
  let sbModulVorher: boolean | null = null

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await api.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  /** Backup-Drucker eintragen — als hätte der Chef das Problem inzwischen bemerkt und behoben. */
  const setzeBackup = async (druckerId: string) => {
    const res = await api.patch(`/api/bonierdrucker/${druckerId}`, { headers: auth, data: { fallbackId: ids.schank } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  /** Direktverkauf-Beleg per API (Bar); der Bon läuft fire-and-forget hinterher */
  const direktverkauf = async (a: Art) => {
    await post('/api/belege/barzahlung', {
      kasseId, positionen: [{ artikelId: a.id, menge: 1, einzelpreisBreuttoCent: 1000 }],
      zahlung: { barCent: 1000, karteCent: 0, sonstigeCent: 0 },
    })
  }
  const gastBestellung = async (a: Art, tisch: string) => {
    const res = await api.post('/api/gast/checkout', { data: { kasseId, tischNummer: tisch, positionen: [{ artikelId: a.id, menge: 1 }] } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  /** Zählt noch einen Moment weiter: ein verspäteter, doppelter Ausdruck würde sonst nicht auffallen. */
  const druckeStabil = async (erwartet: number) => {
    await expect.poll(() => schank.empfangen()).toBe(erwartet)
    await new Promise(r => setTimeout(r, 600))
    expect(schank.empfangen()).toBe(erwartet)
  }
  /** Alle offenen Meldungen einer Kasse quittieren, damit der nächste Test mit leerer Liste startet */
  const raeumeAuf = async (k: string) => {
    const liste = (await (await api.get(`/api/kassen/${k}/bon-probleme`, { headers: auth })).json()) as Array<{ id: string }>
    for (const m of liste) await api.post(`/api/bon-probleme/${m.id}/verstanden`, { headers: auth })
  }

  test.beforeAll(async ({ playwright }) => {
    api   = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5173' })
    login = await adminLogin(api)
    auth  = { Authorization: `Bearer ${login.token}` }
    schank = await druckerAttrappe()

    // Schankdrucker = echter Listener (zugleich Backup-Drucker); alle `kuehl*`: Port 9 ohne Listener → sofort „Connection refused“
    ids.schank = (await post('/api/bonierdrucker', { name: name.schank, ip: '127.0.0.1', port: schank.port })).id
    ids.cola   = ids.schank
    for (const k of ['kuehlA', 'kuehlB', 'kuehlC', 'kuehlD', 'kuehlE', 'kuehlF'] as const) {
      ids[k] = (await post('/api/bonierdrucker', { name: name[k], ip: '127.0.0.1', port: 9 })).id
    }

    gruppeId = (await post('/api/kategorien', { name: `${p} Bon-Probleme`, farbe: 'blau', reihenfolge: 7303 })).id
    for (const [k, a] of Object.entries(artikel) as Array<[ArtikelSchluessel, Art]>) {
      a.id = (await post('/api/artikel', {
        bezeichnung: a.bezeichnung, preisBruttoCent: 1000, mwstSatz: 'normal', kategorieId: gruppeId,
        bonierdruckerId: ids[zuDrucker[k]], bonierBeiDirektverkauf: true, terminalSichtbar: true,
      })).id
    }

    // Eigene Kasse mit genau EINER Warengruppe: sie öffnet sich von selbst, die Kacheln stehen sofort da
    kasseId = (await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-BP-${p}`, bezeichnung: `${p} Bon-Probleme`, umgebung: 'test' })).kasseId
    kasse2Id = (await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-BP2-${p}`, bezeichnung: `${p} andere Kasse`, umgebung: 'test' })).kasseId
    for (const k of [kasseId, kasse2Id]) {
      const konfig = await api.put(`/api/kassen/${k}/pos-config`, { headers: auth, data: { sichtbareKategorieIds: [gruppeId] } })
      expect(konfig.ok(), await konfig.text()).toBe(true)
      // Beleg gleich über den Bondrucker-Weg: kein Bon-Dialog nach dem Kassieren
      const belegModus = await api.patch(`/api/kassen/${k}/drucker`, { headers: auth, data: { belegModus: 'drucken' } })
      expect(belegModus.ok(), await belegModus.text()).toBe(true)
    }

    // Gast-Bestellung online (Demo-Pfad ohne Stripe finalisiert sofort) und SB-Terminal einschalten — beides am Ende zurück
    gastModusVorher = ((await (await api.get(`/api/kassen/${kasseId}/drucker`, { headers: auth })).json()) as { gastModus: string }).gastModus
    const gast = await api.patch(`/api/kassen/${kasseId}/drucker`, { headers: auth, data: { gastModus: 'online' } })
    expect(gast.ok(), await gast.text()).toBe(true)
    const module = (await (await api.get('/api/mandanten/module', { headers: auth })).json()) as Record<string, unknown>
    sbModulVorher = module.modulSbTerminalAktiv === true
    const sb = await api.patch('/api/mandanten/module', { headers: auth, data: { ...module, modulSbTerminalAktiv: true } })
    expect(sb.ok(), await sb.text()).toBe(true)

    kellnerId = (await post('/api/users', {
      name: 'BonProbleme Kellner', email: `bonprobleme-kellner-${p}@test.at`, passwort: 'kellner-passwort-123', rolle: 'kellner',
      berechtigungen: ['tische'], kassenIds: [kasseId], pin: KELLNER_PIN,
    })).id
  })

  test.afterAll(async () => {
    try {
      for (const k of [kasseId, kasse2Id]) if (k) await raeumeAuf(k).catch(() => undefined)
      if (sbModulVorher !== null) {
        const module = (await (await api.get('/api/mandanten/module', { headers: auth })).json()) as Record<string, unknown>
        await api.patch('/api/mandanten/module', { headers: auth, data: { ...module, modulSbTerminalAktiv: sbModulVorher } })
      }
      if (kellnerId) await api.delete(`/api/users/${kellnerId}`, { headers: auth })
      for (const k of [kasseId, kasse2Id]) {
        if (k) {
          await api.patch(`/api/kassen/${k}/drucker`, { headers: auth, data: { gastModus: gastModusVorher } }).catch(() => undefined)
          await api.post(`/api/kassen/${k}/ausser-betrieb`, { headers: auth, data: {} })
        }
      }
      for (const a of Object.values(artikel)) if (a.id) await api.delete(`/api/artikel/${a.id}`, { headers: auth })
      if (gruppeId) await api.delete(`/api/kategorien/${gruppeId}`, { headers: auth })
      for (const id of new Set(Object.values(ids))) if (id) await api.delete(`/api/bonierdrucker/${id}`, { headers: auth })
    } finally {
      schank?.server.close()
      await api?.dispose()
    }
  })

  // ===========================================================================================================
  // Direktverkauf-Beleg (Oberfläche)
  // ===========================================================================================================
  test('Kasse · Direktverkauf-Beleg: Bon nicht angekommen → rote Leiste ohne Neuladen; Nochmal senden bedient nur das tote Ziel; Backup-Drucker → Hinweis', async ({ page }) => {
    await anmelden(page, login, kasseId)
    await page.goto('/kasse')
    const kachel  = (n: string) => page.getByTestId('artikel-kachel').filter({ hasText: n })
    const rot     = page.getByTestId('bon-problem-fehler')
    const hinweis = page.getByTestId('bon-problem-umleitung')
    const bar     = page.getByRole('button', { name: /^Bar \(/ })
    await expect(kachel(artikel.cola.bezeichnung)).toBeVisible()

    await test.step('Gegenprobe — erreichbarer Drucker: der Bon kommt an, die Kasse bleibt ohne Leiste', async () => {
      const vorher = schank.empfangen()
      await kachel(artikel.cola.bezeichnung).click()
      await bar.click()
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await new Promise(r => setTimeout(r, 1500))                          // so lange würde die Leiste per Ereignis erscheinen
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Kühlraum A ist tot: rote Leiste erscheint von selbst (SSE-Anstoß, kein Neuladen) — mit Quelle und Ziel', async () => {
      await kachel(artikel.salatA.bezeichnung).click()
      await bar.click()
      await expect(rot).toBeVisible({ timeout: 12_000 })      // deutlich unter dem 30-s-Takt der Abfrage
      await expect(rot).toContainText(ROT)
      await expect(rot).toContainText('Direktverkauf')
      await expect(rot).toContainText(name.kuehlA)
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Nochmal senden, Ziel weiter tot: die Leiste bleibt — und es wird nichts doppelt gedruckt', async () => {
      const vorher = schank.empfangen()
      await rot.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toContainText(name.kuehlA)
      await new Promise(r => setTimeout(r, 600))
      expect(schank.empfangen()).toBe(vorher)
    })

    await test.step('Backup-Drucker eingetragen → Nochmal senden: Hinweis statt Leiste, der Bon liegt genau einmal am Schankdrucker', async () => {
      const vorher = schank.empfangen()
      await setzeBackup(ids.kuehlA)
      await rot.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toContainText(hinweisText(name.kuehlA, name.schank))
      await druckeStabil(vorher + 1)
    })

    await test.step('Verstanden: weg — und auch nach dem Neuladen nicht wieder da (der Server hat es gemerkt)', async () => {
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
      await page.reload()
      await expect(kachel(artikel.cola.bezeichnung)).toBeVisible()
      await expect(page.getByTestId('bon-probleme')).toHaveCount(0)
    })
  })

  test('Kasse · Direktverkauf-Beleg bei geschlossener Kasse: die Meldung steht beim Öffnen da (kein flüchtiges Ereignis)', async ({ page }) => {
    await direktverkauf(artikel.salatB)                                    // niemand schaut hin
    await expect.poll(async () => ((await (await api.get(`/api/kassen/${kasseId}/bon-probleme`, { headers: auth })).json()) as unknown[]).length).toBe(1)

    await anmelden(page, login, kasseId)
    await page.goto('/kasse')
    const rot = page.getByTestId('bon-problem-fehler')
    await expect(rot).toBeVisible()
    await expect(rot).toContainText(name.kuehlB)
    await rot.getByRole('button', { name: 'Verstanden' }).click()
    await expect(rot).toHaveCount(0)
  })

  // ===========================================================================================================
  // Gast-Bestellung
  // ===========================================================================================================
  test('Kasse · Gast-Bestellung: Bon nicht angekommen → rote Leiste in der Tischübersicht mit Tisch; Nochmal senden → Hinweis', async ({ page }) => {
    const tisch = `G${Date.now() % 10_000}`
    await gastBestellung(artikel.salatC, tisch)                            // der Gast hat bezahlt
    await anmelden(page, login, kasseId)
    await page.goto('/tische')
    await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
    const rot     = page.getByTestId('bon-problem-fehler')
    const hinweis = page.getByTestId('bon-problem-umleitung')

    await test.step('Kühlraum C ist tot: rote Leiste mit „Gast-Bestellung · Tisch …“', async () => {
      await expect(rot).toBeVisible()
      await expect(rot).toContainText(`Gast-Bestellung · Tisch ${tisch}`)
      await expect(rot).toContainText(name.kuehlC)
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Backup-Drucker eingetragen → Nochmal senden: Hinweis; Verstanden räumt auf', async () => {
      const vorher = schank.empfangen()
      await setzeBackup(ids.kuehlC)
      await rot.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toContainText(hinweisText(name.kuehlC, name.schank))
      await druckeStabil(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Gegenprobe — Gast bestellt Cola (erreichbarer Drucker): keine Meldung', async () => {
      const vorher = schank.empfangen()
      await gastBestellung(artikel.cola, `${tisch}x`)
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
      await new Promise(r => setTimeout(r, 1500))
      await expect(page.getByTestId('bon-probleme')).toHaveCount(0)
    })
  })

  // ===========================================================================================================
  // SB-Terminal
  // ===========================================================================================================
  test('Kasse · SB-Bestellung: Bon nicht angekommen → rote Leiste auf der Seite SB-Bestellungen mit der SB-Nummer', async ({ page }) => {
    const anlage = await post<{ id: string }>('/api/terminal/bestellung', { kasseId, positionen: [{ artikelId: artikel.salatD.id, menge: 1 }] })
    const bestaetigt = await api.post(`/api/terminal/bestellung/${anlage.id}/bestaetigen`)   // Demo-Zahlung
    expect(bestaetigt.ok(), await bestaetigt.text()).toBe(true)

    await anmelden(page, login, kasseId)
    await page.goto('/sb-bestellungen')
    await expect(page.getByRole('heading', { name: 'SB-Bestellungen' })).toBeVisible()
    const rot = page.getByTestId('bon-problem-fehler')
    await expect(rot).toBeVisible()
    await expect(rot).toContainText(/SB-Bestellung · SB \d+/)
    await expect(rot).toContainText(name.kuehlD)
    await rot.getByRole('button', { name: 'Verstanden' }).click()
    await expect(rot).toHaveCount(0)
  })

  // ===========================================================================================================
  // Andere Kasse desselben Mandanten
  // ===========================================================================================================
  test('Eine andere Kasse desselben Mandanten zeigt die Meldung NICHT; die betroffene Kasse schon', async ({ page, browser }) => {
    await direktverkauf(artikel.salatF)
    await expect.poll(async () => ((await (await api.get(`/api/kassen/${kasseId}/bon-probleme`, { headers: auth })).json()) as unknown[]).length).toBe(1)

    await anmelden(page, login, kasse2Id)
    await page.goto('/tische')
    await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
    await new Promise(r => setTimeout(r, 1500))
    await expect(page.getByTestId('bon-probleme')).toHaveCount(0)          // diese Kasse hat nichts ausgelöst

    const ctx = await browser.newContext({ serviceWorkers: 'block' })
    const betroffen = await ctx.newPage()
    try {
      await anmelden(betroffen, login, kasseId)
      await betroffen.goto('/tische')
      await expect(betroffen.getByTestId('bon-problem-fehler')).toContainText(name.kuehlF)
    } finally {
      await ctx.close()
      await raeumeAuf(kasseId)
    }
  })

  // ===========================================================================================================
  // Kellner-App
  // ===========================================================================================================
  /** Kellner-App auf dem Handy: PIN-Login über das Numpad, danach auf die Kasse dieses Tests eingestellt. */
  const kellnerOeffnen = async (browser: Browser) => {
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

  test('Kellner-App · Gast-Bestellung: rote Meldung mit Tisch; Nochmal senden → Hinweis; Verstanden', async ({ browser }) => {
    const { kontext, kellner } = await kellnerOeffnen(browser)
    try {
      const tisch = `K${Date.now() % 10_000}`
      const rot     = kellner.getByTestId('bon-problem-fehler')
      const hinweis = kellner.getByTestId('bon-problem-umleitung')

      await test.step('Der Gast bestellt, während der Kellner die Übersicht offen hat: die Meldung erscheint von selbst', async () => {
        await gastBestellung(artikel.salatE, tisch)
        await expect(rot).toBeVisible({ timeout: 12_000 })
        await expect(rot).toContainText(`Gast-Bestellung · Tisch ${tisch}`)
        await expect(rot).toContainText(name.kuehlE)
      })

      await test.step('Backup-Drucker eingetragen → Nochmal senden: Hinweis; der Bon liegt einmal am Schankdrucker', async () => {
        const vorher = schank.empfangen()
        await setzeBackup(ids.kuehlE)
        await rot.getByRole('button', { name: 'Nochmal senden' }).click()
        await expect(rot).toHaveCount(0)
        await expect(hinweis).toContainText(hinweisText(name.kuehlE, name.schank))
        await druckeStabil(vorher + 1)
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
        await expect(hinweis).toHaveCount(0)
      })
    } finally {
      await kontext.close()
    }
  })
})
