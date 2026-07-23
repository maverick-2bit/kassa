/**
 * Mandanten-Einstellungen
 *
 *  GET  /api/mandanten/module
 *  PATCH /api/mandanten/module
 *
 *  GET  /api/mandanten/stammdaten
 *    → Firmenname, UID, Belegfußtext
 *
 *  PATCH /api/mandanten/stammdaten
 *    → Belegfußtext ändern (erfordert Berechtigung "einstellungen")
 */

import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { mandanten } from '../db/schema.js'
import { MandantModuleUpdateSchema, MandantStammdatenUpdateSchema } from '@kassa/shared'
import { encryptPrivateKey } from '../crypto/master-key.js'
import { globaleStripeKonfig, ladeStripeKonfig, testeStripeVerbindung } from '../services/stripe.service.js'

export interface MandantRouteOptions { db: Db; config: Config }

/** Stripe-Keys pro Mandant: nur setzen/löschen (write-only), nie zurückgeben.
 *  Feld fehlt = unverändert; null/leer = löschen; sonst grobe Präfix-Prüfung. */
const stripeKeyFeld = (prefix: RegExp, msg: string) =>
  z.preprocess(
    v => (v === '' ? null : v),
    z.string().trim().regex(prefix, msg).max(200).nullable().optional(),
  )
const MandantStripeUpdateSchema = z.object({
  secretKey:     stripeKeyFeld(/^sk_/, 'Secret Key beginnt mit sk_'),
  webhookSecret: stripeKeyFeld(/^whsec_/, 'Webhook Secret beginnt mit whsec_'),
})

/** Status-DTO (keine Klartext-Secrets) für die Stripe-Einstellungen. */
function stripeStatusDto(row: { sec: string | null; wh: string | null }, mandantId: string, config: Config) {
  const secretKeyGesetzt     = !!row.sec
  const webhookSecretGesetzt = !!row.wh
  return {
    secretKeyGesetzt,
    webhookSecretGesetzt,
    eigenesKontoAktiv:     secretKeyGesetzt && webhookSecretGesetzt,
    globalerFallbackAktiv: globaleStripeKonfig(config) !== null,
    webhookPfad:           `/api/stripe/webhook/${mandantId}`,
  }
}

export const mandantRoute: FastifyPluginAsync<MandantRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  // ---- GET /mandanten/module ----
  fastify.get('/mandanten/module', guard, async (request, reply) => {
    const [row] = await opts.db
      .select({
        modulGastroAktiv:         mandanten.modulGastroAktiv,
        modulAngeboteAktiv:       mandanten.modulAngeboteAktiv,
        modulMergeportAktiv:      mandanten.modulMergeportAktiv,
        modulReservierungenAktiv: mandanten.modulReservierungenAktiv,
        modulZeiterfassungAktiv:  mandanten.modulZeiterfassungAktiv,
        modulSbTerminalAktiv:     mandanten.modulSbTerminalAktiv,
      })
      .from(mandanten)
      .where(eq(mandanten.id, request.user.mandantId))
      .limit(1)

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })

  // ---- PATCH /mandanten/module ----
  fastify.patch('/mandanten/module', guard, async (request, reply) => {
    // Nur Admins oder User mit "einstellungen"-Berechtigung dürfen Module ändern
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const body = MandantModuleUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const updates: Partial<{
      modulGastroAktiv:         boolean
      modulAngeboteAktiv:       boolean
      modulMergeportAktiv:      boolean
      modulReservierungenAktiv: boolean
      modulZeiterfassungAktiv:  boolean
      modulSbTerminalAktiv:     boolean
    }> = {}

    if (body.data.modulGastroAktiv         !== undefined) updates.modulGastroAktiv         = body.data.modulGastroAktiv
    if (body.data.modulAngeboteAktiv       !== undefined) updates.modulAngeboteAktiv       = body.data.modulAngeboteAktiv
    if (body.data.modulMergeportAktiv      !== undefined) updates.modulMergeportAktiv      = body.data.modulMergeportAktiv
    if (body.data.modulReservierungenAktiv !== undefined) updates.modulReservierungenAktiv = body.data.modulReservierungenAktiv
    if (body.data.modulZeiterfassungAktiv  !== undefined) updates.modulZeiterfassungAktiv  = body.data.modulZeiterfassungAktiv
    if (body.data.modulSbTerminalAktiv     !== undefined) updates.modulSbTerminalAktiv     = body.data.modulSbTerminalAktiv

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ fehler: 'Keine Änderungen angegeben' })
    }

    const [row] = await opts.db
      .update(mandanten)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(mandanten.id, request.user.mandantId))
      .returning({
        modulGastroAktiv:         mandanten.modulGastroAktiv,
        modulAngeboteAktiv:       mandanten.modulAngeboteAktiv,
        modulMergeportAktiv:      mandanten.modulMergeportAktiv,
        modulReservierungenAktiv: mandanten.modulReservierungenAktiv,
        modulZeiterfassungAktiv:  mandanten.modulZeiterfassungAktiv,
        modulSbTerminalAktiv:     mandanten.modulSbTerminalAktiv,
      })

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })

  // ---- GET /mandanten/stammdaten ----
  fastify.get('/mandanten/stammdaten', guard, async (request, reply) => {
    const [row] = await opts.db
      .select({
        firmenname:               mandanten.firmenname,
        uid:                      mandanten.uid,
        belegFusstext:            mandanten.belegFusstext,
        belegKopftext:            mandanten.belegKopftext,
        belegZeigeSteuertabelle:  mandanten.belegZeigeSteuertabelle,
        belegZeigeQr:             mandanten.belegZeigeQr,
      })
      .from(mandanten)
      .where(eq(mandanten.id, request.user.mandantId))
      .limit(1)

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })

  // ---- PATCH /mandanten/stammdaten ----
  fastify.patch('/mandanten/stammdaten', guard, async (request, reply) => {
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const body = MandantStammdatenUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [row] = await opts.db
      .update(mandanten)
      .set({
        ...(body.data.belegFusstext           !== undefined && { belegFusstext:           body.data.belegFusstext ?? null }),
        ...(body.data.belegKopftext           !== undefined && { belegKopftext:           body.data.belegKopftext ?? null }),
        ...(body.data.belegZeigeSteuertabelle !== undefined && { belegZeigeSteuertabelle: body.data.belegZeigeSteuertabelle }),
        ...(body.data.belegZeigeQr            !== undefined && { belegZeigeQr:            body.data.belegZeigeQr }),
        updatedAt: new Date(),
      })
      .where(eq(mandanten.id, request.user.mandantId))
      .returning({
        firmenname:               mandanten.firmenname,
        uid:                      mandanten.uid,
        belegFusstext:            mandanten.belegFusstext,
        belegKopftext:            mandanten.belegKopftext,
        belegZeigeSteuertabelle:  mandanten.belegZeigeSteuertabelle,
        belegZeigeQr:             mandanten.belegZeigeQr,
      })

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(row)
  })

  // ---- GET /mandanten/stripe (Status, keine Klartext-Secrets) ----
  fastify.get('/mandanten/stripe', guard, async (request, reply) => {
    const [row] = await opts.db
      .select({ sec: mandanten.stripeSecretKeyEnc, wh: mandanten.stripeWebhookSecretEnc })
      .from(mandanten)
      .where(eq(mandanten.id, request.user.mandantId))
      .limit(1)
    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(stripeStatusDto(row, request.user.mandantId, opts.config))
  })

  // ---- PATCH /mandanten/stripe (Keys setzen/löschen, write-only) ----
  fastify.patch('/mandanten/stripe', guard, async (request, reply) => {
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const body = MandantStripeUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const pass = opts.config.MASTER_PASSPHRASE
    const updates: Partial<{ stripeSecretKeyEnc: string | null; stripeWebhookSecretEnc: string | null }> = {}
    if (body.data.secretKey !== undefined) {
      updates.stripeSecretKeyEnc = body.data.secretKey === null
        ? null
        : encryptPrivateKey(Buffer.from(body.data.secretKey, 'utf8'), pass)
    }
    if (body.data.webhookSecret !== undefined) {
      updates.stripeWebhookSecretEnc = body.data.webhookSecret === null
        ? null
        : encryptPrivateKey(Buffer.from(body.data.webhookSecret, 'utf8'), pass)
    }
    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ fehler: 'Keine Änderungen angegeben' })
    }

    const [row] = await opts.db
      .update(mandanten)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(mandanten.id, request.user.mandantId))
      .returning({ sec: mandanten.stripeSecretKeyEnc, wh: mandanten.stripeWebhookSecretEnc })

    if (!row) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })
    return reply.send(stripeStatusDto(row, request.user.mandantId, opts.config))
  })

  // ---- POST /mandanten/stripe/test (Verbindung gegen Stripe prüfen) ----
  fastify.post('/mandanten/stripe/test', guard, async (request, reply) => {
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }
    // Wirksame Konfig (eigene Keys > Env-Fallback). HTTP bleibt 200 — das Testergebnis
    // steht im Body, damit das Frontend nicht auf Status-Codes verzweigen muss.
    const konfig = await ladeStripeKonfig(opts.db, request.user.mandantId, opts.config)
    if (!konfig) return reply.send({ ok: false, grund: 'nicht_konfiguriert' })
    try {
      const info = await testeStripeVerbindung(konfig)
      return reply.send({ ok: true, eigene: konfig.eigene, ...info })
    } catch (err) {
      request.log.warn({ err }, 'Stripe-Verbindungstest fehlgeschlagen')
      return reply.send({ ok: false, grund: 'stripe_fehler', fehler: err instanceof Error ? err.message : 'Unbekannter Fehler' })
    }
  })
}
