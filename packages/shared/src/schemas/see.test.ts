/**
 * A-Trust-Basis-URL: nur die beiden A-Trust-Server.
 *
 * Die Kassa schickt Benutzer und Passwort an die eingetragene Adresse. Ist sie frei wählbar, genügt es, sie auf
 * einen eigenen Server zu stellen, damit das gespeicherte Passwort dorthin gelangt.
 */

import { describe, it, expect } from 'vitest'
import { istErlaubteAtrustBasisUrl } from './see.js'

describe('istErlaubteAtrustBasisUrl', () => {
  it.each([
    'https://hs.a-trust.at/RegistrierkasseMobile/v2',
    'https://hs-abnahme.a-trust.at/RegistrierkasseMobile/v2',
    'https://hs.a-trust.at',
    'https://HS.A-TRUST.AT/RegistrierkasseMobile/v2/',
    'https://hs.a-trust.at:443/RegistrierkasseMobile/v2',
  ])('%s ist erlaubt', (url) => {
    expect(istErlaubteAtrustBasisUrl(url)).toBe(true)
  })

  it.each([
    ['fremder Server',                       'https://evil.example/RegistrierkasseMobile/v2'],
    ['A-Trust als Unterdomain eines Fremden','https://hs.a-trust.at.evil.example/RegistrierkasseMobile/v2'],
    ['A-Trust nur im Pfad',                  'https://evil.example/hs.a-trust.at/RegistrierkasseMobile/v2'],
    ['andere A-Trust-Domain',                'https://www.a-trust.at/RegistrierkasseMobile/v2'],
    ['Zugangsdaten in der Adresse (Host steht hinter @)', 'https://hs.a-trust.at@evil.example/RegistrierkasseMobile/v2'],
    ['Benutzer vor dem richtigen Host',      'https://user:pw@hs.a-trust.at/RegistrierkasseMobile/v2'],
    ['ohne Verschlüsselung',                 'http://hs.a-trust.at/RegistrierkasseMobile/v2'],
    ['fremder Port',                         'https://hs.a-trust.at:8443/RegistrierkasseMobile/v2'],
    ['Punkt am Ende des Hostnamens',         'https://hs.a-trust.at./RegistrierkasseMobile/v2'],
    ['anderes Protokoll',                    'ftp://hs.a-trust.at/RegistrierkasseMobile/v2'],
    ['kein URL',                             'hs.a-trust.at'],
    ['leer',                                 ''],
    ['Rechner selbst',                       'http://127.0.0.1:8080/RegistrierkasseMobile/v2'],
    ['localhost',                            'http://localhost/RegistrierkasseMobile/v2'],
  ])('%s wird abgelehnt: %s', (_name, url) => {
    expect(istErlaubteAtrustBasisUrl(url)).toBe(false)
  })

  describe('lokalErlaubt (nur Entwicklung und Tests)', () => {
    it.each([
      'http://127.0.0.1:41234/RegistrierkasseMobile/v2',
      'http://localhost:8080/RegistrierkasseMobile/v2',
      'http://[::1]:8080/RegistrierkasseMobile/v2',
    ])('%s ist dann erlaubt', (url) => {
      expect(istErlaubteAtrustBasisUrl(url, { lokalErlaubt: true })).toBe(true)
    })

    it('ein fremder Server bleibt auch dann verboten', () => {
      expect(istErlaubteAtrustBasisUrl('https://evil.example/RegistrierkasseMobile/v2', { lokalErlaubt: true })).toBe(false)
      expect(istErlaubteAtrustBasisUrl('http://192.168.1.50/RegistrierkasseMobile/v2', { lokalErlaubt: true })).toBe(false)
      expect(istErlaubteAtrustBasisUrl('http://127.0.0.1.evil.example/x', { lokalErlaubt: true })).toBe(false)
    })
  })
})
