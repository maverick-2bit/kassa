import { describe, it, expect } from 'vitest'
import {
  base32Dekodiere, base32Kodiere, erzeugeTotpGeheimnis, hotp, otpauthUrl, pruefeTotp, totpSchritt,
} from '../src/auth/totp.js'
import { entschluessele, leiteSchluesselAb, verschluessele } from '../src/auth/verschluesselung.js'
import { erzeugeBoxToken, hashToken, tokenAusAuthorization, TOKEN_PRAEFIX } from '../src/auth/box-token.js'
import { hashPasswort, pruefePasswort, pruefePasswortRegel, scheinPruefung } from '../src/auth/passwort.js'

describe('Base32', () => {
  it('Testwerte aus RFC 4648', () => {
    const fall: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]
    for (const [klar, kodiert] of fall) {
      expect(base32Kodiere(Buffer.from(klar))).toBe(kodiert)
      expect(base32Dekodiere(kodiert).toString()).toBe(klar)
    }
  })

  it('liest Kleinschreibung, Leerzeichen und Auffüllzeichen; ungültige Zeichen werfen', () => {
    expect(base32Dekodiere('mzxw 6ytb oi======').toString()).toBe('foobar')
    expect(() => base32Dekodiere('MZXW1')).toThrow(/Ungültiges Base32-Zeichen/)
  })

  it('Hin und zurück für beliebige Bytes', () => {
    const daten = Buffer.from(Array.from({ length: 40 }, (_, i) => (i * 37 + 11) % 256))
    expect(base32Dekodiere(base32Kodiere(daten)).equals(daten)).toBe(true)
  })
})

describe('TOTP (RFC 6238)', () => {
  // Geheimnis aus dem RFC: ASCII "12345678901234567890", SHA-1, 8 Stellen
  const rfcGeheimnis = Buffer.from('12345678901234567890')
  const rfcFaelle: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ]

  it('liefert die Testwerte aus dem RFC', () => {
    for (const [sekunden, erwartet] of rfcFaelle) {
      expect(hotp(rfcGeheimnis, totpSchritt(sekunden * 1000), 8)).toBe(erwartet)
    }
  })

  it('6-stellige Codes sind die letzten sechs Stellen', () => {
    expect(hotp(rfcGeheimnis, totpSchritt(59_000))).toBe('287082')
  })

  const geheimnis = base32Kodiere(rfcGeheimnis)
  const jetzt = 1_700_000_000_000
  const codeZu = (ms: number) => hotp(rfcGeheimnis, totpSchritt(ms))

  it('akzeptiert den aktuellen Code und gibt den Schritt zurück', () => {
    expect(pruefeTotp(geheimnis, codeZu(jetzt), { jetztMs: jetzt })).toEqual({ gueltig: true, schritt: totpSchritt(jetzt) })
  })

  it('toleriert eine Abweichung von einem Schritt (±30 s), aber nicht mehr', () => {
    expect(pruefeTotp(geheimnis, codeZu(jetzt - 30_000), { jetztMs: jetzt }).gueltig).toBe(true)
    expect(pruefeTotp(geheimnis, codeZu(jetzt + 30_000), { jetztMs: jetzt }).gueltig).toBe(true)
    expect(pruefeTotp(geheimnis, codeZu(jetzt - 90_000), { jetztMs: jetzt }).gueltig).toBe(false)
    expect(pruefeTotp(geheimnis, codeZu(jetzt + 90_000), { jetztMs: jetzt }).gueltig).toBe(false)
  })

  it('ein Code gilt nur einmal: dieser und ältere Schritte werden abgelehnt', () => {
    const schritt = totpSchritt(jetzt)
    const code = codeZu(jetzt)
    expect(pruefeTotp(geheimnis, code, { jetztMs: jetzt, letzterSchritt: schritt }).gueltig).toBe(false)
    expect(pruefeTotp(geheimnis, code, { jetztMs: jetzt, letzterSchritt: schritt + 5 }).gueltig).toBe(false)
    expect(pruefeTotp(geheimnis, code, { jetztMs: jetzt, letzterSchritt: schritt - 1 }).gueltig).toBe(true)
    // Der Code des NÄCHSTEN Schritts ist trotz gebrauchtem aktuellen Schritt noch gültig
    expect(pruefeTotp(geheimnis, codeZu(jetzt + 30_000), { jetztMs: jetzt, letzterSchritt: schritt }).gueltig).toBe(true)
  })

  it('lehnt falsche, zu kurze, zu lange und nichtnumerische Codes ab', () => {
    const richtig = codeZu(jetzt)
    const falsch = richtig === '000000' ? '000001' : '000000'
    for (const code of [falsch, '12345', '1234567', 'abcdef', '', ' 123456']) {
      expect(pruefeTotp(geheimnis, code, { jetztMs: jetzt }).gueltig).toBe(false)
    }
  })

  it('neue Geheimnisse sind zufällig, 32 Zeichen Base32 und werden von der eigenen Prüfung akzeptiert', () => {
    const a = erzeugeTotpGeheimnis(), b = erzeugeTotpGeheimnis()
    expect(a).toMatch(/^[A-Z2-7]{32}$/)
    expect(a).not.toBe(b)
    const code = hotp(base32Dekodiere(a), totpSchritt(jetzt))
    expect(pruefeTotp(a, code, { jetztMs: jetzt }).gueltig).toBe(true)
  })

  it('otpauth-Adresse mit allen Angaben für die App', () => {
    const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'chef@kassa.at')
    expect(url.startsWith('otpauth://totp/Kassa%20Serviceportal:chef%40kassa.at?')).toBe(true)
    const p = new URL(url).searchParams
    expect(p.get('secret')).toBe('JBSWY3DPEHPK3PXP')
    expect(p.get('issuer')).toBe('Kassa Serviceportal')
    expect([p.get('digits'), p.get('period'), p.get('algorithm')]).toEqual(['6', '30', 'SHA1'])
  })
})

describe('Verschlüsselung der TOTP-Geheimnisse', () => {
  const schluessel = leiteSchluesselAb('ein-ausreichend-langer-geheimer-schluessel-0123456789')

  it('Hin und zurück; jede Verschlüsselung sieht anders aus', () => {
    const a = verschluessele('JBSWY3DPEHPK3PXP', schluessel)
    const b = verschluessele('JBSWY3DPEHPK3PXP', schluessel)
    expect(a).not.toBe(b)
    expect(a.startsWith('v1.')).toBe(true)
    expect(a).not.toContain('JBSWY')
    expect(entschluessele(a, schluessel)).toBe('JBSWY3DPEHPK3PXP')
    expect(a.length).toBeLessThan(300) // passt in die Spalte
  })

  it('falscher Schlüssel, veränderter Wert oder fremdes Format → Fehler', () => {
    const paket = verschluessele('geheim', schluessel)
    expect(() => entschluessele(paket, leiteSchluesselAb('ein-anderer-langer-geheimer-schluessel-9876543210'))).toThrow()
    const teile = paket.split('.')
    const verfaelscht = [teile[0], teile[1], teile[2], Buffer.from('xxxxxx').toString('base64url')].join('.')
    expect(() => entschluessele(verfaelscht, schluessel)).toThrow()
    expect(() => entschluessele('klartext', schluessel)).toThrow(/Format/)
    expect(() => entschluessele('v2.a.b.c', schluessel)).toThrow(/Format/)
  })
})

describe('Box-Token', () => {
  it('hat Präfix, 47 Zeichen (> 24, die die Box verlangt) und ist jedes Mal anders', () => {
    const a = erzeugeBoxToken(), b = erzeugeBoxToken()
    expect(a.token.startsWith(TOKEN_PRAEFIX)).toBe(true)
    expect(a.token).toHaveLength(47)
    expect(a.token).not.toBe(b.token)
    expect(a.hinweis).toBe(a.token.slice(-4))
  })

  it('gespeichert wird nur der SHA-256 — und der lässt sich aus dem Token wieder berechnen', () => {
    const t = erzeugeBoxToken()
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(t.token)).toBe(t.hash)
    expect(t.hash).not.toContain(t.token)
    expect(hashToken(t.token + 'x')).not.toBe(t.hash)
  })

  it('liest das Token aus dem Authorization-Header; alles Unpassende → null', () => {
    const t = erzeugeBoxToken().token
    expect(tokenAusAuthorization(`Bearer ${t}`)).toBe(t)
    expect(tokenAusAuthorization(`bearer   ${t} `)).toBe(t)
    for (const kaputt of [undefined, '', t, `Basic ${t}`, 'Bearer ', 'Bearer kurz', `Bearer ${t}x`, `Bearer ${t.slice(1)}`, `Bearer ${t} ${t}`, 'Bearer kpt_' + 'ä'.repeat(43)]) {
      expect(tokenAusAuthorization(kaputt)).toBeNull()
    }
  })
})

describe('Passwörter', () => {
  it('Hash prüft richtig, ist gesalzen und kein Klartext', async () => {
    const h1 = await hashPasswort('ein-gutes-passwort-123'), h2 = await hashPasswort('ein-gutes-passwort-123')
    expect(h1).not.toBe(h2)
    expect(h1.startsWith('$2')).toBe(true)
    expect(await pruefePasswort('ein-gutes-passwort-123', h1)).toBe(true)
    expect(await pruefePasswort('ein-gutes-passwort-124', h1)).toBe(false)
  })

  it('Scheinprüfung ist immer falsch', async () => {
    expect(await scheinPruefung('irgendwas')).toBe(false)
  })

  it('Regeln: Länge, zu einfach, 72-Byte-Grenze von bcrypt, E-Mail darf nicht drinstehen', () => {
    expect(pruefePasswortRegel('kurz')).toMatch(/mindestens 12/)
    expect(pruefePasswortRegel('aaaaaaaaaaaaaa')).toMatch(/zu einfach/)
    expect(pruefePasswortRegel('x1y2z3'.repeat(14))).toMatch(/höchstens 72/)
    expect(pruefePasswortRegel('chef-und-ein-langes-passwort', 'chef@kassa.at')).toMatch(/E-Mail/)
    expect(pruefePasswortRegel('ein-langes-gutes-passwort', 'chef@kassa.at')).toBeNull()
    expect(pruefePasswortRegel('ein-langes-gutes-passwort')).toBeNull()
  })
})
