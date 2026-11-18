import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Signaturkarte (a.sign RK CHIP) in den Einstellungen — gegen die simulierte Karte des E2E-Backends
 * (KARTE_SIMULATOR, PIN 123456): Karte prüfen ohne PIN, falsche PIN (ein Fehlversuch, nichts gespeichert),
 * richtige PIN, danach signiert die Kasse mit der Karte (_R1-AT1_). Läuft bewusst als LETZTER Spec (zzzz-): Die
 * Kasse bleibt danach auf der Karte (ein Zurück auf die Software-SEE übernimmt deren Zertifikat nicht wieder).
 */

const ADMIN_EMAIL    = 'e2e-onboarding@test.at'
const ADMIN_PASSWORT = 'e2e-passwort-12345'

test.use({ viewport: { width: 1280, height: 900 } })

type Login = { token: string; user: unknown; mandant: { id: string }; kassen: { id: string }[] }

async function adminLogin(request: APIRequestContext): Promise<Login> {
  let res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
  if (!res.ok()) {
    const setup = await request.post('/api/setup', {
      data: {
        firmenname: 'E2E Signaturkarte GmbH', uid: 'ATU87654334', kassenId: 'E2E-SK-001', umgebung: 'test',
        finanzOnline: { teilnehmerId: 'TID-E2E', benutzerkennung: 'BID-E2E', pin: 'PIN-E2E' },
        admin: { name: 'E2E Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (!setup.ok()) throw new Error(`Setup fehlgeschlagen (${setup.status()}): ${await setup.text()}`)
    res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })
    if (!res.ok()) throw new Error(`Login nach Setup fehlgeschlagen (${res.status()})`)
  }
  return res.json() as Promise<Login>
}

test('Signaturkarte: prüfen ohne PIN, falsche PIN abgewiesen, richtige PIN — Kasse signiert mit AT1', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('/api/health')).status(), { timeout: 35_000, intervals: [500, 1000, 2000] }).toBe(200)
  const login   = await adminLogin(request)
  const kasseId = login.kassen[0]!.id
  const auth    = { Authorization: `Bearer ${login.token}` }

  await page.addInitScript((d: { token: string; authJson: string; mandantId: string; kasseId: string }) => {
    localStorage.setItem('kassa:token', d.token)
    localStorage.setItem('kassa:auth', d.authJson)
    localStorage.setItem('kassa:mandantId', d.mandantId)
    localStorage.setItem('kassa:kasseId', d.kasseId)
  }, {
    token: login.token, kasseId, mandantId: login.mandant.id,
    authJson: JSON.stringify({ user: login.user, mandant: login.mandant, kassen: login.kassen }),
  })

  {
    await page.goto('/einstellungen?bereich=rksv')
    const sektion = page.locator('section', { has: page.getByRole('heading', { name: 'Signaturerstellungseinheit (SEE)' }) })
    await expect(sektion).toBeVisible()

    await sektion.getByRole('button', { name: 'Signaturkarte (lokal)' }).click()
    await expect(sektion.getByTestId('see-signaturkarte')).toBeVisible()

    // Karte prüfen — ohne PIN
    await sektion.getByRole('button', { name: 'Karte prüfen (ohne PIN)' }).click()
    await expect(sektion.getByText(/Karte erkannt — A-Trust ACOS-ID 4\.1/)).toBeVisible({ timeout: 10_000 })

    // falsche PIN: abgewiesen, Restversuche genannt, Kasse bleibt bei der bisherigen Einheit
    await sektion.getByTestId('see-karte-pin').fill('111111')
    await sektion.getByRole('button', { name: 'Speichern' }).click()
    await expect(sektion.getByText(/noch 2 Versuche/)).toBeVisible({ timeout: 10_000 })
    await expect(sektion.getByTestId('see-karte-pin')).toHaveValue('')
    const vorher = await (await request.get(`/api/kassen/${kasseId}/see`, { headers: auth })).json() as { seeTyp: string }
    expect(vorher.seeTyp).not.toBe('atrust_chip')

    // richtige PIN
    await sektion.getByTestId('see-karte-pin').fill('123456')
    await sektion.getByRole('button', { name: 'Speichern' }).click()
    await expect(sektion.getByText(/signiert jetzt mit der Signaturkarte/)).toBeVisible({ timeout: 10_000 })
    await expect(sektion.getByText(/Aktuell:\s*Signaturkarte/)).toBeVisible()
    await sektion.screenshot({ path: test.info().outputPath('signaturkarte-einstellungen.png') })

    // ein Verkauf wird mit der Karte signiert
    const beleg = await request.post('/api/belege/barzahlung', {
      headers: auth,
      data: {
        kasseId,
        positionen: [{ bezeichnung: 'Kartentest', preisBruttoCent: 250, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: 250, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(beleg.status()).toBe(201)
    expect(((await beleg.json()) as { maschinenlesbareCode: string }).maschinenlesbareCode).toMatch(/^_R1-AT1_/)
  }
})
