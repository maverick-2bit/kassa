/**
 * Simulierte a.sign RK CHIP (ACOS-ID 4.1) auf APDU-Ebene — für Tests und Vorführungen ohne Karte.
 *
 * Verhält sich wie die echte Karte: Dateistruktur MF/DF 01/EF C0 00, PIN-Prüfung mit
 * Fehlbedienungszähler (63Cx, gesperrt 6983), Signieren nur direkt nach erfolgreicher
 * PIN-Prüfung (sonst 6982), Signatur 64 Byte r‖s über den übergebenen SHA-256-Hash.
 * Zusätzlich lassen sich Ausfälle stellen: Karte gezogen, Brücke weg. Der Simulator spielt auch die Rolle
 * der Kartenbrücke: Bedingung je Sitzung und PIN-Wächter (eine abgelehnte PIN-Prüfung geht nie wieder an
 * die Karte) wie in ops/kartenbruecke/kartenbruecke.ps1.
 *
 * Die Karte rechnet ECDSA über einen fertigen Hash; Node kann das nicht direkt (crypto.sign
 * hasht selbst) — daher hier eine kleine P-256-Rechnung mit BigInt. Nur für den Simulator.
 */

import { createHash, createPrivateKey, randomBytes } from 'node:crypto'
import { generateSEE } from '../../see.js'
import { KartenError, pinBlockFormat2, type ApduTransport, type KartenLeser, type SitzungsBedingung } from './rk-chip.js'

export const SIMULATOR_ATR = '3BDF97008131FE4680319052410464050401AC73D622C0F9'

// ---------------------------------------------------------------------------
// P-256 (secp256r1) — nur was ECDSA-Signieren braucht
// ---------------------------------------------------------------------------

const P  = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const N  = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m

function inv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [mod(a, m), m]
  let [s0, s1] = [1n, 0n]
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1]
  }
  return mod(s0, m)
}

type Punkt = { x: bigint; y: bigint } | null

function addiere(p1: Punkt, p2: Punkt): Punkt {
  if (!p1) return p2
  if (!p2) return p1
  if (p1.x === p2.x) {
    if (mod(p1.y + p2.y, P) === 0n) return null
    const l = mod(3n * p1.x * p1.x - 3n, P) * inv(2n * p1.y, P) % P
    const x = mod(l * l - 2n * p1.x, P)
    return { x, y: mod(l * (p1.x - x) - p1.y, P) }
  }
  const l = mod(p2.y - p1.y, P) * inv(p2.x - p1.x, P) % P
  const x = mod(l * l - p1.x - p2.x, P)
  return { x, y: mod(l * (p1.x - x) - p1.y, P) }
}

function multipliziere(k: bigint, punkt: Punkt): Punkt {
  let ergebnis: Punkt = null
  let summand = punkt
  while (k > 0n) {
    if (k & 1n) ergebnis = addiere(ergebnis, summand)
    summand = addiere(summand, summand)
    k >>= 1n
  }
  return ergebnis
}

const zuZahl = (b: Buffer): bigint => BigInt(`0x${b.toString('hex') || '0'}`)
const zuBytes = (z: bigint): Buffer => Buffer.from(z.toString(16).padStart(64, '0'), 'hex')

/** ECDSA-Signatur über einen fertigen 32-Byte-Hash → r‖s */
function signiereHash(d: bigint, hash: Buffer): Buffer {
  const e = zuZahl(hash)
  for (;;) {
    const k = mod(zuZahl(randomBytes(32)), N)
    if (k === 0n) continue
    const R = multipliziere(k, { x: GX, y: GY })
    const r = R ? mod(R.x, N) : 0n
    if (r === 0n) continue
    const s = mod(inv(k, N) * (e + r * d), N)
    if (s === 0n) continue
    return Buffer.concat([zuBytes(r), zuBytes(s)])
  }
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export interface SimulatorOptionen {
  /** Richtige PIN der Karte (Default 123456) */
  pin?: string
  /** Fehlbedienungszähler (Default 3) */
  maxVersuche?: number
  leserName?: string
  /** Zusätzliche Leser (z. B. Windows Hello mit eigener Karte) — werden übergangen */
  weitereLeser?: KartenLeser[]
  /** Kartenseriennummer im Zertifikat (Default zufällig) */
  firmenname?: string
  uid?: string
  /** Höchstens so viele Byte je READ BINARY (Default 256) — manche Leser liefern kürzere Blöcke */
  blockGroesse?: number
  /** Antwort auf jede PIN-Prüfung erzwingen (z. B. '6984'), um unklare Antworten zu testen */
  verifyAntwort?: string
}

export class SimulierteSignaturkarte implements ApduTransport {
  /** Karte steckt im Leser */
  gesteckt = true
  /** Kartenbrücke antwortet (false = Dienst weg / PC-Leser abgesteckt) */
  erreichbar = true
  /** Verbleibende PIN-Versuche */
  restVersuche: number
  /** Zähler zum Nachprüfen in Tests */
  signaturen = 0
  pinPruefungen = 0
  /** Wie oft der PIN-Wächter eine schon abgelehnte PIN-Prüfung zurückgehalten hat */
  zurueckgehalten = 0

  /** PIN-Wächter der Brücke: SHA-256 abgelehnter PIN-Prüfungen */
  private readonly abgelehnt = new Set<string>()

  private auswahl: 'keine' | 'MF' | 'DF' | 'EF' = 'keine'
  private pinOk = false

  private constructor(
    readonly zertifikatDer: Buffer,
    private readonly d: bigint,
    private readonly opts: Required<Pick<SimulatorOptionen, 'pin' | 'maxVersuche' | 'leserName'>> & SimulatorOptionen,
  ) {
    this.restVersuche = opts.maxVersuche
  }

  static async erzeuge(opts: SimulatorOptionen = {}): Promise<SimulierteSignaturkarte> {
    const see = await generateSEE({
      kassenId:   'SIM-KARTE',
      uid:        opts.uid ?? 'ATU00000000',
      firmenname: opts.firmenname ?? 'Simulierte Signaturkarte',
    })
    const jwk = createPrivateKey({ key: see.privateKeyDER, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' })
    const d = zuZahl(Buffer.from(jwk.d!, 'base64url'))
    return new SimulierteSignaturkarte(see.zertifikatDER, d, {
      ...opts,
      pin:         opts.pin ?? '123456',
      maxVersuche: opts.maxVersuche ?? 3,
      leserName:   opts.leserName ?? 'Simulierter Kartenleser 0',
    })
  }

  get leserName(): string { return this.opts.leserName }

  leser(): Promise<KartenLeser[]> {
    if (!this.erreichbar) return Promise.reject(new KartenError('Kartenbrücke nicht erreichbar (Simulator)', 'nicht_erreichbar'))
    return Promise.resolve([
      ...(this.opts.weitereLeser ?? []),
      { name: this.opts.leserName, atr: this.gesteckt ? SIMULATOR_ATR : null },
    ])
  }

  sende(leser: string, apdus: Buffer[], bedingungen?: SitzungsBedingung[]): Promise<Buffer[]> {
    if (!this.erreichbar) return Promise.reject(new KartenError('Kartenbrücke nicht erreichbar (Simulator)', 'nicht_erreichbar'))
    if (leser !== this.opts.leserName || !this.gesteckt) {
      return Promise.reject(new KartenError(`Keine Karte im Leser ${leser}`, 'keine_karte'))
    }
    // Jede Sitzung beginnt frisch (die Brücke verbindet je Anfrage neu)
    this.auswahl = 'keine'
    this.pinOk = false
    const antworten: Buffer[] = []
    for (let i = 0; i < apdus.length; i++) {
      const apdu = apdus[i]!
      const pinHash = apdu.length > 5 && apdu[1] === 0x20 ? createHash('sha256').update(apdu).digest('hex') : null
      if (pinHash && this.abgelehnt.has(pinHash)) {
        this.zurueckgehalten++
        return Promise.reject(new KartenError('Diese PIN hat die Karte schon einmal abgelehnt (Simulator)', 'pin_bereits_abgelehnt'))
      }
      const a = this.verarbeite(apdu)
      antworten.push(a)
      const sw = a.subarray(a.length - 2).toString('hex').toUpperCase()
      if (pinHash && sw !== '9000') this.abgelehnt.add(pinHash)
      if (sw !== '9000' && sw !== '6282') break
      const bedingung = bedingungen?.find(b => b.index === i)
      if (bedingung && !a.subarray(0, a.length - 2).equals(bedingung.daten)) {
        return Promise.reject(new KartenError('Andere Signaturkarte im Leser (Simulator)', 'falsche_karte'))
      }
    }
    return Promise.resolve(antworten)
  }

  private verarbeite(apdu: Buffer): Buffer {
    const sw = (s: string, daten: Buffer = Buffer.alloc(0)) => Buffer.concat([daten, Buffer.from(s, 'hex')])
    const kopf = apdu.subarray(0, 4).toString('hex').toUpperCase()
    const daten = apdu.length > 5 ? apdu.subarray(5, 5 + apdu[4]!) : Buffer.alloc(0)

    if (kopf === '00A4000C') {
      const fid = daten.toString('hex').toUpperCase()
      if (fid === '3F00') { this.auswahl = 'MF'; return sw('9000') }
      if (fid === 'DF01' && this.auswahl !== 'keine') { this.auswahl = 'DF'; return sw('9000') }
      if (fid === 'C000' && (this.auswahl === 'DF' || this.auswahl === 'EF')) { this.auswahl = 'EF'; return sw('9000') }
      return sw('6A82')
    }
    if (apdu[0] === 0x00 && apdu[1] === 0xb0) {
      if (this.auswahl !== 'EF') return sw('6986')
      const offset = ((apdu[2]! & 0x7f) << 8) | apdu[3]!
      if (offset >= this.zertifikatDer.length) return sw('6B00')
      const le = Math.min(apdu[4] === 0 ? 256 : apdu[4]!, this.opts.blockGroesse ?? 256)
      return sw('9000', this.zertifikatDer.subarray(offset, offset + le))
    }
    if (kopf.startsWith('002000')) {
      this.pinPruefungen++
      if (this.auswahl !== 'DF' && this.auswahl !== 'EF') return sw('6982')
      if (apdu[3] !== 0x8a) return sw('6A88')
      if (this.opts.verifyAntwort) return sw(this.opts.verifyAntwort)
      if (this.restVersuche === 0) return sw('6983')
      if (daten.equals(pinBlockFormat2(this.opts.pin))) {
        this.restVersuche = this.opts.maxVersuche
        this.pinOk = true
        return sw('9000')
      }
      this.restVersuche--
      this.pinOk = false
      return sw(`63C${this.restVersuche.toString(16).toUpperCase()}`)
    }
    if (kopf === '002A9E9A') {
      if (!this.pinOk) return sw('6982')
      if (daten.length !== 32) return sw('6700')
      this.pinOk = false
      this.signaturen++
      return sw('9000', signiereHash(this.d, daten))
    }
    return sw('6D00')
  }
}
