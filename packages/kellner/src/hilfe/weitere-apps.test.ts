import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { HilfeThema } from '@kassa/shared'
import * as kds from '../../../kds/src/hilfe/texte'
import * as einlass from '../../../einlass/src/hilfe/texte'

/**
 * KDS und Einlass haben keine eigene Testumgebung; ihre Hilfetexte prüft dieser Test mit.
 * `aktuell` = Kennungen, die die App dem Hilfe-Knopf mitgibt (müssen ein Thema treffen).
 */
const APPS: { name: string; themen: HilfeThema[]; start: string; aktuell: string[]; app: string[] }[] = [
  {
    name: 'KDS', themen: kds.HILFE_THEMEN, start: kds.HILFE_START,
    aktuell: [kds.HILFE_EINRICHTUNG, kds.HILFE_BONS], app: ['../../../kds/src/App.tsx'],
  },
  {
    name: 'Einlass', themen: einlass.HILFE_THEMEN, start: einlass.HILFE_START,
    aktuell: [einlass.HILFE_EINRICHTUNG, einlass.HILFE_EVENT, einlass.HILFE_SCANNER],
    app: ['../../../einlass/src/App.tsx', '../../../einlass/src/Scanner.tsx'],
  },
]

describe.each(APPS)('Hilfetexte $name', ({ themen, start, aktuell, app }) => {
  it('Kennungen eindeutig; jedes Thema hat Titel, Zweck und Schritte; Startthema vorhanden', () => {
    const ids = themen.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of themen) {
      expect(t.titel.trim(), t.id).not.toBe('')
      expect(t.zweck.trim(), t.id).not.toBe('')
      expect(t.schritte.length, `${t.id}: ohne Schritte`).toBeGreaterThan(0)
    }
    expect(ids).toContain(start)
  })

  it('jeder Bildschirm hat ein Thema, und der Knopf ist wirklich eingebaut', () => {
    for (const a of aktuell) expect(themen.some(t => t.id === a), `kein Thema ${a}`).toBe(true)
    const quelle = app.map(p => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n')
    expect(quelle).toContain('<HilfeKnopf')
  })
})
