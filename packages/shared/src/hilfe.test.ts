import { describe, expect, it } from 'vitest'
import { findeHilfe, passtPfad, suchHilfe, type HilfeThema } from './hilfe.js'

const T = (id: string, extra: Partial<HilfeThema> = {}): HilfeThema =>
  ({ id, titel: id, zweck: '', schritte: [], ...extra })

describe('passtPfad', () => {
  it('feste Adressen', () => {
    expect(passtPfad('/kasse', '/kasse')).toBe(true)
    expect(passtPfad('/kasse', '/kassenbuch')).toBe(false)
    expect(passtPfad('/kasse', '/kasse/extra')).toBe(false)
  })
  it('Query, Hash und Schrägstrich am Ende zählen nicht', () => {
    expect(passtPfad('/einstellungen', '/einstellungen?bereich=kassen#einrichtung')).toBe(true)
    expect(passtPfad('/kasse', '/kasse/')).toBe(true)
  })
  it(':name steht für genau einen Abschnitt', () => {
    expect(passtPfad('/tische/:tabId', '/tische/abc-123')).toBe(true)
    expect(passtPfad('/tische/:tabId', '/tische')).toBe(false)
    expect(passtPfad('/tische/:tabId', '/tische/a/b')).toBe(false)
  })
  it('* am Ende nimmt alles Weitere mit', () => {
    expect(passtPfad('/tickets/*', '/tickets/1/x')).toBe(true)
  })
  it('Startseite', () => {
    expect(passtPfad('/', '/')).toBe(true)
    expect(passtPfad('/', '/kasse')).toBe(false)
  })
})

describe('findeHilfe', () => {
  const themen = [T('kasse', { pfade: ['/kasse'] }), T('tisch', { pfade: ['/tische/:tabId'] }), T('start')]
  it('findet das Thema zur Adresse', () => {
    expect(findeHilfe(themen, '/kasse')?.id).toBe('kasse')
    expect(findeHilfe(themen, '/tische/42')?.id).toBe('tisch')
  })
  it('ohne Treffer: Ersatzthema oder nichts', () => {
    expect(findeHilfe(themen, '/unbekannt', 'start')?.id).toBe('start')
    expect(findeHilfe(themen, '/unbekannt')).toBeUndefined()
  })
})

describe('suchHilfe', () => {
  const themen = [
    T('belege', { titel: 'Belege', stichworte: ['Bon', 'Rechnung'], schritte: ['Beleg anklicken, dann Storno wählen'] }),
    T('berichte', { titel: 'Berichte', zweck: 'Umsätze auswerten', schritte: ['Zeitraum wählen'] }),
    T('kasse', { titel: 'Kasse', schritte: ['Artikel antippen, am Ende Bar oder Karte'] }),
  ]
  it('leerer Text liefert alle', () => { expect(suchHilfe(themen, '  ')).toHaveLength(3) })
  it('sucht in Titel, Stichworten und Schritten — ohne Rücksicht auf Groß/klein und Umlaute', () => {
    expect(suchHilfe(themen, 'rechnung').map(t => t.id)).toEqual(['belege'])
    expect(suchHilfe(themen, 'UMSAETZE').map(t => t.id)).toEqual(['berichte'])
    expect(suchHilfe(themen, 'storno').map(t => t.id)).toEqual(['belege'])
  })
  it('alle Suchwörter müssen vorkommen', () => {
    expect(suchHilfe(themen, 'artikel karte').map(t => t.id)).toEqual(['kasse'])
    expect(suchHilfe(themen, 'artikel zeitraum')).toEqual([])
  })
  it('Treffer im Titel stehen vor Treffern im Text', () => {
    const t = [T('a', { titel: 'Etwas', schritte: ['Kasse öffnen'] }), T('b', { titel: 'Kasse' })]
    expect(suchHilfe(t, 'kasse').map(x => x.id)).toEqual(['b', 'a'])
  })
})
