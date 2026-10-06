import { describe, it, expect } from 'vitest'
import { wirksamesKategorieRouting } from './kategorie-baum.js'

const k = (id: string, parentId: string | null, station: string | null = null, bonierdruckerId: string | null = null) =>
  ({ id, parentId, station, bonierdruckerId })

describe('wirksamesKategorieRouting: Station und Bonierdrucker werden von der Elterngruppe geerbt', () => {
  it('Untergruppe ohne eigene Angabe erbt die Station der Hauptgruppe (auch über mehrere Ebenen)', () => {
    const r = wirksamesKategorieRouting([
      k('haupt', null, 'schank'),
      k('unter', 'haupt'),
      k('enkel', 'unter'),
    ])
    expect(r.get('haupt')).toEqual({ station: 'schank', bonierdruckerId: null })
    expect(r.get('unter')).toEqual({ station: 'schank', bonierdruckerId: null })
    expect(r.get('enkel')).toEqual({ station: 'schank', bonierdruckerId: null })
  })

  it('eigene Angabe der Untergruppe geht vor, die nächstgelegene Gruppe gewinnt', () => {
    const r = wirksamesKategorieRouting([
      k('haupt', null, 'schank'),
      k('kueche', 'haupt', 'kueche'),
      k('kuechenkind', 'kueche'),
    ])
    expect(r.get('kueche')?.station).toBe('kueche')
    expect(r.get('kuechenkind')?.station).toBe('kueche')
  })

  it('Station und Drucker werden getrennt geerbt', () => {
    const r = wirksamesKategorieRouting([
      k('haupt', null, 'schank', 'drucker-haupt'),
      k('unter', 'haupt', null, 'drucker-eigen'),
    ])
    expect(r.get('unter')).toEqual({ station: 'schank', bonierdruckerId: 'drucker-eigen' })
  })

  it('ohne Angabe in der ganzen Kette: null; fehlender Elternteil und Zyklus brechen nicht ab', () => {
    const r = wirksamesKategorieRouting([
      k('a', null),
      k('b', 'fehlt'),
      k('x', 'y'),
      k('y', 'x', 'kueche'),
    ])
    expect(r.get('a')).toEqual({ station: null, bonierdruckerId: null })
    expect(r.get('b')).toEqual({ station: null, bonierdruckerId: null })
    expect(r.get('x')?.station).toBe('kueche')
  })
})
