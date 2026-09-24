/**
 * Rate-Limit-Schlüssel — je echtem Client, nicht per Header fälschbar.
 *
 * Das Backend hängt nie direkt am Netz: jede Anfrage kommt über den nginx einer
 * App, als Absender (`request.ip`) sieht es nur diesen. Mit dem Standard-
 * Schlüssel teilten sich deshalb ALLE Kellner-Handys (alle Kassen, alle Gäste …)
 * einer App einen einzigen Zähler.
 *
 *  - Angemeldete Clients (Kasse, Kellner, KDS-Bildschirm, Einlass-Scanner)
 *    zählen je Anmeldung. Der Token wird hier auf seine Signatur geprüft — ein
 *    gefälschter oder abgelaufener zählt als anonym. Nur so lassen sich die
 *    Geräte überall trennen: Docker Desktop (Windows/macOS) liefert den Apps für
 *    JEDEN LAN-Client dieselbe Gateway-Adresse, die Client-IP taugt dort nicht.
 *  - Alle anderen (Login, Gast-Bestellung, SB-Terminal, Ticketseite …) zählen je
 *    Client-IP UND App-nginx. Die Client-IP setzt der App-nginx in X-Real-IP
 *    (siehe getClientIp); der nginx-Absender hält die Apps auch dort getrennt,
 *    wo die Client-IP für alle gleich ist (Docker Desktop, s. o.).
 */

import type { FastifyRequest } from 'fastify'
import type { JwtPayload } from './jwt.js'
import { getClientIp } from '../services/audit.service.js'

/** Token aus dem Authorization-Header — oder aus ?token=, weil EventSource (SSE) keine Header senden kann. */
function tokenAus(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header)?.[1] : undefined
  if (bearer) return bearer
  const token = (request.query as { token?: unknown } | undefined)?.token
  return typeof token === 'string' && token ? token : undefined
}

/**
 * Anmeldung hinter der Anfrage, nur bei gültiger Signatur — sonst null.
 * Ein ausgestellter Token = ein Zähler (Mandant + Benutzer/Gerät + Ausstellzeit):
 * zwei Kassen mit demselben Benutzer zählen getrennt, Kopien DESSELBEN
 * Geräte-Tokens (ein KDS-QR auf zwei Bildschirmen) gemeinsam.
 */
export function anmeldungsSchluessel(request: FastifyRequest): string | null {
  const token = tokenAus(request)
  if (!token) return null
  try {
    const p = request.server.jwt.verify<JwtPayload & { iat?: number }>(token)
    return `${p.mandantId}:${p.sub}:${p.iat ?? 0}`
  } catch {
    return null
  }
}

/** Schlüssel je Client-IP und App-nginx — für alles ohne Anmeldung und für die Login-Bremse. */
export function ipSchluessel(request: FastifyRequest): string {
  return `ip:${getClientIp(request)}|${request.ip}`
}

/** Globaler Schlüssel: je Anmeldung, sonst je Client-IP (siehe oben). */
export function rateLimitSchluessel(request: FastifyRequest): string {
  const anmeldung = anmeldungsSchluessel(request)
  return anmeldung ? `anmeldung:${anmeldung}` : ipSchluessel(request)
}
