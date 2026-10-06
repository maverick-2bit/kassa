import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SichtbarkeitsKnoepfe } from './SichtbarkeitsKnoepfe'
import { SichtbarkeitsHaken } from './SichtbarkeitsHaken'
import { TeilbaumKnopf } from './TeilbaumKnopf'

const nichts = () => {}

/** Die zwei Knöpfe als HTML; je Knopf die Attribute auslesen (React setzt sie in fester Reihenfolge — wir suchen gezielt). */
function knoepfe(props: Partial<Parameters<typeof SichtbarkeitsKnoepfe>[0]> = {}) {
  const html = renderToStaticMarkup(
    <SichtbarkeitsKnoepfe art="alle" onAlleSichtbar={nichts} onAlleAusblenden={nichts} testId="t" {...props} />,
  )
  const knopf = (testId: string) => html.match(new RegExp(`<button[^>]*data-testid="t-${testId}"[^>]*>[^<]*</button>`))![0]
  return { html, sichtbar: knopf('alle-sichtbar'), ausblenden: knopf('alle-ausblenden') }
}

describe('SichtbarkeitsKnoepfe: „Alle sichtbar" und „Alle ausblenden"', () => {
  it('zwei klar beschriftete Knöpfe mit Test-IDs', () => {
    const { sichtbar, ausblenden } = knoepfe()
    expect(sichtbar).toContain('>Alle sichtbar</button>')
    expect(ausblenden).toContain('>Alle ausblenden</button>')
  })

  it('bei „alle sichtbar" ist der erste Knopf gedrückt; sein Tooltip erklärt den zweiten Klick', () => {
    const { sichtbar, ausblenden } = knoepfe({ art: 'alle' })
    expect(sichtbar).toContain('aria-pressed="true"')
    expect(ausblenden).toContain('aria-pressed="false"')
    expect(sichtbar).toContain('Ein weiterer Klick blendet alle aus')
    expect(ausblenden).toContain('Bis dahin wird nichts gespeichert')
  })

  it('im Neustart („alle ausgeblendet") ist der zweite Knopf gedrückt; die Tooltips erklären den Weg zurück', () => {
    const { sichtbar, ausblenden } = knoepfe({ art: 'keine' })
    expect(sichtbar).toContain('aria-pressed="false"')
    expect(ausblenden).toContain('aria-pressed="true"')
    expect(sichtbar).toContain('Zurück zu')
    expect(ausblenden).toContain('Neustart abbrechen')
  })

  it('bei „N von M" ist keiner gedrückt', () => {
    const { sichtbar, ausblenden } = knoepfe({ art: 'teilweise' })
    expect(sichtbar).toContain('aria-pressed="false"')
    expect(ausblenden).toContain('aria-pressed="false"')
  })

  it('gesperrt (Serverstand noch nicht geladen): beide Knöpfe disabled', () => {
    const { sichtbar, ausblenden } = knoepfe({ disabled: true })
    expect(sichtbar).toContain('disabled=""')
    expect(ausblenden).toContain('disabled=""')
    expect(knoepfe().sichtbar).not.toContain('disabled=""')
  })

  it('mit Kassenname (Matrix): zugängliche Namen nennen die Kasse', () => {
    const { sichtbar, ausblenden } = knoepfe({ kassenName: 'Bar' })
    expect(sichtbar).toContain('aria-label="Alle sichtbar an Bar"')
    expect(ausblenden).toContain('aria-label="Alle ausblenden an Bar"')
    expect(knoepfe().sichtbar).not.toContain('aria-label')
  })

  it('kompakt (Spaltenkopf der Matrix): untereinander; sonst nebeneinander', () => {
    expect(knoepfe({ kompakt: true }).html).toContain('flex-col')
    expect(knoepfe().html).not.toContain('flex-col')
  })
})

describe('SichtbarkeitsHaken und TeilbaumKnopf', () => {
  const haken = (zustand: 'an' | 'zugang' | 'aus') =>
    renderToStaticMarkup(<SichtbarkeitsHaken zustand={zustand} onChange={nichts} label="Alkoholfrei an Bar" title="tip" />)

  it('der Haken ist nur bei „an" angehakt; der Zustand steht als data-zustand im DOM (Zugang = Halbhaken per Skript)', () => {
    expect(haken('an')).toContain('checked=""')
    expect(haken('an')).toContain('data-zustand="an"')
    expect(haken('zugang')).not.toContain('checked=""')
    expect(haken('zugang')).toContain('data-zustand="zugang"')
    expect(haken('aus')).not.toContain('checked=""')
    expect(haken('aus')).toContain('data-zustand="aus"')
    expect(haken('an')).toContain('aria-label="Alkoholfrei an Bar"')
  })

  it('der Knopf „samt Untergruppen" erklärt per Tooltip, dass ein einzelner Haken nur die Gruppe selbst schaltet', () => {
    const html = renderToStaticMarkup(<TeilbaumKnopf onClick={nichts} label="Atriumbar samt Untergruppen an Bar ein- oder ausschalten" />)
    expect(html).toContain('data-testid="teilbaum-knopf"')
    expect(html).toContain('aria-label="Atriumbar samt Untergruppen an Bar ein- oder ausschalten"')
    expect(html).toContain('samt allen Untergruppen')
    expect(html).toContain('Ein einzelner Haken gilt nur für die Gruppe selbst')
    expect(renderToStaticMarkup(<TeilbaumKnopf onClick={nichts} label="x" disabled />)).toContain('disabled=""')
  })
})
