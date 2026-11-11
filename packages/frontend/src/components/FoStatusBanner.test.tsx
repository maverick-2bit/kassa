/**
 * FoStatusBanner: Die Registrierung bei FinanzOnline trägt Zugangsdaten des Betriebs ein — der Server verlangt dafür das Recht
 * „Einstellungen" (Prüfbericht 2026-11, Befund 3). Wer es nicht hat, sieht den Hinweis statt eines Knopfs, der nur mit
 * „Keine Berechtigung" enden würde. (Banner und Abfrage laufen im E2E; hier die reine Darstellung der Aktion.)
 */

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FoNachtragenAktion } from './FoStatusBanner'

const html = (props: Partial<Parameters<typeof FoNachtragenAktion>[0]> = {}) =>
  renderToStaticMarkup(<FoNachtragenAktion darfRegistrieren offen={false} onUmschalten={() => {}} {...props} />)

describe('FoNachtragenAktion', () => {
  it('mit dem Recht „Einstellungen": Knopf „Jetzt nachtragen"', () => {
    const h = html()
    expect(h).toContain('>Jetzt nachtragen</button>')
    expect(h).not.toContain('fo-banner-hinweis')
  })

  it('geöffnet heißt der Knopf „Schließen"', () => {
    expect(html({ offen: true })).toContain('>Schließen</button>')
  })

  it('ohne das Recht: kein Knopf, stattdessen der Hinweis an die Chefin/den Chef', () => {
    const h = html({ darfRegistrieren: false })
    expect(h).not.toContain('<button')
    expect(h).toContain('data-testid="fo-banner-hinweis"')
    expect(h).toContain('Chefin oder dem Chef')
  })
})
