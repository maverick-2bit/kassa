import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ALLERGEN_CODES } from '@kassa/shared'
import { AllergenAuswahl } from './AllergenAuswahl'

const nichts = () => {}

const html = (wert: string) => renderToStaticMarkup(<AllergenAuswahl wert={wert} onChange={nichts} />)
const knopf = (h: string, code: string) => h.match(new RegExp(`<button[^>]*data-testid="allergen-${code}"[^>]*>`))![0]

describe('AllergenAuswahl', () => {
  it('zeigt alle 14 Allergene zum Antippen', () => {
    const h = html('')
    expect(ALLERGEN_CODES).toHaveLength(14)
    for (const code of ALLERGEN_CODES) expect(h).toContain(`data-testid="allergen-${code}"`)
  })

  it('ohne Angabe ist keines gewählt', () => {
    const h = html('')
    for (const code of ALLERGEN_CODES) expect(knopf(h, code)).toContain('aria-pressed="false"')
  })

  it('gewählt sind genau die gespeicherten Codes — auch bei lockerer Schreibweise', () => {
    for (const wert of ['A,C,G', 'a, c g']) {
      const h = html(wert)
      for (const code of ['A', 'C', 'G']) expect(knopf(h, code)).toContain('aria-pressed="true"')
      for (const code of ['B', 'D', 'H', 'R']) expect(knopf(h, code)).toContain('aria-pressed="false"')
    }
  })

  it('ein ungültiger Altwert lässt die Auswahl leer, statt abzustürzen', () => {
    const h = html('X, A')
    for (const code of ALLERGEN_CODES) expect(knopf(h, code)).toContain('aria-pressed="false"')
  })

  it('jeder Knopf nennt Code und Namen im Tooltip', () => {
    expect(knopf(html(''), 'G')).toContain('title="G = Milch/Laktose"')
  })
})
