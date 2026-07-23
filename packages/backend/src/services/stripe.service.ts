/**
 * Stripe-Service — Online-Zahlung für die Gast-Selbstbestellung (Stripe Checkout).
 *
 * Stripe-Konto **pro Mandant**: jeder Betrieb hinterlegt seine eigenen, verschlüsselten
 * Keys (Muster crypto/master-key.ts). Sind für einen Mandanten keine Keys gesetzt, greifen
 * die globalen Env-Keys (`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`) als Fallback; fehlen
 * auch die, ist die Online-Zahlung aus (Demo-Pfad in Dev/Test). `ladeStripeKonfig` löst das
 * auf. Checkout ist eine gehostete Bezahlseite (Voll-Redirect) → kein Stripe.js im Frontend.
 */

import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { mandanten } from '../db/schema.js'
import { decryptPrivateKey } from '../crypto/master-key.js'

/** Wirksame Stripe-Zugangsdaten (entweder Mandant-eigen oder globaler Env-Fallback). */
export interface StripeKonfig {
  secretKey:     string
  webhookSecret: string
  /** true = aus den Mandant-eigenen (verschlüsselten) Keys, false = globaler Env-Fallback */
  eigene:        boolean
}

/** Globale Env-Keys als StripeKonfig, oder null wenn (eines davon) nicht gesetzt. */
export function globaleStripeKonfig(config: Config): StripeKonfig | null {
  if (config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET) {
    return { secretKey: config.STRIPE_SECRET_KEY, webhookSecret: config.STRIPE_WEBHOOK_SECRET, eigene: false }
  }
  return null
}

/**
 * Löst die wirksame Stripe-Konfiguration eines Mandanten auf:
 * eigene (verschlüsselte) Keys haben Vorrang, sonst globale Env-Keys, sonst null.
 * Beide eigenen Keys müssen gesetzt sein, damit sie greifen (sonst Fallback).
 */
export async function ladeStripeKonfig(db: Db, mandantId: string, config: Config): Promise<StripeKonfig | null> {
  const [m] = await db
    .select({ sec: mandanten.stripeSecretKeyEnc, wh: mandanten.stripeWebhookSecretEnc })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)
  if (m?.sec && m.wh) {
    return {
      secretKey:     decryptPrivateKey(m.sec, config.MASTER_PASSPHRASE).toString('utf8'),
      webhookSecret: decryptPrivateKey(m.wh,  config.MASTER_PASSPHRASE).toString('utf8'),
      eigene:        true,
    }
  }
  return globaleStripeKonfig(config)
}

function client(konfig: StripeKonfig): Stripe {
  return new Stripe(konfig.secretKey)
}

export interface CheckoutPosition {
  bezeichnung:     string
  preisBruttoCent: number
  menge:           number
}

export interface CheckoutInput {
  bestellungId: string
  positionen:   CheckoutPosition[]
  /** Freiwilliges Trinkgeld (Cent); als eigene „Trinkgeld"-Zeile mitverrechnet, wenn > 0 */
  trinkgeldCent?: number
  /** Rücksprung in die Gast-App nach (Nicht-)Zahlung */
  successUrl:   string
  cancelUrl:    string
}

/**
 * Erzeugt eine Stripe-Checkout-Session (mode: payment) mit den Positionen als
 * line_items und der Bestell-ID in metadata (für den Webhook). Gibt id + URL zurück.
 * Ein Trinkgeld (> 0) wird als eigene „Trinkgeld"-Zeile mitberechnet.
 */
export async function erstelleCheckoutSession(input: CheckoutInput, konfig: StripeKonfig): Promise<{ id: string; url: string }> {
  const stripe = client(konfig)
  const lineItems = input.positionen.map(p => ({
    quantity: p.menge,
    price_data: {
      currency:     'eur' as const,
      unit_amount:  p.preisBruttoCent,
      product_data: { name: p.bezeichnung },
    },
  }))
  if (input.trinkgeldCent && input.trinkgeldCent > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency:     'eur',
        unit_amount:  input.trinkgeldCent,
        product_data: { name: 'Trinkgeld' },
      },
    })
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    success_url: input.successUrl,
    cancel_url:  input.cancelUrl,
    metadata:              { bestellungId: input.bestellungId },
    payment_intent_data:   { metadata: { bestellungId: input.bestellungId } },
  })
  if (!session.url) throw new Error('Stripe-Checkout-Session ohne URL')
  return { id: session.id, url: session.url }
}

/** Verifiziert die Webhook-Signatur gegen den rohen Request-Body (wirft bei Fälschung). */
export function verifiziereWebhook(rawBody: Buffer, signature: string, konfig: StripeKonfig): Stripe.Event {
  return client(konfig).webhooks.constructEvent(rawBody, signature, konfig.webhookSecret)
}
