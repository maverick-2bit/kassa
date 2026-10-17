import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'

/**
 * Bonierergebnis erreicht das Personal — auch dort, wo nicht die Oberfläche boniert.
 *
 * Bis hierher blieben vier Wege stumm (Fehlschlag UND Umleitung auf den Backup-Drucker):
 *
 *  1. Gang abrufen / Position nachschicken (Kasse + Kellner-App): der SERVER boniert für den Kellner
 *     und warf das Ergebnis weg. Ein ganz gescheiterter Gang-Abruf blieb ohne jede Meldung.
 *  2. Storno-Bon (Position korrigiert / Tisch verworfen): ein Korrekturbon am Backup-Drucker blieb unbemerkt.
 *  3. Sofort-Kassieren am Tisch: die rote Leiste „Bon NICHT angekommen“ ging beim Wechsel in die
 *     Tischübersicht verloren.
 *  4. (Verwandt) Parken schlägt fehl, der Kellner geht mit „← Tische“ weiter: dieselbe Leiste war weg.
 *
 * Erwartet wird jeweils die rote Leiste mit „Nochmal senden“ (Fehlschlag) bzw. der bernsteinfarbene Hinweis
 * bis „Verstanden“ (Bon liegt am Backup-Drucker). „Nochmal senden“ geht mit der Bestell-ID des ersten
 * Versuchs durch: ein Ziel, das den Bon schon hat, bekommt ihn NICHT noch einmal — das zeigt der TCP-Listener
 * dieses Prozesses (das Backend läuft auf demselben Rechner). Gegenprobe jeweils: ein Bon an einen
 * erreichbaren Drucker bleibt ohne Meldung.
 *
 * Meldet über die API an und setzt die Anmeldung per Init-Skript — es wird kein Passwort in die Maske getippt
 * (Kellner-App: PIN über das Numpad). Alles läuft in einer eigenen Kasse mit einer einzigen Warengruppe und
 * wird am Ende wieder entfernt. „Toter Drucker“ = 127.0.0.1:9 (kein Listener).
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'
const KELLNER_URL    = 'http://127.0.0.1:5178'
const KELLNER_PIN    = '7352'

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
        firmenname: 'E2E Rueckmeldung GmbH', uid: 'ATU87654334', kassenId: 'E2E-RUECKMELDUNG-001',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        umgebung: 'test', admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await loginAbwarten(request)
  }
  return (await res.json()) as Login
}

/**
 * Meldet die Seite an und stellt sie auf die Kasse `kasseId` ein (Init-Skript: nur beim ersten Laden je Tab).
 * `gaenge`: das Gänge-Modul gilt in der Oberfläche als aktiv (wie nach dem Einschalten in den Einstellungen).
 */
async function anmelden(page: Page, login: Login, kasseId: string, gaenge = false) {
  const mandant = gaenge ? { ...login.mandant, modulGaengeAktiv: true, gaengeAnzahl: 3 } : login.mandant
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

/**
 * TCP-Drucker-Attrappe: zählt, wie viele Verbindungen einen Bon brachten (= gedruckte Bons).
 * Ohne die Ausnahme zählte der Keep-Alive-Ping mit — und fiel er in ein Zählfenster, hieß es „einmal zu oft gedruckt“.
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
const ROT_KASSE   = '⚠ Bon NICHT angekommen — bitte prüfen'

test.describe.serial('Bonierergebnis erreicht das Personal: Gang abrufen, Nachschicken, Storno, Kassieren', () => {
  let api: APIRequestContext
  let login: Login
  let auth: { Authorization: string }
  const p = `Rm${Date.now() % 1_000_000}`
  let schank: Attrappe

  /** Name je Drucker; `kuehl*` sind tot und haben zunächst KEINEN Backup-Drucker (er kommt mitten im Test dazu) */
  const name = {
    schank: `Schankdrucker ${p}`,
    kueche: `Küchendrucker ${p}`,     // tot, Backup-Drucker = Schankdrucker
    kuehlA: `Kühlraum A ${p}`,        // Kasse: Gang abrufen
    kuehlB: `Kühlraum B ${p}`,        // Kasse: Nachschicken
    kuehlC: `Kühlraum C ${p}`,        // Kasse: Sofort-Kassieren
    kuehlD: `Kühlraum D ${p}`,        // Kasse: Parken, dann „← Tische“
    kuehlE: `Kühlraum E ${p}`,        // Kellner: Gang abrufen
    kuehlF: `Kühlraum F ${p}`,        // Kellner: Nachschicken
    kuehlG: `Kühlraum G ${p}`,        // Kasse: Storno-Bon (Position korrigiert)
    kuehlH: `Kühlraum H ${p}`,        // Kellner: Storno-Bon (Position entfernt)
  }
  type DruckerSchluessel = keyof typeof name
  const ids = Object.fromEntries(Object.keys(name).map(k => [k, ''])) as Record<DruckerSchluessel, string>
  type ArtikelSchluessel = 'schnitzel' | 'cola' | 'salatA' | 'salatB' | 'salatC' | 'salatD' | 'salatE' | 'salatF' | 'salatG' | 'salatH'
  const artikel: Record<ArtikelSchluessel, Art> = {
    schnitzel: { id: '', bezeichnung: `${p} Schnitzel` },   // → Küchendrucker (tot, Backup: Schankdrucker)
    cola:      { id: '', bezeichnung: `${p} Cola` },         // → Schankdrucker (erreichbar)
    salatA:    { id: '', bezeichnung: `${p} Salat A` },
    salatB:    { id: '', bezeichnung: `${p} Salat B` },
    salatC:    { id: '', bezeichnung: `${p} Salat C` },
    salatD:    { id: '', bezeichnung: `${p} Salat D` },
    salatE:    { id: '', bezeichnung: `${p} Salat E` },
    salatF:    { id: '', bezeichnung: `${p} Salat F` },
    salatG:    { id: '', bezeichnung: `${p} Salat G` },
    salatH:    { id: '', bezeichnung: `${p} Salat H` },
  }
  const zuDrucker: Record<ArtikelSchluessel, DruckerSchluessel> = {
    schnitzel: 'kueche', cola: 'schank', salatA: 'kuehlA', salatB: 'kuehlB', salatC: 'kuehlC', salatD: 'kuehlD', salatE: 'kuehlE', salatF: 'kuehlF',
    salatG: 'kuehlG', salatH: 'kuehlH',
  }
  let gruppeId = '', kasseId = '', kellnerId = ''
  const tabs: string[] = []

  const post = async <T = { id: string }>(url: string, data: unknown): Promise<T> => {
    const res = await api.post(url, { headers: auth, data, timeout: 90_000 })
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  /** Offener Tisch mit Positionen; `gang` (0 = Sofort) und `gesendet` (Gang schon abgerufen → ↻ möglich) je Position */
  const legeTabAn = async (
    tischNummer: string,
    positionen: Array<{ a: Art; gang?: number; gesendet?: boolean; menge?: number }> = [],
  ) => {
    const tab = await post<{ id: string; tischNummer: string }>('/api/tisch-tabs', { kasseId, tischNummer, kellner: 'E2E Service' })
    tabs.push(tab.id)
    if (positionen.length > 0) {
      const jetzt = new Date().toISOString()
      const put = await api.put(`/api/tisch-tabs/${tab.id}/positionen`, {
        headers: auth,
        data: {
          positionen: positionen.map(x => ({
            artikelId: x.a.id, bezeichnung: x.a.bezeichnung, preisBruttoCent: 1000, menge: x.menge ?? 1,
            ...(x.gang !== undefined ? { gang: x.gang } : {}),
            ...(x.gesendet ? { gesendetAm: jetzt } : {}),
          })),
        },
      })
      expect(put.ok(), await put.text()).toBe(true)
    }
    return tab
  }
  const tischName = (kurz: string) => `${kurz}${Date.now() % 100_000}`
  /** Backup-Drucker eintragen — als hätte der Chef das Problem inzwischen bemerkt und behoben. */
  const setzeBackup = async (druckerId: string) => {
    const res = await api.patch(`/api/bonierdrucker/${druckerId}`, { headers: auth, data: { fallbackId: ids.schank } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  const gaengeModul = async (aktiv: boolean) => {
    const res = await api.patch('/api/mandanten/module', { headers: auth, data: { modulGaengeAktiv: aktiv, gaengeAnzahl: 3 } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  /** Zählt noch einen Moment weiter: ein verspäteter, doppelter Ausdruck würde sonst nicht auffallen. */
  const druckeStabil = async (erwartet: number) => {
    await expect.poll(() => schank.empfangen()).toBe(erwartet)
    await new Promise(r => setTimeout(r, 600))
    expect(schank.empfangen()).toBe(erwartet)
  }

  test.beforeAll(async ({ playwright }) => {
    api   = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5173' })
    login = await adminLogin(api)
    auth  = { Authorization: `Bearer ${login.token}` }
    schank = await druckerAttrappe()

    // Schankdrucker = echter Listener; alle anderen: Port 9 ohne Listener → sofort „Connection refused“
    ids.schank = (await post('/api/bonierdrucker', { name: name.schank, ip: '127.0.0.1', port: schank.port })).id
    ids.kueche = (await post('/api/bonierdrucker', { name: name.kueche, ip: '127.0.0.1', port: 9, fallbackId: ids.schank })).id
    for (const k of ['kuehlA', 'kuehlB', 'kuehlC', 'kuehlD', 'kuehlE', 'kuehlF', 'kuehlG', 'kuehlH'] as const) {
      ids[k] = (await post('/api/bonierdrucker', { name: name[k], ip: '127.0.0.1', port: 9 })).id
    }

    gruppeId = (await post('/api/kategorien', { name: `${p} Bonier-Rückmeldung`, farbe: 'blau', reihenfolge: 7302 })).id
    for (const [k, a] of Object.entries(artikel) as Array<[ArtikelSchluessel, Art]>) {
      a.id = (await post('/api/artikel', {
        bezeichnung: a.bezeichnung, preisBruttoCent: 1000, mwstSatz: 'normal', kategorieId: gruppeId,
        bonierdruckerId: ids[zuDrucker[k]],
      })).id
    }

    // Eigene Kasse mit genau EINER Warengruppe: sie öffnet sich von selbst, die Kacheln stehen sofort da
    kasseId = (await post<{ kasseId: string }>('/api/kassen', { kassenId: `E2E-RM-${p}`, bezeichnung: `${p} Rückmeldung`, umgebung: 'test' })).kasseId
    const konfig = await api.put(`/api/kassen/${kasseId}/pos-config`, { headers: auth, data: { sichtbareKategorieIds: [gruppeId] } })
    expect(konfig.ok(), await konfig.text()).toBe(true)
    // Beleg gleich über den Bondrucker-Weg: kein Bon-Dialog nach dem Kassieren
    const belegModus = await api.patch(`/api/kassen/${kasseId}/drucker`, { headers: auth, data: { belegModus: 'drucken' } })
    expect(belegModus.ok(), await belegModus.text()).toBe(true)

    kellnerId = (await post('/api/users', {
      name: 'Rückmeldung Kellner', email: `rueckmeldung-kellner-${p}@test.at`, passwort: 'kellner-passwort-123', rolle: 'kellner',
      berechtigungen: ['tische'], kassenIds: [kasseId], pin: KELLNER_PIN,
    })).id
  })

  test.afterAll(async () => {
    try {
      await gaengeModul(false).catch(() => undefined)
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
  // Kasse: Gang abrufen
  // ===========================================================================================================
  test('Kasse · Gang abrufen: Bon nicht angekommen → rote Leiste; Nochmal senden bedient nur das tote Ziel; Backup-Drucker → Hinweis', async ({ page }) => {
    const teilweise = await legeTabAn(tischName('G'), [
      { a: artikel.cola,   gang: 1 },      // Schankdrucker: erreichbar
      { a: artikel.salatA, gang: 1 },      // Kühlraum A: tot, ohne Backup-Drucker
    ])
    const umgeleitet  = await legeTabAn(tischName('H'), [{ a: artikel.schnitzel, gang: 1 }])   // Küchendrucker tot, Backup: Schank
    const ohneBefund  = await legeTabAn(tischName('I'), [{ a: artikel.cola, gang: 1 }])
    await anmelden(page, login, kasseId, true)
    const rot     = page.getByText(ROT_KASSE)
    const hinweis = page.getByTestId('bonier-umleitung')
    const gangKnopf = page.getByRole('button', { name: /1\. Gang abrufen/ })
    const oeffneTisch = async (tab: { id: string; tischNummer: string }) => {
      await page.goto(`/tische/${tab.id}`)
      await expect(page.getByRole('heading', { name: `Tisch ${tab.tischNummer}` })).toBeVisible()
    }

    await test.step('Ein Ziel ist tot: rote Leiste mit genau diesem Ziel — der Gang gilt trotzdem als gesendet', async () => {
      await oeffneTisch(teilweise)
      const vorher = schank.empfangen()
      await gangKnopf.click()
      await expect(rot).toBeVisible()
      await expect(page.getByText(name.kuehlA)).toBeVisible()
      await expect(page.getByText(name.schank)).toHaveCount(0)             // der Schankdrucker bekam seinen Bon
      await expect(hinweis).toHaveCount(0)
      await expect(gangKnopf).toHaveCount(0)                               // gebucht ist gebucht: der Gang ist abgerufen …
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)         // … die Cola liegt am Schankdrucker
    })

    await test.step('Backup-Drucker eingetragen → Nochmal senden: Hinweis, und der Schankdrucker druckt NICHT noch einmal', async () => {
      const vorher = schank.empfangen()
      await setzeBackup(ids.kuehlA)
      await page.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toHaveCount(0)                                     // angekommen …
      await expect(hinweis).toContainText(hinweisText(name.kuehlA, name.schank))   // … aber am Schankdrucker
      await druckeStabil(vorher + 1)                                       // nur der Salat; die Cola nicht ein zweites Mal
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Küchendrucker tot, Backup-Drucker erreichbar: nur der bernsteinfarbene Hinweis, keine rote Leiste', async () => {
      await oeffneTisch(umgeleitet)
      const vorher = schank.empfangen()
      await gangKnopf.click()
      await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
      await expect(rot).toHaveCount(0)
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Gegenprobe — erreichbarer Drucker: weder Leiste noch Hinweis', async () => {
      await oeffneTisch(ohneBefund)
      const vorher = schank.empfangen()
      await gangKnopf.click()
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await expect(gangKnopf).toHaveCount(0)                               // der Abruf ist durch …
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toHaveCount(0)
    })
  })

  // ===========================================================================================================
  // Kasse: Position nachschicken (↻)
  // ===========================================================================================================
  test('Kasse · Nachschicken (↻): Bon nicht angekommen → rote Leiste, Nochmal senden → Hinweis; Gegenprobe ohne Befund', async ({ page }) => {
    const tisch = tischName('N')
    const tab = await legeTabAn(tisch, [
      { a: artikel.salatB,   gang: 1, gesendet: true },
      { a: artikel.schnitzel, gang: 1, gesendet: true },
      { a: artikel.cola,     gang: 1, gesendet: true },
    ])
    await anmelden(page, login, kasseId, true)
    await page.goto(`/tische/${tab.id}`)
    await expect(page.getByRole('heading', { name: `Tisch ${tisch}` })).toBeVisible()
    const rot      = page.getByText(ROT_KASSE)
    const hinweis  = page.getByTestId('bonier-umleitung')
    const nachschicken = (a: Art) => page.locator('li').filter({ hasText: a.bezeichnung }).getByTitle('Nochmal an die Küche schicken')

    await test.step('Kühlraum B ist tot: rote Leiste', async () => {
      await nachschicken(artikel.salatB).click()
      await expect(rot).toBeVisible()
      await expect(page.getByText(name.kuehlB)).toBeVisible()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Backup-Drucker eingetragen → Nochmal senden: Hinweis statt Leiste', async () => {
      const vorher = schank.empfangen()
      await setzeBackup(ids.kuehlB)
      await page.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toContainText(hinweisText(name.kuehlB, name.schank))
      await druckeStabil(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Küchendrucker tot, Backup-Drucker erreichbar: Hinweis ohne Leiste', async () => {
      const vorher = schank.empfangen()
      await nachschicken(artikel.schnitzel).click()
      await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
      await expect(rot).toHaveCount(0)
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
    })

    await test.step('Gegenprobe — erreichbarer Drucker: nichts', async () => {
      const vorher = schank.empfangen()
      await nachschicken(artikel.cola).click()
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toHaveCount(0)
    })
  })

  // ===========================================================================================================
  // Kasse: Storno-Bon (Position korrigiert / Tisch verworfen)
  // ===========================================================================================================
  test('Kasse · Storno-Bon (Position korrigiert): Backup-Drucker → Hinweis; Bon nicht angekommen → rote Leiste; Gegenprobe erreichbarer Drucker', async ({ page }) => {
    const tisch = tischName('S')
    const tab = await legeTabAn(tisch, [{ a: artikel.schnitzel, menge: 2 }, { a: artikel.cola, menge: 2 }, { a: artikel.salatG, menge: 2 }])
    await anmelden(page, login, kasseId)
    await page.goto(`/tische/${tab.id}`)
    await expect(page.getByRole('heading', { name: `Tisch ${tisch}` })).toBeVisible()
    const hinweis = page.getByTestId('bonier-umleitung')
    const rot     = page.getByText('Korrekturbon für Tisch', { exact: false })
    const zeile   = (a: Art) => page.locator('li').filter({ hasText: a.bezeichnung })
    const minus   = (a: Art) => zeile(a).getByRole('button', { name: '−', exact: true })

    await test.step('Gegenprobe — Cola (erreichbarer Drucker): Storno ohne Meldung', async () => {
      const vorher = schank.empfangen()
      await minus(artikel.cola).click()
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)         // der Storno-Bon liegt am Schankdrucker
      await expect(zeile(artikel.cola).getByTitle('Menge eingeben')).toHaveText('1')   // die Korrektur ist gebucht (2 → 1)
      await expect(hinweis).toHaveCount(0)
      await expect(rot).toHaveCount(0)
    })

    await test.step('Schnitzel (Küchendrucker tot, Backup: Schank): der Storno-Bon liegt am Schankdrucker — der Hinweis sagt es', async () => {
      const vorher = schank.empfangen()
      await minus(artikel.schnitzel).click()
      await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
      await expect(rot).toHaveCount(0)                                      // angekommen ist angekommen
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Salat G (Kühlraum tot, kein Backup-Drucker): rote Leiste; nach dem Eintragen eines Backup-Druckers meldet Nochmal senden den Hinweis', async () => {
      await minus(artikel.salatG).click()
      await expect(page.getByText(`⚠ Korrekturbon für Tisch ${tisch} NICHT angekommen — bitte prüfen`)).toBeVisible()
      await expect(page.getByText(name.kuehlG)).toBeVisible()
      await expect(hinweis).toHaveCount(0)

      const vorher = schank.empfangen()
      await setzeBackup(ids.kuehlG)
      await page.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toContainText(hinweisText(name.kuehlG, name.schank))
      await druckeStabil(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })
  })

  test('Kasse · Tisch verwerfen, Storno-Bon am Backup-Drucker: der Hinweis geht in die Tischübersicht mit', async ({ page }) => {
    const verworfen = await legeTabAn(tischName('V'), [{ a: artikel.schnitzel }])
    const ohneBefund = await legeTabAn(tischName('W'), [{ a: artikel.cola }])
    await anmelden(page, login, kasseId)
    const hinweis = page.getByTestId('bonier-umleitung')
    const verwerfe = async (tab: { id: string }) => {
      await page.goto(`/tische/${tab.id}`)
      await expect(page.getByRole('heading', { name: /^Tisch / })).toBeVisible()
      page.once('dialog', d => void d.accept())
      await page.getByRole('button', { name: /Verwerfen/ }).click()
      // Erst die Tischübersicht abwarten — sonst träfe die Prüfung noch die Tischseite (lazy Route)
      await expect(page).toHaveURL(/\/tische$/)
      await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
    }

    await test.step('Schnitzel: Hinweis in der Tischübersicht, bis „Verstanden“', async () => {
      const vorher = schank.empfangen()
      await verwerfe(verworfen)
      await expect(hinweis).toHaveCount(1)
      await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Gegenprobe — Cola: Tischübersicht ohne Hinweis', async () => {
      const vorher = schank.empfangen()
      await verwerfe(ohneBefund)
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await expect(hinweis).toHaveCount(0)
      await expect(page.getByText(ROT_KASSE)).toHaveCount(0)
    })
  })

  // ===========================================================================================================
  // Kasse: Sofort-Kassieren — die rote Leiste überlebt den Seitenwechsel
  // ===========================================================================================================
  test('Kasse · Sofort-Kassieren: Bon nicht angekommen → die rote Leiste steht in der Tischübersicht; Nochmal senden → Hinweis', async ({ page }) => {
    const tisch = tischName('K')
    const tab = await legeTabAn(tisch)
    await anmelden(page, login, kasseId)
    await page.goto(`/tische/${tab.id}`)
    await expect(page.getByRole('heading', { name: `Tisch ${tisch}` })).toBeVisible()
    const rot     = page.getByText(ROT_KASSE)
    const hinweis = page.getByTestId('bonier-umleitung')
    const kachel  = (n: string) => page.getByTestId('artikel-kachel').filter({ hasText: n })
    const kassiere = async (a: Art) => {
      await kachel(a.bezeichnung).click()
      await page.getByRole('button', { name: /^Bar \(/ }).click()
      // Erst die Tischübersicht abwarten — sonst träfe die Prüfung noch die Tischseite (lazy Route)
      await expect(page).toHaveURL(/\/tische$/, { timeout: 30_000 })
      await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
    }

    await test.step('Kühlraum C ist tot: bezahlt, aber die Küche bekam nichts — die Leiste bleibt in der Tischübersicht stehen', async () => {
      await kassiere(artikel.salatC)
      await expect(rot).toBeVisible()
      await expect(page.getByText(name.kuehlC)).toBeVisible()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Backup-Drucker eingetragen → Nochmal senden in der Tischübersicht: Hinweis statt Leiste', async () => {
      const vorher = schank.empfangen()
      await setzeBackup(ids.kuehlC)
      await page.getByRole('button', { name: 'Nochmal senden' }).click()
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toContainText(hinweisText(name.kuehlC, name.schank))
      await druckeStabil(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Küchendrucker tot, Backup-Drucker erreichbar: der Hinweis steht in der Tischübersicht, keine rote Leiste', async () => {
      const tab3 = await legeTabAn(tischName('M'))
      await page.goto(`/tische/${tab3.id}`)
      await expect(page.getByRole('heading', { name: /^Tisch M/ })).toBeVisible()
      const vorher = schank.empfangen()
      await kassiere(artikel.schnitzel)
      await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
      await expect(rot).toHaveCount(0)
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      await expect(hinweis).toHaveCount(0)
    })

    await test.step('Gegenprobe — erreichbarer Drucker: Tischübersicht ohne Leiste und Hinweis', async () => {
      const tab2 = await legeTabAn(tischName('L'))
      await page.goto(`/tische/${tab2.id}`)
      await expect(page.getByRole('heading', { name: /^Tisch L/ })).toBeVisible()
      const vorher = schank.empfangen()
      await kassiere(artikel.cola)
      await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      await expect(rot).toHaveCount(0)
      await expect(hinweis).toHaveCount(0)
    })
  })

  test('Kasse · Parken schlägt fehl, dann „← Tische“: die rote Leiste geht mit', async ({ page }) => {
    const tisch = tischName('P')
    const tab = await legeTabAn(tisch)
    await anmelden(page, login, kasseId)
    await page.goto(`/tische/${tab.id}`)
    await expect(page.getByRole('heading', { name: `Tisch ${tisch}` })).toBeVisible()
    const rot = page.getByText(ROT_KASSE)

    await page.getByTestId('artikel-kachel').filter({ hasText: artikel.salatD.bezeichnung }).click()
    await page.getByRole('button', { name: 'Parken', exact: true }).click()
    await expect(rot).toBeVisible()
    await page.getByRole('button', { name: '← Tische' }).click()
    await expect(page).toHaveURL(/\/tische$/)
    await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
    await expect(rot).toHaveCount(1)                                         // die Leiste ist noch da …
    await expect(page.getByText(name.kuehlD)).toBeVisible()
    await page.getByRole('button', { name: 'Verstanden' }).click()           // … bis jemand „Verstanden“ drückt
    await expect(rot).toHaveCount(0)
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

  test('Kellner-App · Gang abrufen und Nachschicken: rote Meldung bzw. Hinweis; Nochmal senden druckt nichts doppelt', async ({ browser }) => {
    await gaengeModul(true)               // die App liest das Modul beim PIN-Login vom Server
    const teilweise  = await legeTabAn(tischName('KG'), [{ a: artikel.cola, gang: 1 }, { a: artikel.salatE, gang: 1 }])
    const umgeleitet = await legeTabAn(tischName('KH'), [{ a: artikel.schnitzel, gang: 1 }])
    const nachtisch  = await legeTabAn(tischName('KN'), [{ a: artikel.salatF, gang: 1, gesendet: true }])
    const { kontext, kellner } = await kellnerOeffnen(browser)
    try {
      const hinweis  = kellner.getByTestId('bonier-umleitung')
      const gesendet = kellner.getByText('✓ Bon wurde gesendet')
      const rot      = kellner.getByText('⚠ Bon NICHT angekommen')
      const gangKnopf = kellner.getByRole('button', { name: /1\. Gang abrufen/ })

      await test.step('Gang abrufen, ein Ziel tot: rote Meldung statt der grünen Bestätigung', async () => {
        const vorher = schank.empfangen()
        await kellner.goto(`${KELLNER_URL}/tab/${teilweise.id}`)
        await gangKnopf.click()
        await expect(rot).toBeVisible()
        await expect(kellner.getByText(name.kuehlE)).toBeVisible()
        await expect(gesendet).toHaveCount(0)
        await expect(hinweis).toHaveCount(0)
        await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
      })

      await test.step('Backup-Drucker eingetragen → Nochmal senden: Hinweis; der Schankdrucker druckt NICHT noch einmal', async () => {
        const vorher = schank.empfangen()
        await setzeBackup(ids.kuehlE)
        await kellner.getByRole('button', { name: 'Nochmal senden' }).click()
        await expect(rot).toHaveCount(0)
        await expect(hinweis).toContainText(hinweisText(name.kuehlE, name.schank))
        await druckeStabil(vorher + 1)
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
        await expect(hinweis).toHaveCount(0)
      })

      await test.step('Gang abrufen, Backup-Drucker springt ein: grüne Bestätigung UND Hinweis, keine rote Meldung', async () => {
        await kellner.goto(`${KELLNER_URL}/tab/${umgeleitet.id}`)
        await gangKnopf.click()
        await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
        await expect(gesendet).toBeVisible()
        await expect(rot).toHaveCount(0)
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      })

      await test.step('↻ nochmal schicken, Ziel tot: rote Meldung; Nochmal senden nach Backup-Drucker → Hinweis', async () => {
        await kellner.goto(`${KELLNER_URL}/tab/${nachtisch.id}`)
        await kellner.getByRole('button', { name: '↻ nochmal schicken' }).click()
        await expect(rot).toBeVisible()
        await expect(kellner.getByText(name.kuehlF)).toBeVisible()
        await setzeBackup(ids.kuehlF)
        await kellner.getByRole('button', { name: 'Nochmal senden' }).click()
        await expect(rot).toHaveCount(0)
        await expect(hinweis).toContainText(hinweisText(name.kuehlF, name.schank))
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
      })
    } finally {
      await kontext.close()
      await gaengeModul(false)
    }
  })

  test('Kellner-App · Position entfernen: Storno-Bon am Backup-Drucker → Hinweis; nicht angekommen → rote Meldung (auch auf dem leeren Tisch)', async ({ browser }) => {
    const tab = await legeTabAn(tischName('KS'), [{ a: artikel.cola }, { a: artikel.schnitzel }, { a: artikel.salatH }])
    const { kontext, kellner } = await kellnerOeffnen(browser)
    try {
      const hinweis = kellner.getByTestId('bonier-umleitung')
      const rot     = kellner.getByText('⚠ Bon NICHT angekommen')
      const zeile = (a: Art) => kellner.locator('div.rounded-2xl').filter({ hasText: a.bezeichnung })
      await kellner.goto(`${KELLNER_URL}/tab/${tab.id}`)
      await expect(zeile(artikel.cola)).toBeVisible()

      await test.step('Gegenprobe — Cola entfernen: kein Hinweis', async () => {
        const vorher = schank.empfangen()
        await zeile(artikel.cola).getByRole('button', { name: '−1' }).click()
        await expect(zeile(artikel.cola)).toHaveCount(0)
        await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
        await expect(hinweis).toHaveCount(0)
        await expect(rot).toHaveCount(0)
      })

      await test.step('Schnitzel entfernen: der Storno-Bon liegt am Schankdrucker — der Kellner erfährt es', async () => {
        const vorher = schank.empfangen()
        await zeile(artikel.schnitzel).getByRole('button', { name: '−1' }).click()
        await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
        await expect(rot).toHaveCount(0)
        await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
        await expect(hinweis).toHaveCount(0)
      })

      await test.step('Salat H entfernen (die LETZTE Position, Kühlraum tot): rote Meldung auf dem leeren Tisch; nach dem Backup-Drucker meldet Nochmal senden den Hinweis', async () => {
        await zeile(artikel.salatH).getByRole('button', { name: '−1' }).click()
        // Der Tisch ist jetzt leer: die Fußleiste mit den Meldungen entfällt — die Meldung muss trotzdem da sein
        await expect(kellner.getByText('Noch keine Artikel')).toBeVisible()
        await expect(rot).toBeVisible()
        await expect(kellner.getByText(name.kuehlH)).toBeVisible()

        const vorher = schank.empfangen()
        await setzeBackup(ids.kuehlH)
        await kellner.getByRole('button', { name: 'Nochmal senden' }).click()
        await expect(rot).toHaveCount(0)
        await expect(hinweis).toContainText(hinweisText(name.kuehlH, name.schank))
        await druckeStabil(vorher + 1)
        await expect(kellner.getByText('Noch keine Artikel')).toBeVisible()
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
        await expect(hinweis).toHaveCount(0)
      })
    } finally {
      await kontext.close()
    }
  })

  test('Kellner-App · Tisch verwerfen: Storno-Bon am Backup-Drucker → Blatt mit Hinweis bis „Verstanden“; Gegenprobe', async ({ browser }) => {
    const mitHinweis = await legeTabAn(tischName('KV'), [{ a: artikel.schnitzel }])
    const ohneHinweis = await legeTabAn(tischName('KW'), [{ a: artikel.cola }])
    const { kontext, kellner } = await kellnerOeffnen(browser)
    try {
      const hinweis = kellner.getByTestId('bonier-umleitung')
      const verwerfe = async (tab: { id: string }) => {
        await kellner.goto(`${KELLNER_URL}/tab/${tab.id}`)
        await kellner.getByRole('button', { name: 'Tisch-Aktionen' }).click()
        await kellner.getByRole('button', { name: /Tisch verwerfen/ }).first().click()
        await kellner.getByRole('button', { name: '🗑 Tisch verwerfen' }).click()
      }

      await test.step('Schnitzel: das Blatt bleibt mit dem Hinweis stehen — „Verstanden“ führt zur Übersicht', async () => {
        const vorher = schank.empfangen()
        await verwerfe(mitHinweis)
        await expect(hinweis).toContainText(hinweisText(name.kueche, name.schank))
        await expect(kellner.getByText('Storno-Bon an anderem Drucker')).toBeVisible()
        await expect(kellner.getByText('⚠ Der Tisch ist verworfen')).toHaveCount(0)    // nichts nachzusenden
        await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
        await hinweis.getByRole('button', { name: 'Verstanden' }).click()
        await expect(kellner.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 10_000 })
      })

      await test.step('Gegenprobe — Cola: direkt zurück zur Übersicht, ohne Blatt', async () => {
        const vorher = schank.empfangen()
        await verwerfe(ohneHinweis)
        await expect(kellner.getByRole('heading', { name: 'Tische' })).toBeVisible({ timeout: 10_000 })
        await expect.poll(() => schank.empfangen()).toBe(vorher + 1)
        await expect(hinweis).toHaveCount(0)
      })
    } finally {
      await kontext.close()
    }
  })
})
