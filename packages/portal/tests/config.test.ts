import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const BASIS = {
  DATABASE_URL: 'postgresql://portal:portal@localhost:5432/portal',
  PORTAL_JWT_SECRET: 'j'.repeat(32),
  PORTAL_MASTER_KEY: 'm'.repeat(32),
}

describe('Portal-Konfiguration', () => {
  it('Standardwerte', () => {
    const c = loadConfig(BASIS)
    expect(c).toMatchObject({
      PORT: 3100, NODE_ENV: 'development', LOG_LEVEL: 'info', TRUST_PROXY: false, CORS_ORIGIN: '',
      PORTAL_OFFLINE_NACH_SEKUNDEN: 600, PORTAL_SITZUNG_STUNDEN: 8,
    })
  })

  it('liest Zahlen und Schalter aus Text', () => {
    const c = loadConfig({ ...BASIS, PORT: '4000', TRUST_PROXY: 'true', PORTAL_OFFLINE_NACH_SEKUNDEN: '300', CORS_ORIGIN: ' https://portal.example.at ' })
    expect([c.PORT, c.TRUST_PROXY, c.PORTAL_OFFLINE_NACH_SEKUNDEN, c.CORS_ORIGIN]).toEqual([4000, true, 300, 'https://portal.example.at'])
  })

  it('fehlende oder zu kurze Geheimnisse brechen den Start ab — mit verständlicher Meldung', () => {
    expect(() => loadConfig({ ...BASIS, PORTAL_JWT_SECRET: undefined })).toThrow(/PORTAL_JWT_SECRET/)
    expect(() => loadConfig({ ...BASIS, PORTAL_MASTER_KEY: 'zu-kurz' })).toThrow(/PORTAL_MASTER_KEY muss mindestens 32 Zeichen/)
    expect(() => loadConfig({ ...BASIS, DATABASE_URL: 'keine-url' })).toThrow(/DATABASE_URL/)
  })

  it('unsinnige Schwellen werden abgelehnt', () => {
    expect(() => loadConfig({ ...BASIS, PORTAL_OFFLINE_NACH_SEKUNDEN: '10' })).toThrow(/PORTAL_OFFLINE_NACH_SEKUNDEN/)
    expect(() => loadConfig({ ...BASIS, PORT: '0' })).toThrow(/PORT/)
  })
})
