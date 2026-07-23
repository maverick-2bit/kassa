/**
 * Unit-Tests für die pro-Mandant-Stripe-Konfigurationsauflösung.
 * Kernlogik: eigene (verschlüsselte) Keys > globaler Env-Fallback > null.
 */

import { describe, it, expect } from 'vitest'
import type { Db } from '../src/db/client.js'
import type { Config } from '../src/config.js'
import { encryptPrivateKey } from '../src/crypto/master-key.js'
import { ladeStripeKonfig, globaleStripeKonfig } from '../src/services/stripe.service.js'

const PASS = 'test-passphrase-long-enough'

function mockDb(rows: unknown[]): Db {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }),
  } as unknown as Db
}

function cfg(over: Partial<Config> = {}): Config {
  return { MASTER_PASSPHRASE: PASS, ...over } as Config
}

const enc = (s: string) => encryptPrivateKey(Buffer.from(s, 'utf8'), PASS)

describe('ladeStripeKonfig', () => {
  it('eigene Mandant-Keys haben Vorrang und werden entschlüsselt', async () => {
    const rows = [{ sec: enc('sk_test_MANDANT'), wh: enc('whsec_MANDANT') }]
    const k = await ladeStripeKonfig(mockDb(rows), 'm1', cfg({ STRIPE_SECRET_KEY: 'sk_env', STRIPE_WEBHOOK_SECRET: 'whsec_env' }))
    expect(k).toEqual({ secretKey: 'sk_test_MANDANT', webhookSecret: 'whsec_MANDANT', eigene: true })
  })

  it('fällt auf globale Env-Keys zurück, wenn keine eigenen gesetzt sind', async () => {
    const k = await ladeStripeKonfig(mockDb([{ sec: null, wh: null }]), 'm1', cfg({ STRIPE_SECRET_KEY: 'sk_env', STRIPE_WEBHOOK_SECRET: 'whsec_env' }))
    expect(k).toEqual({ secretKey: 'sk_env', webhookSecret: 'whsec_env', eigene: false })
  })

  it('nur ein eigener Key gesetzt → kein Halb-Konto, sondern Env-Fallback', async () => {
    const rows = [{ sec: enc('sk_test_X'), wh: null }]
    const k = await ladeStripeKonfig(mockDb(rows), 'm1', cfg({ STRIPE_SECRET_KEY: 'sk_env', STRIPE_WEBHOOK_SECRET: 'whsec_env' }))
    expect(k?.eigene).toBe(false)
    expect(k?.secretKey).toBe('sk_env')
  })

  it('null, wenn weder eigene noch Env-Keys vorhanden sind', async () => {
    const k = await ladeStripeKonfig(mockDb([]), 'm1', cfg())
    expect(k).toBeNull()
  })
})

describe('globaleStripeKonfig', () => {
  it('null, wenn (nur) einer der beiden Env-Keys fehlt', () => {
    expect(globaleStripeKonfig(cfg({ STRIPE_SECRET_KEY: 'sk_env' }))).toBeNull()
    expect(globaleStripeKonfig(cfg({ STRIPE_WEBHOOK_SECRET: 'whsec_env' }))).toBeNull()
  })
  it('liefert die Env-Keys, wenn beide gesetzt sind', () => {
    expect(globaleStripeKonfig(cfg({ STRIPE_SECRET_KEY: 'sk_env', STRIPE_WEBHOOK_SECRET: 'whsec_env' })))
      .toEqual({ secretKey: 'sk_env', webhookSecret: 'whsec_env', eigene: false })
  })
})
