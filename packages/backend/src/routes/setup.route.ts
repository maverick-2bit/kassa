/**
 * POST /api/setup – Kasseneinrichtung (Mandant + Kasse + Admin)
 *
 * Erwartet ein JSON-Body gemäß SetupInputSchema und ruft den Setup-Service auf.
 * Antwortet mit SetupResponse (auch im Fehlerfall, dann HTTP 400/403).
 *
 * Wer einrichten darf — Prüfung VOR allem anderen, damit ein Unberechtigter weder die
 * (teure, mit FinanzOnline sprechende) RKSV-Einrichtung anstößt noch erfährt, ob eine UID
 * oder E-Mail schon vergeben ist:
 *   1. Einrichtungs-Schlüssel (Header x-setup-token = SETUP_TOKEN aus der .env, falls gesetzt)
 *   2. Betreiber der Installation, angemeldet (Authorization: Bearer …)
 *   3. sonst nur, solange es noch KEINEN Benutzer gibt (frisch installierte Kassa)
 * Alles andere ist 403. Früher war die Route für jeden offen und legte auch auf einer
 * eingerichteten Installation einen weiteren Mandanten samt Admin an.
 *
 * Eigenes enges Rate-Limit je Client-IP (nicht je Token): die Route ist öffentlich.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { SetupInputSchema, type SetupResponse } from '@kassa/shared'
import {
  fuehreSetupDurch, SetupGesperrtError,
  type SetupErlaubnis, type SetupServiceDeps,
} from '../services/setup.service.js'
import { users } from '../db/schema.js'
import { istAktiverBetreiber } from '../auth/betreiber.js'
import { ipSchluessel } from '../auth/rate-limit.js'
import { getClientIp, logAudit } from '../services/audit.service.js'

export interface SetupRoutePluginOptions {
  deps: SetupServiceDeps
  /** Einrichtungs-Schlüssel (SETUP_TOKEN) — ohne ihn gibt es diesen Weg nicht */
  setupToken?: string | undefined
  /** Anfragen je Minute und Client; Standard 5 (nur Tests setzen mehr) */
  rateLimitMax?: number
}

/** Meldung an alle, die auf einer eingerichteten Installation ohne Berechtigung einrichten wollen. */
export const SETUP_GESPERRT_MELDUNG =
  'Diese Kassa ist bereits eingerichtet. Weitere Mandanten legt nur der Betreiber an ' +
  '(angemeldet unter Einstellungen → System).'

function fehlerAntwort(meldung: string): SetupResponse {
  return {
    erfolgreich: false,
    schritte: [{
      schritt:     'eingabe-validierung',
      status:      'fehler',
      meldung,
      zeitstempel: new Date().toISOString(),
    }],
    fehler: meldung,
  }
}

/** Zeitkonstanter Vergleich (über SHA-256, damit auch die Länge nichts verrät). */
function schluesselPasst(vorgelegt: string, erwartet: string): boolean {
  const a = createHash('sha256').update(vorgelegt).digest()
  const b = createHash('sha256').update(erwartet).digest()
  return timingSafeEqual(a, b)
}

export const setupRoute: FastifyPluginAsync<SetupRoutePluginOptions> = async (fastify, opts) => {
  const { db } = opts.deps

  // Öffentlich: Ist diese Installation schon eingerichtet (gibt es Benutzer)?
  //
  // Anlass: Auf einem frisch installierten Gerät erscheint sofort die
  // Login-Seite — und wer Zugangsdaten einer ANDEREN Installation kennt,
  // versucht sie dort und hält die Kassa für kaputt. Die Login-Seite fragt
  // diesen Status ab und führt stattdessen deutlich zur Ersteinrichtung.
  //
  // Bewusst nur ein Boolean: verrät einem Unangemeldeten nichts außer dem,
  // was die Setup-Seite ohnehin zeigt.
  fastify.get('/setup/status', async (_request, reply) => {
    const [erster] = await db.select({ id: users.id }).from(users).limit(1)
    return reply.send({ eingerichtet: erster !== undefined })
  })

  /** Womit darf dieser Aufrufer einrichten? null = gar nicht. */
  async function ermittleErlaubnis(request: FastifyRequest): Promise<{ erlaubnis: SetupErlaubnis; userId?: string; mandantId?: string } | null> {
    // 1. Einrichtungs-Schlüssel
    const schluessel = request.headers['x-setup-token']
    if (opts.setupToken && typeof schluessel === 'string' && schluesselPasst(schluessel, opts.setupToken)) {
      return { erlaubnis: 'schluessel' }
    }

    // 2. Betreiber, angemeldet. Ein ungültiges Token zählt wie keines: ein Gerät mit altem Token
    //    einer anderen Installation darf eine leere Installation trotzdem einrichten.
    if (request.headers.authorization) {
      let angemeldet = false
      try { await request.jwtVerify(); angemeldet = true } catch { /* kein gültiges Token */ }
      // Geräte-Token (KDS, Einlass) sind keine Anmeldung eines Benutzers
      if (angemeldet && !request.user.typ
          && await istAktiverBetreiber(db, request.user.sub, request.user.mandantId)) {
        return { erlaubnis: 'betreiber', userId: request.user.sub, mandantId: request.user.mandantId }
      }
    }

    // 3. Leere Installation (der Service prüft das beim Anlegen noch einmal, atomar)
    const [erster] = await db.select({ id: users.id }).from(users).limit(1)
    return erster === undefined ? { erlaubnis: 'offen' } : null
  }

  const rateLimit = {
    config: { rateLimit: { max: opts.rateLimitMax ?? 5, timeWindow: '1 minute', keyGenerator: ipSchluessel } },
  }

  fastify.post('/setup', rateLimit, async (request, reply) => {
    const ip = getClientIp(request as Parameters<typeof getClientIp>[0])
    const ua = (request.headers['user-agent'] as string | undefined) ?? null

    // Alles in einem try: auch die Berechtigungsprüfung liest die Datenbank, und die Route ist öffentlich —
    // ein DB-Fehler darf als SetupResponse ohne Interna enden, nicht als Fastify-Standardantwort
    try {
      const berechtigt = await ermittleErlaubnis(request)
      if (!berechtigt) {
        await logAudit(db, { aktion: 'setup.verweigert', ipAdresse: ip, userAgent: ua }, request.log)
        return reply.status(403).send(fehlerAntwort(SETUP_GESPERRT_MELDUNG))
      }

      // Eingabe-Validierung via Zod (zusätzlich zu der innerhalb von kasseAutomatischEinrichten)
      const parsed = SetupInputSchema.safeParse(request.body)
      if (!parsed.success) {
        const meldung = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        return reply.status(400).send(fehlerAntwort(meldung))
      }

      const result = await fuehreSetupDurch(parsed.data, opts.deps, undefined, berechtigt.erlaubnis)
      if (!result.erfolgreich) {
        return reply.status(400).send(result)
      }
      await logAudit(db, {
        ...(result.mandantId ? { mandantId: result.mandantId } : {}),
        ...(berechtigt.userId ? { userId: berechtigt.userId } : {}),
        aktion:    'setup.mandant_angelegt',
        details:   { weg: berechtigt.erlaubnis, firmenname: parsed.data.firmenname },
        ipAdresse: ip,
        userAgent: ua,
      }, request.log)
      return reply.status(201).send(result)
    } catch (err) {
      // Zwischen der Prüfung oben und dem Anlegen ist die Installation eingerichtet worden
      if (err instanceof SetupGesperrtError) {
        await logAudit(db, { aktion: 'setup.verweigert', ipAdresse: ip, userAgent: ua }, request.log)
        return reply.status(403).send(fehlerAntwort(SETUP_GESPERRT_MELDUNG))
      }
      // Erwartbare Fehler kommen als erfolgreich=false mit Schritten — das hier ist
      // DB/Krypto: Einzelheiten (SQL, Parameter) nur ins Log, die Route ist öffentlich
      fastify.log.error({ err }, 'Setup unerwartet fehlgeschlagen')
      return reply.status(500).send(fehlerAntwort('Interner Serverfehler'))
    }
  })
}
