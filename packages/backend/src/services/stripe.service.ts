/**
 * Stripe-Service — Online-Zahlung für die Gast-Selbstbestellung (Stripe Checkout).
 *
 * Ein globales Stripe-Konto über Env-Keys (wie SMTP): fehlen die Keys, ist die
 * Online-Zahlung deaktiviert (isStripeAktiv = false) und es läuft nur der Demo-Pfad.
 * Checkout ist eine gehostete Bezahlseite (Voll-Redirect) → kein Stripe.js im Frontend.
 */

import Stripe from 'stripe'
import type { Config } from '../config.js'

/** Online-Zahlung nur möglich, wenn Secret- UND Webhook-Key gesetzt sind. */
export function isStripeAktiv(config: Config): boolean {
  return !!config.STRIPE_SECRET_KEY && !!config.STRIPE_WEBHOOK_SECRET
}

function client(config: Config): Stripe {
  if (!config.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY nicht gesetzt')
  return new Stripe(config.STRIPE_SECRET_KEY)
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
export async function erstelleCheckoutSession(input: CheckoutInput, config: Config): Promise<{ id: string; url: string }> {
  const stripe = client(config)
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
export function verifiziereWebhook(rawBody: Buffer, signature: string, config: Config): Stripe.Event {
  if (!config.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET nicht gesetzt')
  return client(config).webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET)
}
