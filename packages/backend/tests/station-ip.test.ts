import { describe, it, expect } from 'vitest'
import { bereinigeStationsIp, istGueltigeStationsIp } from '../src/services/kds/station-ip.js'

describe('Stations-IP für TCP-Displays', () => {
  it('gültig: IP-Adresse oder Hostname ohne Port', () => {
    expect(istGueltigeStationsIp('192.168.192.210')).toBe(true)
    expect(istGueltigeStationsIp('kds-kueche.local')).toBe(true)
    expect(istGueltigeStationsIp(' 10.0.0.5 ')).toBe(true)
  })

  it('ungültig: mit Port, mit http://, mit Pfad, mit Leerzeichen, leer', () => {
    for (const w of ['192.168.192.106:8080', 'http://192.168.1.5', '192.168.1.5/kds', '192.168 .1.5', '', '   ', '.5', 'a b']) {
      expect(istGueltigeStationsIp(w), w).toBe(false)
    }
  })

  it('bereinigeStationsIp: ungültig/leer → null (Browser-KDS, kein TCP-Versuch)', () => {
    expect(bereinigeStationsIp('192.168.192.106:8080')).toBeNull()
    expect(bereinigeStationsIp('')).toBeNull()
    expect(bereinigeStationsIp(undefined)).toBeNull()
    expect(bereinigeStationsIp(' 10.0.0.5 ')).toBe('10.0.0.5')
  })
})
