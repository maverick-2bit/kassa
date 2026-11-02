/**
 * Öffentliche Adresse des Kassa-Frontends — für Links in E-Mails an Gäste (Reservierung stornieren …).
 *
 * Kommt aus der KONFIGURATION: `CORS_ORIGIN` ist laut Installationsanleitung „die URL, unter der das
 * Kassen-Frontend erreichbar ist" (LAN: http://192.168.1.50, Proxy: https://kasse.<domain>); bei
 * mehreren Einträgen gilt der erste. NIE aus den Anfrage-Headern (Host / X-Forwarded-Host): die
 * Online-Buchung ist öffentlich, ein Angreifer schickte sonst eine Mail über den SMTP-Zugang des
 * Betriebs, deren „Reservierung stornieren"-Knopf auf seine eigene Seite zeigt.
 *
 * Gibt es keine brauchbare Adresse (CORS_ORIGIN = `*` oder kein http(s)-Eintrag), liefert die Funktion
 * null — die Mail kommt dann ohne Link, statt mit einem geratenen.
 */

import type { Config } from '../config.js'

export function oeffentlicheBasisUrl(config: Pick<Config, 'CORS_ORIGIN'>): string | null {
  for (const roh of config.CORS_ORIGIN.split(',')) {
    const eintrag = roh.trim()
    if (!eintrag || eintrag === '*') continue
    try {
      const url = new URL(eintrag)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    } catch {
      /* kein gültiger Eintrag — der nächste */
    }
  }
  return null
}
