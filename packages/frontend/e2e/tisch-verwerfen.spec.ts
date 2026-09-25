import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Tisch verwerfen, während der Bonierdrucker ausgefallen ist: Der Korrekturbon
 * kommt nicht an — ohne Meldung bereitet die Station den ganzen Tisch weiter zu.
 * Die Kasse springt nach dem Verwerfen in die Tischübersicht (den Tisch gibt es
 * nicht mehr) und nimmt die rote Leiste samt „Nochmal senden" dorthin mit.
 *
 * Läuft nach onboarding.spec.ts (eingerichtete Instanz); für Solo-Läufe richtet
 * adminLogin() die Instanz notfalls selbst ein. Der „tote Drucker" ist ein
 * geschlossener Port auf 127.0.0.1 — das gibt sofort ECONNREFUSED.
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

async function adminLogin(request: APIRequestContext) {
  let res = await request.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
  })
  if (!res.ok()) {
    // Solo-Lauf gegen frische DB: Instanz per API einrichten (FO_STUB=true)
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Verwerfen GmbH',
        uid:        'ATU87654329',
        kassenId:   'E2E-VERWERFEN-001',
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

test('Verwerfen bei totem Bonierdrucker: Leiste „Korrekturbon NICHT angekommen" in der Tischübersicht', async ({ page, request }) => {
  // Warmup: erste Verbindung Preview-Proxy → Backend absichern (Muster onboarding)
  await expect.poll(
    async () => (await request.get('/api/health')).status(),
    { timeout: 35_000, intervals: [500, 1000, 2000, 3000] },
  ).toBe(200)

  const login      = await adminLogin(request)
  const authHeader = { Authorization: `Bearer ${login.token}` }
  const kasseId    = login.kassen[0]!.id

  // Eindeutig je Versuch — Datei-Retries teilen sich die Instanz
  const ts    = Date.now()
  const tisch = `V${ts % 100000}`

  const drucker = await (await request.post('/api/bonierdrucker', {
    headers: authHeader, data: { name: `Küche tot ${ts}`, ip: '127.0.0.1', port: 9 },
  })).json() as { id: string; name: string }
  const artikel = await (await request.post('/api/artikel', {
    headers: authHeader,
    data: { bezeichnung: `Verwerf-Schnitzel ${ts}`, preisBruttoCent: 1450, mwstSatz: 'ermaessigt1', bonierdruckerId: drucker.id },
  })).json() as { id: string; bezeichnung: string }
  const tab = await (await request.post('/api/tisch-tabs', {
    headers: authHeader, data: { kasseId, tischNummer: tisch, kellner: 'E2E Service' },
  })).json() as { id: string }

  try {
    // Positionen buchen bonieren nicht — erst der Storno schickt einen Bon
    const put = await request.put(`/api/tisch-tabs/${tab.id}/positionen`, {
      headers: authHeader,
      data: { positionen: [{ artikelId: artikel.id, bezeichnung: artikel.bezeichnung, preisBruttoCent: 1450, menge: 2 }] },
    })
    expect(put.ok()).toBe(true)

    await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
      localStorage.setItem('kassa:token', d.token)
      localStorage.setItem('kassa:auth', d.authJson)
      localStorage.setItem('kassa:mandantId', d.mandantId)
      localStorage.setItem('kassa:kasseId', d.kasseId)
    }, {
      token:     login.token,
      authJson:  JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
      mandantId: login.mandant.id,
      kasseId,
    })

    await page.goto(`/tische/${tab.id}`)
    await expect(page.getByRole('heading', { name: `Tisch ${tisch}` })).toBeVisible()

    // Sicherheitsabfrage „komplett verwerfen?" bestätigen
    page.once('dialog', (d) => { void d.accept() })
    await page.getByRole('button', { name: /Verwerfen$/ }).click()

    // Tischübersicht: der Tisch ist weg, die Leiste ist mitgekommen
    await expect(page).toHaveURL(/\/tische$/)
    const titel = page.getByText(`⚠ Korrekturbon für Tisch ${tisch} NICHT angekommen — bitte prüfen`)
    await expect(titel).toBeVisible()
    await expect(page.getByText(drucker.name, { exact: true })).toBeVisible()
    await expect(page.getByText(tisch, { exact: true })).toHaveCount(0)

    // Nochmal senden: derselbe Storno-Bon — Kasse, Tisch, Positionen, kein Tab
    const anfrage = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/bestellung/bonieren'))
    const antwort = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/bestellung/bonieren'))
    await page.getByRole('button', { name: 'Nochmal senden' }).click()
    expect((await anfrage).postDataJSON()).toEqual({
      kasseId,
      tisch,
      kellner:        'E2E Service',
      positionen:     [{ artikelId: artikel.id, menge: 2 }],
      ohneLagerabzug: true,
      storno:         true,
    })
    // Drucker weiterhin tot (207) → die Leiste bleibt stehen
    expect((await antwort).status()).toBe(207)
    await expect(page.getByRole('button', { name: 'Nochmal senden' })).toBeEnabled()
    await expect(titel).toBeVisible()

    // Weggeklickt bleibt weg — auch nach dem Neuladen
    await page.getByRole('button', { name: 'Verstanden' }).click()
    await expect(titel).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Tische', exact: true })).toBeVisible()
    await expect(titel).toHaveCount(0)
  } finally {
    // Aufräumen — spätere Specs teilen sich die Instanz. Verwerfen ist nach
    // einem Erfolg schon passiert (dann 409), sonst schließt es den Tisch.
    await request.post(`/api/tisch-tabs/${tab.id}/verwerfen`, { headers: authHeader, data: {} })
    await request.delete(`/api/artikel/${artikel.id}`, { headers: authHeader })
    await request.delete(`/api/bonierdrucker/${drucker.id}`, { headers: authHeader })
  }
})
