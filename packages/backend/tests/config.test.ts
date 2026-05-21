import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  const validEnv = {
    DATABASE_URL:      'postgresql://kassa:kassa@localhost:5432/kassa',
    MASTER_PASSPHRASE: 'a-sufficiently-long-passphrase',
    JWT_SECRET:        'a-sufficiently-long-jwt-secret-key-here',
    PORT:              '3000',
    CORS_ORIGIN:       'http://localhost:5173',
  }

  it('akzeptiert valide Konfiguration', () => {
    const cfg = loadConfig(validEnv as NodeJS.ProcessEnv)
    expect(cfg.PORT).toBe(3000)
    expect(cfg.DATABASE_URL).toBe(validEnv.DATABASE_URL)
  })

  it('verlangt DATABASE_URL', () => {
    const env = { ...validEnv, DATABASE_URL: undefined } as unknown as NodeJS.ProcessEnv
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/)
  })

  it('verlangt MASTER_PASSPHRASE mit mindestens 16 Zeichen', () => {
    const env = { ...validEnv, MASTER_PASSPHRASE: 'zu-kurz' } as NodeJS.ProcessEnv
    expect(() => loadConfig(env)).toThrow(/MASTER_PASSPHRASE/)
  })

  it('setzt Defaults für optionale Felder', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL:      validEnv.DATABASE_URL,
      MASTER_PASSPHRASE: validEnv.MASTER_PASSPHRASE,
      JWT_SECRET:        validEnv.JWT_SECRET,
    }
    const cfg = loadConfig(env)
    expect(cfg.PORT).toBe(3000)
    expect(cfg.LOG_LEVEL).toBe('info')
    expect(cfg.NODE_ENV).toBe('development')
  })

  it('lehnt ungültige Log-Level ab', () => {
    const env = { ...validEnv, LOG_LEVEL: 'ungueltig' } as NodeJS.ProcessEnv
    expect(() => loadConfig(env)).toThrow(/LOG_LEVEL/)
  })
})
