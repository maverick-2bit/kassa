import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

/**
 * Klassen des Aufrufers gewinnen gegen die Vorgaben von Button (Größe, Variante).
 * Button hängte `className` an seine eigenen Utility-Klassen an — bei zwei
 * Utilities für dieselbe Eigenschaft entscheidet Tailwind 4 über die Reihenfolge
 * im erzeugten CSS, nicht im class-Attribut: „Reaktivieren" im Kunden-Profil blieb
 * seit den Dark-Mode-Tokens grau (text-green-700 stand vor text-ink), das Polster
 * von „+" im Tischplan und von „→ In Lieferschein übernehmen" blieb das der Größe
 * md. Jetzt liegen die Vorgaben als `.btn*` in der components-Ebene, jede Utility
 * des Aufrufers gewinnt.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet
 * adminLogin() die Instanz notfalls selbst ein.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ viewport: { width: 1280, height: 800 } })

type Login = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }

// Einmal je Datei anmelden: /api/auth/login ist je IP auf 10/min begrenzt,
// und die ganze Suite teilt sich 127.0.0.1 (Muster ensureAuth in onboarding).
let gemerkterLogin: Login | null = null

async function adminLogin(request: APIRequestContext): Promise<Login> {
  gemerkterLogin ??= await neuerAdminLogin(request)
  return gemerkterLogin
}

async function neuerAdminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Knopfklassen GmbH',
        uid:        'ATU87654331',
        kassenId:   'E2E-KNOPFKLASSEN-001',
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

async function anmelden(page: Page, login: Login) {
  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token:     login.token,
    // Tischplan (Gastro) und Angebote sind Module — nur die Oberfläche fragt sie ab
    authJson:  JSON.stringify({
      user: login.user,
      mandant: { ...login.mandant, modulGastroAktiv: true, modulAngeboteAktiv: true },
      kassen: login.kassen,
    }),
    mandantId: login.mandant.id,
    kasseId:   login.kassen[0]!.id,
  })
}

type Eigenschaft = 'color' | 'backgroundColor' | 'borderTopColor' | 'fontSize' | 'paddingTop' | 'paddingLeft'

async function stil(el: Locator, eigenschaft: Eigenschaft) {
  return el.evaluate((e, p) => getComputedStyle(e)[p], eigenschaft)
}

/** Farbe eines Theme-Tokens so, wie der Browser sie berechnet (gleiche Schreibweise wie am Knopf). */
async function farbe(page: Page, token: string) {
  return page.evaluate((t) => {
    const el = document.createElement('div')
    el.style.color = `var(--color-${t})`
    document.body.append(el)
    const wert = getComputedStyle(el).color
    el.remove()
    return wert
  }, token)
}

test.describe('Button: Klassen des Aufrufers gewinnen', () => {
  let authHeader: Record<string, string> = {}
  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const marke = `Knopf ${Date.now()}`
  let aktivId = ''
  let angebotNr = ''

  test.beforeAll(async ({ request }) => {
    await expect.poll(
      async () => (await request.get('/api/health')).status(),
      { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
    ).toBe(200)
    const login = await adminLogin(request)
    authHeader = { Authorization: `Bearer ${login.token}` }

    const aktiv = await request.post('/api/kunden', { headers: authHeader, data: { nachname: `${marke} Aktiv` } })
    expect(aktiv.ok(), await aktiv.text()).toBe(true)
    aktivId = ((await aktiv.json()) as { id: string }).id
    const inaktiv = await request.post('/api/kunden', { headers: authHeader, data: { nachname: `${marke} Inaktiv` } })
    expect(inaktiv.ok(), await inaktiv.text()).toBe(true)
    const inaktivId = ((await inaktiv.json()) as { id: string }).id
    const weg = await request.delete(`/api/kunden/${inaktivId}`, { headers: authHeader })
    expect(weg.ok(), await weg.text()).toBe(true)

    const angebot = await request.post('/api/angebote', {
      headers: authHeader,
      data: {
        kasseId: login.kassen[0]!.id,
        positionen: [{ bezeichnung: marke, menge: 1, einzelpreisBreutto: 1000, mwstSatz: 'normal' }],
      },
    })
    expect(angebot.ok(), await angebot.text()).toBe(true)
    angebotNr = `A-${String(((await angebot.json()) as { nummer: number }).nummer).padStart(4, '0')}`
  })

  test.afterAll(async ({ request }) => {
    if (aktivId) await request.delete(`/api/kunden/${aktivId}`, { headers: authHeader })
  })

  test.beforeEach(async ({ page, request }) => {
    await anmelden(page, await adminLogin(request))
  })

  test('Kunden-Profil: „Reaktivieren" grün samt Hover, „Deaktivieren" rot', async ({ page }) => {
    await page.goto('/kunden')
    await page.getByPlaceholder('Suchen (Name, Firma, E-Mail, Nummer…)').fill(marke)
    await page.getByRole('checkbox', { name: 'Nur aktive' }).uncheck()

    await page.getByRole('row', { name: `${marke} Inaktiv` }).getByRole('button', { name: 'Profil →' }).click()
    const reaktivieren = page.getByRole('dialog').getByRole('button', { name: 'Reaktivieren' })
    await expect(reaktivieren).toBeVisible()
    expect(await stil(reaktivieren, 'color')).toBe(await farbe(page, 'green-700'))          // vorher text-ink
    expect(await stil(reaktivieren, 'borderTopColor')).toBe(await farbe(page, 'green-200')) // vorher line-strong
    const gruenHover = await farbe(page, 'green-50')
    await reaktivieren.hover()
    await expect.poll(() => stil(reaktivieren, 'backgroundColor')).toBe(gruenHover)          // vorher panel-2

    await page.goto('/kunden')
    await page.getByPlaceholder('Suchen (Name, Firma, E-Mail, Nummer…)').fill(marke)
    await page.getByRole('row', { name: `${marke} Aktiv` }).getByRole('button', { name: 'Profil →' }).click()
    const deaktivieren = page.getByRole('dialog').getByRole('button', { name: 'Deaktivieren' })
    await expect(deaktivieren).toBeVisible()
    expect(await stil(deaktivieren, 'color')).toBe(await farbe(page, 'red-600'))
  })

  test('Tischplan: „+" neben „Neuer Bereich …" so hoch wie das Feld, Polster der Größe sm', async ({ page }) => {
    await page.goto('/einstellungen?bereich=gastro')
    const feld = page.getByPlaceholder('Neuer Bereich …')
    await expect(feld).toBeVisible()
    const plus = feld.locator('xpath=following-sibling::button[1]')
    await expect(plus).toHaveText('+')
    const f = (await feld.boundingBox())!
    const p = (await plus.boundingBox())!
    expect(Math.round(p.height)).toBe(Math.round(f.height))   // h-8 = 32 px
    expect(await stil(plus, 'paddingLeft')).toBe('12px')      // vorher 16 px (md)
    expect(await stil(plus, 'fontSize')).toBe('12px')
    expect(Math.round(p.width)).toBeLessThanOrEqual(33)       // vorher 40 px breit
  })

  test('Angebot: „→ In Lieferschein übernehmen" in der Größe sm', async ({ page }) => {
    await page.goto('/angebote')
    await page.locator('tr', { hasText: angebotNr }).click()
    const knopf = page.getByRole('button', { name: '→ In Lieferschein übernehmen' })
    await expect(knopf).toBeVisible()
    expect(await stil(knopf, 'fontSize')).toBe('12px')
    expect(await stil(knopf, 'paddingTop')).toBe('6px')       // vorher 10 px trotz py-1
    expect(await stil(knopf, 'paddingLeft')).toBe('12px')     // vorher 16 px trotz px-2
  })

  test('Kasse: Bar/Karte 14 px mit py-3, „Angebot erstellen" in Markenblau', async ({ page }) => {
    await page.goto('/kasse')
    const bar = page.getByRole('button', { name: /^Bar \(/ })
    await expect(bar).toBeVisible()
    for (const knopf of [bar, page.getByRole('button', { name: /^Karte \(/ })]) {
      expect(await stil(knopf, 'fontSize')).toBe('14px')      // bewusst ohne text-base (User-Entscheidung)
      expect(await stil(knopf, 'paddingTop')).toBe('12px')    // py-3 des Aufrufers gegen py-2.5 der Größe md
    }

    await page.getByRole('button', { name: 'Angebot', exact: true }).click()
    const erstellen = page.getByRole('button', { name: 'Angebot erstellen' })
    await expect(erstellen).toBeVisible()
    expect(await stil(erstellen, 'backgroundColor')).toBe(await farbe(page, 'brand-500'))
  })
})
