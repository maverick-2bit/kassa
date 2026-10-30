import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { findeHilfe, suchHilfe } from '@kassa/shared'
import { HILFE_START, HILFE_THEMEN } from './texte'

/** Alle Bildschirme der Kellner-App aus App.tsx — ohne den Auffang-Pfad „*". */
function seiten(): string[] {
  const quelle = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  return quelle.split('\n')
    .filter(z => z.includes('<Route path=') && !z.includes('path="*"'))
    .map(z => /path="([^"]+)"/.exec(z)?.[1])
    .filter((p): p is string => !!p)
}

describe('Hilfetexte der Kellner-App', () => {
  it('Kennungen sind eindeutig, jedes Thema hat Titel, Zweck und Schritte', () => {
    const ids = HILFE_THEMEN.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of HILFE_THEMEN) {
      expect(t.titel.trim(), t.id).not.toBe('')
      expect(t.zweck.trim(), t.id).not.toBe('')
      expect(t.schritte.length, `${t.id}: ohne Schritte`).toBeGreaterThan(0)
    }
    expect(HILFE_THEMEN.some(t => t.id === HILFE_START)).toBe(true)
  })

  it('JEDER Bildschirm hat einen Hilfetext, und jeder Text gehört zu einem Bildschirm', () => {
    const alle = seiten()
    expect(alle.length).toBeGreaterThanOrEqual(4)
    const ohne = alle.filter(p => !findeHilfe(HILFE_THEMEN, p.replace(/:[A-Za-z]+/g, 'x1')))
    expect(ohne, `ohne Hilfetext: ${ohne.join(', ')}`).toEqual([])
    const verwaist = HILFE_THEMEN.flatMap(t => (t.pfade ?? []).filter(p => !alle.includes(p)).map(p => `${t.id}: ${p}`))
    expect(verwaist).toEqual([])
  })

  it('zu den Bildschirmen gehört das richtige Thema; die Suche findet Handgriffe', () => {
    expect(findeHilfe(HILFE_THEMEN, '/')?.id).toBe('tische')
    expect(findeHilfe(HILFE_THEMEN, '/tab/abc')?.id).toBe('tisch')
    expect(findeHilfe(HILFE_THEMEN, '/tab/abc/artikel')?.id).toBe('artikel-waehlen')
    expect(findeHilfe(HILFE_THEMEN, '/login')?.id).toBe('anmelden')
    expect(suchHilfe(HILFE_THEMEN, 'bonieren')[0]?.id).toBe('tisch')
    expect(suchHilfe(HILFE_THEMEN, 'pin').map(t => t.id)).toContain('anmelden')
  })
})
