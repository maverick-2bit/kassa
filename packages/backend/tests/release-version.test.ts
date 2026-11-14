import { describe, it, expect } from 'vitest'
import { neuesteVersionAusTags, tagRefsAusGitAntwort } from '../src/services/release-version.js'

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

describe('tagRefsAusGitAntwort (Antwort des Git-Protokolls, ohne Anfragelimit der REST-API)', () => {
  // Form der echten Antwort von GET https://github.com/<repo>.git/info/refs?service=git-upload-pack (Protokoll v0, gekürzt)
  const sha = (n: number) => String(n).padStart(40, 'a')
  const zeile = (n: number, name: string) => `${(name.length + 47).toString(16).padStart(4, '0')}${sha(n)} ${name}\n`
  const antwort =
    '001e# service=git-upload-pack\n0000' +
    `0155${sha(1)} HEAD\0multi_ack thin-pack side-band ofs-delta shallow symref=HEAD:refs/heads/master agent=git/github\n` +
    zeile(2, 'refs/heads/master') + zeile(3, 'refs/heads/fix/updater-herkunft') +
    zeile(4, 'refs/tags/v0.8.9') + zeile(5, 'refs/tags/v0.8.9^{}') +
    zeile(6, 'refs/tags/v0.8.91') + zeile(7, 'refs/tags/v0.8.91^{}') +
    zeile(8, 'refs/tags/v0.8.100') + zeile(9, 'refs/tags/v0.9.0-rc1') + zeile(10, 'refs/tags/vtest') +
    '0000'

  it('liefert die Release-Tags (auch die aufgelösten „^{}"-Zeilen), nie Branches, Vorabversionen oder Fremdes', () => {
    const refs = tagRefsAusGitAntwort(antwort)
    expect(refs).toContain('refs/tags/v0.8.9')
    expect(refs).toContain('refs/tags/v0.8.91')
    expect(refs).toContain('refs/tags/v0.8.100')
    expect(refs.some((r) => r.includes('rc1') || r.includes('vtest') || r.includes('heads'))).toBe(false)
    expect(refs.every((r) => /^refs\/tags\/v\d+\.\d+\.\d+$/.test(r))).toBe(true)
  })

  it('daraus ergibt sich die neueste Version (zahlenweise: v0.8.100 vor v0.8.91)', () => {
    expect(neuesteVersionAusTags(tagRefsAusGitAntwort(antwort))).toBe('0.8.100')
  })

  it('ein Tag ganz am Ende ohne Zeilenende wird gelesen; eine leere oder fremde Antwort liefert nichts', () => {
    expect(tagRefsAusGitAntwort('abc refs/tags/v1.2.3')).toEqual(['refs/tags/v1.2.3'])
    expect(tagRefsAusGitAntwort('')).toEqual([])
    expect(tagRefsAusGitAntwort('<html>Anmeldung im Hotel-WLAN</html>')).toEqual([])
  })
})
