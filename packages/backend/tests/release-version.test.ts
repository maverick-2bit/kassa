import { describe, it, expect } from 'vitest'
import { neuesteVersionAusTags } from '../src/services/release-version.js'

describe('neuesteVersionAusTags (Versionsanzeige „Neueste" — gleiche Regel wie der Updater)', () => {
  it('vergleicht zahlenweise, nicht als Text (v0.8.100 > v0.8.99, v0.8.91 > v0.8.9)', () => {
    expect(neuesteVersionAusTags(['refs/tags/v0.8.9', 'refs/tags/v0.8.91', 'refs/tags/v0.8.100', 'refs/tags/v0.8.99'])).toBe('0.8.100')
    expect(neuesteVersionAusTags(['refs/tags/v0.8.9', 'refs/tags/v0.8.91', 'refs/tags/v0.8.90'])).toBe('0.8.91')
  })

  it('höhere Minor-/Major-Version schlägt jede Patch-Nummer', () => {
    expect(neuesteVersionAusTags(['refs/tags/v0.8.999', 'refs/tags/v0.9.0'])).toBe('0.9.0')
    expect(neuesteVersionAusTags(['refs/tags/v0.99.99', 'refs/tags/v1.0.0', 'refs/tags/v0.8.1'])).toBe('1.0.0')
  })

  it('die Reihenfolge der Eingabe spielt keine Rolle', () => {
    const refs = ['refs/tags/v0.2.0', 'refs/tags/v0.8.91', 'refs/tags/v0.8.10', 'refs/tags/v0.7.173']
    expect(neuesteVersionAusTags(refs)).toBe('0.8.91')
    expect(neuesteVersionAusTags([...refs].reverse())).toBe('0.8.91')
  })

  it('ignoriert alles, was kein Release-Tag vX.Y.Z ist (Vorabversionen, Test-Tags, Branches, leere Einträge)', () => {
    expect(neuesteVersionAusTags([
      'refs/tags/v0.8.91',
      'refs/tags/v0.9.0-rc1',
      'refs/tags/v1.0',
      'refs/tags/v1.0.0.1',
      'refs/tags/vtest',
      'refs/tags/0.9.9',
      'refs/tags/release-9.9.9',
      'refs/heads/v9.9.9',
      '',
    ])).toBe('0.8.91')
  })

  it('ohne Release-Tag: null (die Kassa zeigt „unbekannt")', () => {
    expect(neuesteVersionAusTags([])).toBeNull()
    expect(neuesteVersionAusTags(['refs/tags/vtest', 'refs/heads/master'])).toBeNull()
  })
})
