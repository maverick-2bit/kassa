/**
 * HTTPS im LAN (Docker-Dienst „lan-https", ops/caddy/Caddyfile.lan) — ist er auf dieser
 * Box aktiv, und für welche IP gilt sein Zertifikat?
 *
 * Der Dienst beantwortet /kassa-lan.json auf allen Eingängen. Gefragt wird so, dass der
 * Browser die Antwort auch sicher bekommt:
 *   - Kasse über http offen (Normalfall, auch http://localhost am Kassen-PC) → die
 *     Einrichtungsseite http://<Host>:9079 (antwortet mit CORS *).
 *   - Kasse über https im LAN offen → derselbe Ursprung (http wäre gemischter Inhalt).
 *   - Kasse unter https mit Domainnamen (Proxy-Modus) → nicht fragen.
 * Keine Antwort (Dienst aus, Dev-Server, Zeitüberschreitung) = nicht aktiv.
 */

import { LAN_HTTPS_PORTS, istLanHost } from './geraeteAdressen'

export interface LanHttpsInfo {
  /** IPv4, für die das Zertifikat ausgestellt ist (KASSA_LAN_IP) */
  ip: string
}

interface Ort { protocol: string; hostname: string; port: string }

const GESICHERTE_PORTS: readonly number[] = [
  LAN_HTTPS_PORTS.kasse, LAN_HTTPS_PORTS.kds, LAN_HTTPS_PORTS.kellner, LAN_HTTPS_PORTS.terminal, LAN_HTTPS_PORTS.einlass,
]

/** Wo nach dem Dienst gefragt wird — null = gar nicht fragen */
export function lanInfoAdresse(ort: Ort): string | null {
  if (ort.protocol === 'https:') {
    return istLanHost(ort.hostname) && GESICHERTE_PORTS.includes(Number(ort.port)) ? '/kassa-lan.json' : null
  }
  if (ort.protocol !== 'http:' || !ort.hostname) return null
  return `http://${ort.hostname}:${LAN_HTTPS_PORTS.einrichtung}/kassa-lan.json`
}

/** Antwort prüfen — nur eine plausible IPv4 zählt */
export function leseLanInfo(daten: unknown): LanHttpsInfo | null {
  if (!daten || typeof daten !== 'object') return null
  const ip = (daten as { ip?: unknown }).ip
  if (typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null
  return { ip }
}

/** Adresse der Einrichtungsseite für Handys/Tablets (Zertifikat + Anleitung) */
export function einrichtungsAdresse(ip: string): string {
  return `http://${ip}:${LAN_HTTPS_PORTS.einrichtung}/`
}

export async function ladeLanHttpsInfo(ort: Ort = window.location, timeoutMs = 2500): Promise<LanHttpsInfo | null> {
  const url = lanInfoAdresse(ort)
  if (!url) return null
  const abbruch = new AbortController()
  const timer = setTimeout(() => abbruch.abort(), timeoutMs)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: abbruch.signal })
    if (!res.ok) return null
    return leseLanInfo(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
