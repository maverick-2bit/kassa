/**
 * Auth-Routen
 *   POST /api/auth/login       E-Mail + Passwort → JWT
 *   POST /api/auth/pin-login   PIN → JWT
 *   GET  /api/auth/me          Aktueller User (für Frontend-Refresh)
 */

import type { FastifyPluginAsync } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { LoginInputSchema, PinLoginInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen, mandanten, users } from '../db/schema.js'
import { AuthError, login, loginWithPin, userZuDto } from '../services/auth.service.js'
import { logAudit, getClientIp } from '../services/audit.service.js'

export interface AuthRouteOptions {
  db: Db
}

/** Strenges Rate-Limit für Login-Endpunkte (Brute-Force-Schutz via IP). */
const loginRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }

// ---------------------------------------------------------------------------
// Account-Lockout (in-memory, pro E-Mail)
// Ergänzt das IP-basierte Rate-Limit um einen nutzerbasierten Schutz.
// ---------------------------------------------------------------------------

interface LockoutEntry { count: number; lockedUntil: number | null }

const LOCKOUT_MAP   = new Map<string, LockoutEntry>()
const MAX_VERSUCHE  = 5
const SPERRE_MS     = 15 * 60 * 1000  // 15 Minuten gesperrt

function istGesperrt(email: string): boolean {
  const e = LOCKOUT_MAP.get(email)
  if (!e?.lockedUntil) return false
  if (Date.now() < e.lockedUntil) return true
  // Sperre abgelaufen → Eintrag löschen
  LOCKOUT_MAP.delete(email)
  return false
}

function fehlschlagRegistrieren(email: string): void {
  const e = LOCKOUT_MAP.get(email) ?? { count: 0, lockedUntil: null }
  e.count++
  if (e.count >= MAX_VERSUCHE) e.lockedUntil = Date.now() + SPERRE_MS
  LOCKOUT_MAP.set(email, e)
}

function lockoutLoeschen(email: string): void {
  LOCKOUT_MAP.delete(email)
}

// ---------------------------------------------------------------------------

export const authRoute: FastifyPluginAsync<AuthRouteOptions> = async (fastify, opts) => {
  fastify.post('/auth/login', loginRateLimit, async (request, reply) => {
    const parsed = LoginInputSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ fehler: parsed.error.issues })
    }

    const email = parsed.data.email.toLowerCase()
    const ip    = getClientIp(request as Parameters<typeof getClientIp>[0])
    const ua    = (request.headers['user-agent'] as string | undefined) ?? null

    // Lockout-Prüfung (nach IP-Rate-Limit als zweite Verteidigungslinie)
    if (istGesperrt(email)) {
      await logAudit(opts.db, {
        aktion:    'login.gesperrt',
        details:   { email },
        ipAdresse: ip,
        userAgent: ua,
      }, fastify.log)
      return reply.status(429).send({
        fehler: `Zu viele Fehlversuche. Bitte in ${Math.ceil(SPERRE_MS / 60_000)} Minuten erneut versuchen.`,
      })
    }

    try {
      const result = await login(parsed.data, {
        db:        opts.db,
        signToken: (payload) => fastify.jwt.sign(payload),
      })

      lockoutLoeschen(email)
      await logAudit(opts.db, {
        mandantId: result.user.mandantId,
        userId:    result.user.id,
        aktion:    'login.erfolg',
        details:   { email },
        ipAdresse: ip,
        userAgent: ua,
      }, fastify.log)

      return reply.send(result)
    } catch (err) {
      if (err instanceof AuthError) {
        fehlschlagRegistrieren(email)
        await logAudit(opts.db, {
          aktion:    'login.fehlschlag',
          details:   { email, grund: err.message },
          ipAdresse: ip,
          userAgent: ua,
        }, fastify.log)
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Login fehlgeschlagen')
      return reply.status(500).send({ fehler: 'Login fehlgeschlagen' })
    }
  })

  fastify.post('/auth/pin-login', loginRateLimit, async (request, reply) => {
    const parsed = PinLoginInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const ip = getClientIp(request as Parameters<typeof getClientIp>[0])
    const ua = (request.headers['user-agent'] as string | undefined) ?? null

    try {
      const result = await loginWithPin(parsed.data, {
        db:        opts.db,
        signToken: (payload) => fastify.jwt.sign(payload),
      })

      await logAudit(opts.db, {
        mandantId: result.user.mandantId,
        userId:    result.user.id,
        aktion:    'pin_login.erfolg',
        ipAdresse: ip,
        userAgent: ua,
      }, fastify.log)

      return reply.send(result)
    } catch (err) {
      if (err instanceof AuthError) {
        await logAudit(opts.db, {
          aktion:    'pin_login.fehlschlag',
          details:   { kasseId: (parsed.data as { kasseId?: string }).kasseId },
          ipAdresse: ip,
          userAgent: ua,
        }, fastify.log)
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'PIN-Login fehlgeschlagen')
      return reply.status(500).send({ fehler: 'Login fehlgeschlagen' })
    }
  })

  // Geschützte Route — liefert aktuelle User-/Mandant-/Kassen-Daten
  fastify.get('/auth/me', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const [user] = await opts.db.select().from(users).where(eq(users.id, request.user.sub)).limit(1)
    if (!user) return reply.status(404).send({ fehler: 'Benutzer nicht gefunden' })

    const [mandant] = await opts.db
      .select({
        id:                       mandanten.id,
        firmenname:               mandanten.firmenname,
        uid:                      mandanten.uid,
        modulGastroAktiv:         mandanten.modulGastroAktiv,
        modulAngeboteAktiv:       mandanten.modulAngeboteAktiv,
        modulMergeportAktiv:      mandanten.modulMergeportAktiv,
        modulReservierungenAktiv: mandanten.modulReservierungenAktiv,
        modulZeiterfassungAktiv:  mandanten.modulZeiterfassungAktiv,
        modulSbTerminalAktiv:     mandanten.modulSbTerminalAktiv,
        modulGaengeAktiv:         mandanten.modulGaengeAktiv,
        gaengeAnzahl:             mandanten.gaengeAnzahl,
      })
      .from(mandanten)
      .where(eq(mandanten.id, user.mandantId))
      .limit(1)

    // Nur aktive Kassen — wie beim Login (ladeKassenFuerUser)
    const kassenListe = await opts.db
      .select({ id: kassen.id, kassenId: kassen.kassenId, umgebung: kassen.umgebung })
      .from(kassen)
      .where(and(eq(kassen.mandantId, user.mandantId), eq(kassen.status, 'aktiv')))

    return reply.send({
      user:    await userZuDto(user, opts.db),
      mandant,
      kassen:  kassenListe,
    })
  })
}
