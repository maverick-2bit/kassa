/**
 * Signaturkarte (a.sign RK CHIP) als RKSV-Signaturerstellungseinheit — lokal, ohne Internet.
 *
 * Die Kassa läuft im Docker-Container, der USB-Kartenleser hängt am Kassen-PC. Dazwischen sitzt die
 * Kartenbrücke (ops/kartenbruecke): ein kleiner Dienst am PC, der nur die Leser auflistet und
 * APDUs durchreicht. Alles Fachliche — Kartentyp, Zertifikat, PIN-Schutz — passiert hier.
 *
 * Mehrere Kassen dürfen dieselbe Karte nutzen (eine Signaturerstellungseinheit je Unternehmer
 * genügt); die Brücke arbeitet die Kartensitzungen nacheinander ab.
 */

import { X509Certificate } from 'node:crypto'
import { jwsSigningInput } from '../../crypto/jws.js'
import type { SignaturEinheit, ZertifikatInfo } from '../signatur-einheit.js'
import {
  KartenError, findeKarte, findeKarten, leseZertifikat, signiereMitKarte,
  type ApduTransport, type GefundeneKarte, type KartenLeser, type SitzungsBedingung,
} from './rk-chip.js'

/** ZDA-Kennung von A-Trust (die Karte ist ein A-Trust-Zertifikat, offenes System) */
export const ATRUST_ZDA_ID = 'AT1'

export interface SignaturkartenConfig {
  transport: ApduTransport
  /** Karten-PIN; undefined = noch nicht hinterlegt (Signieren bricht ohne Kartenzugriff ab) */
  pin?: string | undefined
  /**
   * Zertifikat (DER), mit dem die Kasse eingerichtet ist. Gesetzt → vor jeder Signatur wird geprüft,
   * dass genau diese Karte steckt (eine andere Karte ergäbe Belege, die zu keinem gemeldeten
   * Zertifikat passen).
   */
  erwartetesZertifikat?: Buffer | undefined
}

export class SignaturkartenEinheit implements SignaturEinheit {
  readonly typ = 'atrust_chip' as const

  private zertCache: { der: Buffer; info: ZertifikatInfo } | null = null

  constructor(private readonly config: SignaturkartenConfig) {}

  zdaId(): Promise<string> {
    return Promise.resolve(ATRUST_ZDA_ID)
  }

  /** Gesteckte Karte: Typ, Leser, Zertifikat — ohne PIN */
  async karte(): Promise<{ karte: GefundeneKarte; zertifikatDer: Buffer }> {
    const karte = await findeKarte(this.config.transport)
    const zertifikatDer = await leseZertifikat(this.config.transport, karte)
    return { karte, zertifikatDer }
  }

  async zertifikat(): Promise<ZertifikatInfo> {
    if (this.zertCache) return this.zertCache.info
    const { zertifikatDer } = await this.karte()
    const info: ZertifikatInfo = {
      derBase64:       zertifikatDer.toString('base64'),
      seriennummerHex: new X509Certificate(zertifikatDer).serialNumber,
    }
    this.zertCache = { der: zertifikatDer, info }
    return info
  }

  async signiereBelegzeile(codeOhneSig: string): Promise<Buffer> {
    const pin = this.config.pin
    if (!pin) throw new KartenError('Für die Signaturkarte ist keine PIN hinterlegt', 'pin_fehlt')
    const input = jwsSigningInput(codeOhneSig)
    const erwartet = this.config.erwartetesZertifikat
    if (!erwartet) return signiereMitKarte(this.config.transport, await findeKarte(this.config.transport), input, pin)

    // Unter allen gesteckten Signaturkarten die eingerichtete: Die Identität prüft die Sitzung selbst,
    // VOR der PIN-Prüfung — eine fremde Karte bekommt die PIN nie zu sehen.
    for (const karte of await findeKarten(this.config.transport)) {
      try {
        return await signiereMitKarte(this.config.transport, karte, input, pin, erwartet)
      } catch (err) {
        if (err instanceof KartenError && err.art === 'falsche_karte') continue
        throw err
      }
    }
    throw new KartenError(
      'Im Kartenleser steckt eine andere Signaturkarte als die, mit der die Kasse eingerichtet ist',
      'falsche_karte',
    )
  }
}

// ---------------------------------------------------------------------------
// Kartenbrücke (HTTP) — der Transport im Betrieb
// ---------------------------------------------------------------------------

export interface KartenbrueckeConfig {
  /** z. B. http://host.docker.internal:47110 (aus dem Container) oder http://127.0.0.1:47110 */
  url: string
  /** Gemeinsamer Schlüssel (steht am PC in der Brücken-Konfiguration und in der .env der Kassa) */
  schluessel: string
  /** Zeitlimit je Anfrage in ms (Default 4000 — danach greift der SEE-Ausfallmodus) */
  timeoutMs?: number
}

export class KartenbrueckeTransport implements ApduTransport {
  private readonly timeoutMs: number

  constructor(private readonly config: KartenbrueckeConfig) {
    this.timeoutMs = config.timeoutMs ?? 4_000
  }

  private async anfrage(pfad: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await fetch(`${this.config.url.replace(/\/$/, '')}${pfad}`, {
        method:  body === undefined ? 'GET' : 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.schluessel}`,
          'Accept':        'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } catch (err) {
      const grund = err instanceof Error && err.name === 'AbortError'
        ? `keine Antwort nach ${this.timeoutMs} ms`
        : err instanceof Error ? err.message : String(err)
      throw new KartenError(`Kartenbrücke nicht erreichbar (${grund})`, 'nicht_erreichbar')
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text().catch(() => '')
    let json: Record<string, unknown> = {}
    try { json = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { /* unten */ }
    if (res.status === 401 || res.status === 403) {
      throw new KartenError('Die Kartenbrücke weist den Zugangsschlüssel der Kassa ab', 'zugang_abgewiesen')
    }
    if (!res.ok) {
      // Den Wortlaut der Brücke nur gefiltert weitergeben (lange Hex-Folgen könnten Befehlsinhalte sein)
      const roh = typeof json.fehler === 'string' ? json.fehler : ''
      const fehler = roh.replace(/[0-9A-Fa-f]{16,}/g, '…').slice(0, 120) || `HTTP ${res.status}`
      // 503: Leser/Karte gerade nicht da (vorübergehend); 500/408: Störung der Brücke (vorübergehend);
      // alles andere (400, 404, 405, 413): die Kassa spricht die Brücke falsch an — Konfiguration
      const art = res.status === 503 ? 'keine_karte'
        : res.status >= 500 || res.status === 408 ? 'karte_fehler'
        : 'bruecke_fehler'
      throw new KartenError(`Kartenbrücke: ${fehler}`, art)
    }
    return json
  }

  async leser(): Promise<KartenLeser[]> {
    const json = await this.anfrage('/leser')
    const liste = Array.isArray(json.leser) ? json.leser as unknown[] : null
    if (!liste) throw new KartenError('Kartenbrücke: Antwort ohne Leserliste', 'karte_fehler')
    return liste.flatMap((l): KartenLeser[] => {
      const o = l as { name?: unknown; atr?: unknown }
      return typeof o.name === 'string' ? [{ name: o.name, atr: typeof o.atr === 'string' && o.atr ? o.atr : null }] : []
    })
  }

  async sende(leser: string, apdus: Buffer[], bedingungen?: SitzungsBedingung[]): Promise<Buffer[]> {
    const json = await this.anfrage('/apdu', {
      leser,
      apdus: apdus.map(a => a.toString('hex')),
      ...(bedingungen?.length && { pruefe: bedingungen.map(b => ({ index: b.index, daten: b.daten.toString('hex') })) }),
    })
    const antworten = Array.isArray(json.antworten) ? json.antworten as unknown[] : null
    if (!antworten || antworten.some(a => typeof a !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(a))) {
      throw new KartenError('Kartenbrücke: unlesbare Antwort', 'karte_fehler')
    }
    if (json.abbruch === 'bedingung') {
      throw new KartenError('Im Kartenleser steckt eine andere Signaturkarte als die eingerichtete', 'falsche_karte')
    }
    if (json.abbruch === 'pin_bereits_abgelehnt') {
      throw new KartenError(
        'Diese PIN hat die Karte schon einmal abgelehnt — die Kartenbrücke schickt sie nicht noch einmal',
        'pin_bereits_abgelehnt',
      )
    }
    return (antworten as string[]).map(a => Buffer.from(a, 'hex'))
  }
}
