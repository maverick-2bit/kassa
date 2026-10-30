import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { findeHilfe, suchHilfe } from '@kassa/shared'
import { HILFE_START, HILFE_THEMEN } from './texte'

/** Alle Seiten im Rahmen der Kassa (Kopfleiste) aus App.tsx — ohne die Weiterleitungen (<Navigate>). */
function seitenDerKassa(): string[] {
  const quelle = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const ab = quelle.indexOf('<Route element={<Layout />}>')
  expect(ab, 'Layout-Block in App.tsx nicht gefunden').toBeGreaterThan(-1)
  return quelle.slice(ab).split('\n')
    .filter(z => z.includes('<Route path=') && !z.includes('<Navigate') && !z.includes('path="*"'))
    .map(z => /path="([^"]+)"/.exec(z)?.[1])
    .filter((p): p is string => !!p)
}

describe('Hilfetexte der Kassa', () => {
  it('Kennungen sind eindeutig, jedes Thema hat Titel, Zweck und Schritte', () => {
    const ids = HILFE_THEMEN.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of HILFE_THEMEN) {
      expect(t.titel.trim(), t.id).not.toBe('')
      expect(t.zweck.trim(), t.id).not.toBe('')
      expect(t.schritte.length + (t.abschnitte?.length ?? 0), `${t.id}: ohne Schritte`).toBeGreaterThan(0)
      for (const s of [...t.schritte, ...(t.abschnitte ?? []).flatMap(a => a.schritte), ...(t.tipps ?? [])]) {
        expect(s.trim(), `${t.id}: leerer Text`).not.toBe('')
      }
    }
  })

  it('es gibt „Erste Schritte" als Ersatzthema', () => {
    expect(HILFE_THEMEN.some(t => t.id === HILFE_START)).toBe(true)
  })

  it('JEDE Seite der Kassa hat einen Hilfetext (kommt eine Seite hinzu, muss hier ein Thema dazu)', () => {
    const seiten = seitenDerKassa()
    expect(seiten.length).toBeGreaterThan(20)
    const ohne = seiten.filter(p => !findeHilfe(HILFE_THEMEN, p.replace(/:[A-Za-z]+/g, 'x1')))
    expect(ohne, `Seiten ohne Hilfetext: ${ohne.join(', ')}`).toEqual([])
  })

  it('jede Adresse eines Themas gibt es in der Kassa (keine verwaisten Texte)', () => {
    const seiten = new Set(seitenDerKassa())
    const verwaist = HILFE_THEMEN.flatMap(t => (t.pfade ?? []).filter(p => !seiten.has(p)).map(p => `${t.id}: ${p}`))
    expect(verwaist).toEqual([])
  })

  it('zu den wichtigsten Seiten gehört das richtige Thema', () => {
    expect(findeHilfe(HILFE_THEMEN, '/kasse')?.id).toBe('kasse')
    expect(findeHilfe(HILFE_THEMEN, '/tische')?.id).toBe('tische')
    expect(findeHilfe(HILFE_THEMEN, '/tische/9f1c')?.id).toBe('tisch')
    expect(findeHilfe(HILFE_THEMEN, '/einstellungen?bereich=kassen')?.id).toBe('einstellungen')
    expect(findeHilfe(HILFE_THEMEN, '/tagesabschluss')?.id).toBe('tagesabschluss')
  })

  it('die Suche findet die Handgriffe, nach denen Mieter fragen', () => {
    const erstes = (wort: string) => suchHilfe(HILFE_THEMEN, wort)[0]?.id
    expect(erstes('storno')).toBe('belege')
    expect(erstes('z-bon')).toBe('tagesabschluss')
    expect(suchHilfe(HILFE_THEMEN, 'drucker').map(t => t.id)).toContain('einstellungen')
    expect(suchHilfe(HILFE_THEMEN, 'rabatt').map(t => t.id)).toContain('kasse')
  })
})
