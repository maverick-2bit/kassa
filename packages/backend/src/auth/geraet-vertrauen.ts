/**
 * Geräte-Vertrauen für die PIN-Bremse (services/pin-bremse.ts).
 *
 * Die Fehlversuchs-Sperre für fremde Geräte gilt je Kasse. Ohne Unterscheidung
 * könnte ein Störer im WLAN mit ein paar falschen PINs pro Stunde eine ganze
 * Kasse gesperrt halten — und die Client-IP taugt zur Trennung nicht (Docker
 * Desktop liefert für JEDEN LAN-Client dieselbe Gateway-Adresse). Deshalb
 * bekommt ein Gerät nach einer erfolgreichen Anmeldung dieses Merkmal: wer es
 * vorweist, zählt Fehlversuche in einem eigenen Topf.
 *
 * Das Merkmal ist KEIN Anmelde-Token: eigener, aus JWT_SECRET abgeleiteter
 * Schlüssel und zwei statt drei Teile — @fastify/jwt kann es weder lesen noch
 * versehentlich als gültige Anmeldung akzeptieren. Es beweist nur: „Auf diesem
 * Gerät hat sich schon jemand mit gültigen Zugangsdaten angemeldet." Gestohlen
 * bringt es deshalb wenig — einen eigenen Fehlversuchs-Topf, keinen Zugang.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** Ungenutzte Geräte fallen nach so vielen Tagen auf „fremd" zurück; jede Anmeldung verlängert. */
export const GERAET_VERTRAUEN_TAGE = 180

const MAX_LAENGE = 512
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface GeraetVertrauen {
  geraetId:  string
  mandantId: string
}

export interface GeraetVertrauenSigner {
  /**
   * Stellt das Merkmal aus bzw. verlängert es. Mit `geraetId` (aus dem bisher
   * vorgelegten Merkmal) bleibt es dasselbe Gerät — sonst könnte man sich per
   * erneuter Anmeldung einen frischen Fehlversuchs-Topf verschaffen.
   */
  ausstellen(mandantId: string, geraetId?: string): string
  /** Prüft ein vorgelegtes Merkmal: null bei fehlend, gefälscht, abgelaufen oder fremdem Mandanten. */
  pruefen(token: unknown, mandantId: string): GeraetVertrauen | null
}

export function erstelleGeraetVertrauen(
  jwtSecret: string,
  jetzt: () => number = Date.now,
): GeraetVertrauenSigner {
  const schluessel = createHmac('sha256', jwtSecret).update('kassa/pin-geraet-vertrauen/v1').digest()
  const signiere = (rumpf: string) => createHmac('sha256', schluessel).update(rumpf).digest('base64url')

  return {
    ausstellen(mandantId, geraetId = randomUUID()) {
      const iat = Math.floor(jetzt() / 1000)
      const rumpf = Buffer.from(JSON.stringify({
        v: 1, g: geraetId, m: mandantId, iat, exp: iat + GERAET_VERTRAUEN_TAGE * 86_400,
      })).toString('base64url')
      return `${rumpf}.${signiere(rumpf)}`
    },

    pruefen(token, mandantId) {
      if (typeof token !== 'string' || token.length > MAX_LAENGE) return null
      const teile = token.split('.')
      if (teile.length !== 2) return null
      const [rumpf, signatur] = teile as [string, string]

      const erwartet = Buffer.from(signiere(rumpf))
      const erhalten = Buffer.from(signatur)
      if (erhalten.length !== erwartet.length || !timingSafeEqual(erhalten, erwartet)) return null

      let p: { v?: unknown; g?: unknown; m?: unknown; exp?: unknown }
      try {
        p = JSON.parse(Buffer.from(rumpf, 'base64url').toString('utf8')) as typeof p
      } catch {
        return null
      }
      if (p.v !== 1 || typeof p.g !== 'string' || !UUID_REGEX.test(p.g)) return null
      if (p.m !== mandantId) return null
      if (typeof p.exp !== 'number' || p.exp * 1000 <= jetzt()) return null
      return { geraetId: p.g, mandantId: p.m }
    },
  }
}
