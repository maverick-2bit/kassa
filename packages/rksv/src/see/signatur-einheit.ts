/**
 * SignaturEinheit — Abstraktion über die RKSV-Signaturerstellungseinheit.
 *
 * Implementierungen:
 *   - SoftwareSignaturEinheit  (Dev/Test: lokaler ECDSA-Key, ZDA 'AT0')
 *   - ATrustHsmEinheit         (Produktion: a.sign RK HSM REST-API, ZDA 'AT1')
 *   - (a.sign RK CHIP / PKCS#11 später über dasselbe Interface andockbar)
 *
 * Die Einheit signiert die BELEGZEILE (maschinenlesbarer Code OHNE Signatur);
 * der JWS-Signing-Input (fixer Header {"alg":"ES256"}) entsteht je nach
 * Implementierung lokal oder beim Anbieter.
 */

import { X509Certificate } from 'node:crypto'
import type { SEEConfig } from '../types.js'
import { jwsSigningInput } from '../beleg.js'
import { signiereRoh } from '../see.js'

export interface ZertifikatInfo {
  /** base64-Standard-kodiertes DER-Zertifikat */
  derBase64: string
  /** Seriennummer hexadezimal (wie im QR-Code) */
  seriennummerHex: string
}

export interface SignaturEinheit {
  readonly typ: 'software' | 'atrust_hsm'
  /** ZDA-Kennzeichen für den QR-Prefix (_R1-<ZDA>_): AT0/AT1/… */
  zdaId(): Promise<string>
  /** Signaturzertifikat der Einheit */
  zertifikat(): Promise<ZertifikatInfo>
  /**
   * Signiert die Belegzeile (Code ohne Signatur) als RKSV-JWS.
   * @returns 64-Byte-P1363-Rohsignatur (r ‖ s)
   */
  signiereBelegzeile(codeOhneSig: string): Promise<Buffer>
}

// ---------------------------------------------------------------------------
// Software-SEE (Dev/Test) — lokaler Schlüssel, selbstsigniertes Zertifikat
// ---------------------------------------------------------------------------

export class SoftwareSignaturEinheit implements SignaturEinheit {
  readonly typ = 'software' as const

  constructor(private readonly see: Pick<SEEConfig, 'privateKeyDER' | 'zertifikatDER' | 'zdaId'>) {}

  zdaId(): Promise<string> {
    return Promise.resolve(this.see.zdaId)
  }

  zertifikat(): Promise<ZertifikatInfo> {
    const cert = new X509Certificate(this.see.zertifikatDER)
    return Promise.resolve({
      derBase64:       this.see.zertifikatDER.toString('base64'),
      seriennummerHex: cert.serialNumber,
    })
  }

  signiereBelegzeile(codeOhneSig: string): Promise<Buffer> {
    return Promise.resolve(signiereRoh(jwsSigningInput(codeOhneSig), this.see))
  }
}

// ---------------------------------------------------------------------------
// A-Trust a.sign RK HSM (REST) — https://github.com/A-Trust/RKSV
// ---------------------------------------------------------------------------

export interface ATrustHsmConfig {
  /** z. B. https://hs-abnahme.a-trust.at/RegistrierkasseMobile/v2 (Abnahme) */
  basisUrl: string
  /** A-Trust-Benutzer, z. B. u123456789 */
  benutzer: string
  passwort: string
  /** HTTP-Timeout in ms (Default 2500 — danach greift der SEE-Ausfallmodus) */
  timeoutMs?: number
}

export const ATRUST_ABNAHME_BASIS_URL = 'https://hs-abnahme.a-trust.at/RegistrierkasseMobile/v2'
export const ATRUST_PRODUKTION_BASIS_URL = 'https://hs.a-trust.at/RegistrierkasseMobile/v2'

export class ATrustHsmError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
  }
}

export class ATrustHsmEinheit implements SignaturEinheit {
  readonly typ = 'atrust_hsm' as const

  private readonly timeoutMs: number
  private zertCache: ZertifikatInfo | null = null
  private zdaCache: string | null = null

  constructor(private readonly config: ATrustHsmConfig) {
    this.timeoutMs = config.timeoutMs ?? 2_500
  }

  private url(pfad: string): string {
    return `${this.config.basisUrl.replace(/\/$/, '')}/${encodeURIComponent(this.config.benutzer)}${pfad}`
  }

  private async request(pfad: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url(pfad), {
        method:  body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Ohne User-Agent blockt die A-Trust-WAF POST-Requests (HTTP 403)
          'User-Agent':   'kassa-rksv/1.0',
          'Accept':       'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal:  controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new ATrustHsmError(`A-Trust ${pfad} → HTTP ${res.status}: ${text.slice(0, 200)}`, res.status)
      }
      return JSON.parse(text) as Record<string, unknown>
    } catch (err) {
      if (err instanceof ATrustHsmError) throw err
      const grund = err instanceof Error && err.name === 'AbortError'
        ? `Timeout nach ${this.timeoutMs} ms`
        : err instanceof Error ? err.message : String(err)
      throw new ATrustHsmError(`A-Trust ${pfad} nicht erreichbar: ${grund}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async zdaId(): Promise<string> {
    if (this.zdaCache) return this.zdaCache
    const res = await this.request('/ZDA')
    const zda = res.zdaid
    if (typeof zda !== 'string' || zda.length === 0) {
      throw new ATrustHsmError('A-Trust /ZDA: Feld "zdaid" fehlt in der Antwort')
    }
    this.zdaCache = zda
    return zda
  }

  async zertifikat(): Promise<ZertifikatInfo> {
    if (this.zertCache) return this.zertCache
    const res = await this.request('/Certificate')
    const der = res.Signaturzertifikat
    const sn  = res.ZertifikatsseriennummerHex
    if (typeof der !== 'string' || der.length === 0) {
      throw new ATrustHsmError('A-Trust /Certificate: Feld "Signaturzertifikat" fehlt')
    }
    const info: ZertifikatInfo = {
      derBase64:       der,
      seriennummerHex: typeof sn === 'string' && sn.length > 0
        ? sn
        : ableiteSeriennummer(der),
    }
    this.zertCache = info
    return info
  }

  async signiereBelegzeile(codeOhneSig: string): Promise<Buffer> {
    const res = await this.request('/Sign/JWS', {
      password:    this.config.passwort,
      jws_payload: codeOhneSig,
    })
    const result = res.result
    if (typeof result !== 'string' || result.length === 0) {
      throw new ATrustHsmError('A-Trust /Sign/JWS: Feld "result" fehlt in der Antwort')
    }
    // Tolerant: "result" ist entweder die JWS-Signatur (base64url) oder die
    // komplette JWS-Compact-Repräsentation (header.payload.signature).
    const sigTeil = result.includes('.') ? result.split('.')[2] ?? '' : result
    const roh = Buffer.from(sigTeil, 'base64url')
    if (roh.length !== 64) {
      throw new ATrustHsmError(`A-Trust /Sign/JWS: unerwartete Signaturlänge ${roh.length} (erwartet 64 Byte P1363)`)
    }
    return roh
  }
}

/** Seriennummer aus einem base64-DER-Zertifikat ableiten (Fallback). */
function ableiteSeriennummer(derBase64: string): string {
  return new X509Certificate(Buffer.from(derBase64, 'base64')).serialNumber
}
