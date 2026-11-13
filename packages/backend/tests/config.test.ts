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

  describe('LOGIN_RATE_LIMIT_MAX (Anmeldungen je Minute und IP)', () => {
    it('Standard 10 — wie bisher fest verdrahtet', () => {
      expect(loadConfig(validEnv as NodeJS.ProcessEnv).LOGIN_RATE_LIMIT_MAX).toBe(10)
      expect(loadConfig({ ...validEnv, LOGIN_RATE_LIMIT_MAX: '' } as NodeJS.ProcessEnv).LOGIN_RATE_LIMIT_MAX).toBe(10)
    })

    it('lässt sich setzen (E2E), aber nur sinnvoll: ganze Zahl von 1 bis 100000', () => {
      expect(loadConfig({ ...validEnv, LOGIN_RATE_LIMIT_MAX: '1000' } as NodeJS.ProcessEnv).LOGIN_RATE_LIMIT_MAX).toBe(1000)
      for (const falsch of ['0', '-5', '2.5', 'viele', '100001']) {
        expect(() => loadConfig({ ...validEnv, LOGIN_RATE_LIMIT_MAX: falsch } as NodeJS.ProcessEnv), falsch).toThrow(/LOGIN_RATE_LIMIT_MAX/)
      }
    })
  })

  describe('FON_HERSTELLER_ID (UID des Softwareherstellers für den FinanzOnline-Login)', () => {
    it('ist optional: nicht gesetzt oder leer (docker-compose reicht bei fehlendem Eintrag "" durch) = undefined', () => {
      expect(loadConfig(validEnv as NodeJS.ProcessEnv).FON_HERSTELLER_ID).toBeUndefined()
      expect(loadConfig({ ...validEnv, FON_HERSTELLER_ID: '' } as NodeJS.ProcessEnv).FON_HERSTELLER_ID).toBeUndefined()
      expect(loadConfig({ ...validEnv, FON_HERSTELLER_ID: '   ' } as NodeJS.ProcessEnv).FON_HERSTELLER_ID).toBeUndefined()
    })

    it('übernimmt eine gültige ID (Leerraum am Rand weg)', () => {
      expect(loadConfig({ ...validEnv, FON_HERSTELLER_ID: 'ATU12345678' } as NodeJS.ProcessEnv).FON_HERSTELLER_ID).toBe('ATU12345678')
      expect(loadConfig({ ...validEnv, FON_HERSTELLER_ID: ' ATU12345678\n' } as NodeJS.ProcessEnv).FON_HERSTELLER_ID).toBe('ATU12345678')
      expect(loadConfig({ ...validEnv, FON_HERSTELLER_ID: 'A'.repeat(24) } as NodeJS.ProcessEnv).FON_HERSTELLER_ID).toBe('A'.repeat(24))
    })

    it('lehnt ab, was das Schema des Logins ablehnen würde (10–24 Buchstaben/Ziffern) — der Start scheitert, nicht erst der Login', () => {
      for (const falsch of ['ATU_KASSA_RKSV_0001', 'KURZ', 'A'.repeat(9), 'A'.repeat(25), 'ATU 12345678', 'ATU-12345678', 'ÄTU12345678']) {
        expect(() => loadConfig({ ...validEnv, FON_HERSTELLER_ID: falsch } as NodeJS.ProcessEnv), falsch).toThrow(/FON_HERSTELLER_ID/)
      }
    })
  })

  describe('SETUP_TOKEN (Einrichtungs-Schlüssel für weitere Mandanten)', () => {
    it('ist optional: nicht gesetzt oder leer (docker-compose reicht bei fehlendem Eintrag "" durch) = Weg zu', () => {
      expect(loadConfig(validEnv as NodeJS.ProcessEnv).SETUP_TOKEN).toBeUndefined()
      expect(loadConfig({ ...validEnv, SETUP_TOKEN: '' } as NodeJS.ProcessEnv).SETUP_TOKEN).toBeUndefined()
      expect(loadConfig({ ...validEnv, SETUP_TOKEN: '   ' } as NodeJS.ProcessEnv).SETUP_TOKEN).toBeUndefined()
    })

    it('übernimmt einen ausreichend langen Schlüssel (Leerraum am Rand weg)', () => {
      const schluessel = 'a'.repeat(24)
      expect(loadConfig({ ...validEnv, SETUP_TOKEN: schluessel } as NodeJS.ProcessEnv).SETUP_TOKEN).toBe(schluessel)
      expect(loadConfig({ ...validEnv, SETUP_TOKEN: `  ${schluessel}\n` } as NodeJS.ProcessEnv).SETUP_TOKEN).toBe(schluessel)
    })

    it('lehnt einen zu kurzen Schlüssel ab — er schützt die ganze Installation', () => {
      expect(() => loadConfig({ ...validEnv, SETUP_TOKEN: 'kurz' } as NodeJS.ProcessEnv)).toThrow(/SETUP_TOKEN/)
      expect(() => loadConfig({ ...validEnv, SETUP_TOKEN: 'a'.repeat(23) } as NodeJS.ProcessEnv)).toThrow(/SETUP_TOKEN/)
    })
  })
})
