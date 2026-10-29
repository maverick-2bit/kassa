import { describe, expect, it } from 'vitest'
import { nachbarReiter, swipeRichtung } from './swipe.js'

describe('swipeRichtung', () => {
  it('Finger nach links = links, nach rechts = rechts', () => {
    expect(swipeRichtung({ x: 300, y: 100 }, { x: 180, y: 105 })).toBe('links')
    expect(swipeRichtung({ x: 100, y: 100 }, { x: 230, y: 90 })).toBe('rechts')
  })
  it('ein Tipp oder ein kurzes Zucken ist kein Wisch', () => {
    expect(swipeRichtung({ x: 100, y: 100 }, { x: 100, y: 100 })).toBeNull()
    expect(swipeRichtung({ x: 100, y: 100 }, { x: 140, y: 100 })).toBeNull()
  })
  it('Scrollen (überwiegend senkrecht) ist kein Wisch', () => {
    expect(swipeRichtung({ x: 100, y: 100 }, { x: 180, y: 300 })).toBeNull()
  })
  it('ein schräger Wisch zählt, solange er klar waagrecht ist', () => {
    expect(swipeRichtung({ x: 100, y: 100 }, { x: 220, y: 150 })).toBe('rechts')   // 120 waagrecht, 50 senkrecht
    expect(swipeRichtung({ x: 100, y: 100 }, { x: 170, y: 160 })).toBeNull()       // 70 waagrecht, 60 senkrecht
  })
  it('die Mindestweite lässt sich ändern', () => {
    expect(swipeRichtung({ x: 100, y: 100 }, { x: 140, y: 100 }, 30)).toBe('rechts')
  })
})

describe('nachbarReiter', () => {
  const ids = ['__favoriten__', 'getraenke', 'speisen']
  it('links = nächster, rechts = vorheriger', () => {
    expect(nachbarReiter(ids, 'getraenke', 'links')).toBe('speisen')
    expect(nachbarReiter(ids, 'getraenke', 'rechts')).toBe('__favoriten__')
  })
  it('am Rand bleibt es stehen', () => {
    expect(nachbarReiter(ids, 'speisen', 'links')).toBeNull()
    expect(nachbarReiter(ids, '__favoriten__', 'rechts')).toBeNull()
  })
  it('unbekannter oder fehlender aktueller Reiter: nichts', () => {
    expect(nachbarReiter(ids, 'gibt-es-nicht', 'links')).toBeNull()
    expect(nachbarReiter(ids, null, 'links')).toBeNull()
    expect(nachbarReiter([], 'x', 'links')).toBeNull()
  })
})
