/**
 * A-Trust a.sign RK CHIP — die RKSV-Signaturkarte im Kartenleser, angesprochen über APDUs.
 *
 * Befehlsfolgen nach dem offiziellen A-Trust-Beispielcode (github.com/A-Trust/RKSV,
 * „a.sign RK CHIP/APDU Examples“, MIT-Lizenz, Copyright (c) 2021 A-Trust GmbH) und dessen
 * Developer Manual (APDU_API.pdf v0.3):
 *
 *   Zertifikat:  SELECT MF · SELECT DF 01 · SELECT EF C0 00 · READ BINARY (je 256 Byte)
 *   Signieren:   SELECT MF · SELECT DF 01 · VERIFY (PIN-Block Format 2) ·
 *                PSO COMPUTE DIGITAL SIGNATURE über den rohen SHA-256-Hash (32 Byte)
 *                → 64 Byte r‖s (IEEE P1363) — genau das Format der RKSV-Signatur (ES256).
 *
 * Unterstützt: ACOS-ID (4.1 sowie die Vorgänger V2/2.1) und CardOS 5.3 — alle mit derselben
 * Dateistruktur, nur die PIN-Referenz im VERIFY unterscheidet sich. Die erste Kartengeneration
 * (ACOS, 2016) fehlt bewusst: ihre Zertifikate (5 Jahre) sind längst abgelaufen.
 *
 * PIN-SCHUTZ: Eine falsche PIN zählt auf der Karte den Fehlbedienungszähler herunter; nach
 * wenigen Fehlversuchen ist sie gesperrt (für immer — RKSV-Karten haben keine PUK für den
 * Kassenbetrieb). Darum gilt hier: bei „PIN falsch“ (63Cx) SOFORT abbrechen, nie automatisch
 * erneut versuchen. Der Aufrufer (Backend) merkt sich das dauerhaft und signiert erst wieder,
 * wenn jemand eine andere PIN hinterlegt.
 */

import { createHash, X509Certificate } from 'node:crypto'

// ---------------------------------------------------------------------------
// Transport: eine exklusive Kartensitzung, die eine Folge von APDUs abarbeitet
// ---------------------------------------------------------------------------

export interface KartenLeser {
  name: string
  /** ATR der gesteckten Karte (Hex, Großbuchstaben); null = kein Karte im Leser */
  atr:  string | null
}

/**
 * Übertragungsweg zur Karte — z. B. die Kartenbrücke am Kassen-PC (HTTP) oder ein Simulator.
 * `sende` arbeitet die APDUs in EINER exklusiven Kartensitzung der Reihe nach ab und hört nach
 * der ersten Antwort auf, deren Statuswort weder 9000 noch 6282 (Dateiende) ist. Jede Antwort ist
 * Daten ‖ SW1 SW2.
 */
export interface ApduTransport {
  leser(): Promise<KartenLeser[]>
  sende(leser: string, apdus: Buffer[]): Promise<Buffer[]>
}

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

export type KartenFehlerArt =
  /** Brücke/Leser nicht erreichbar oder Zeitlimit — vorübergehend (SEE-Ausfall) */
  | 'nicht_erreichbar'
  /** Kein Leser oder keine Signaturkarte gesteckt — vorübergehend (SEE-Ausfall) */
  | 'keine_karte'
  /** Karte antwortet mit einem unerwarteten Statuswort — vorübergehend (SEE-Ausfall) */
  | 'karte_fehler'
  /** Karte unbekannt oder nicht die eingerichtete (anderes Zertifikat) */
  | 'falsche_karte'
  /** Die Kartenbrücke weist den Zugangsschlüssel der Kassa ab */
  | 'zugang_abgewiesen'
  /** PIN falsch — `restVersuche` sagt, wie viele noch bleiben */
  | 'pin_falsch'
  /** PIN gesperrt (Fehlbedienungszähler 0) — die Karte signiert nie mehr */
  | 'pin_gesperrt'
  /** PIN fehlt oder ist der Kassa schon als falsch bekannt — es wurde gar nicht erst versucht */
  | 'pin_fehlt'

export class KartenError extends Error {
  constructor(
    message: string,
    public readonly art: KartenFehlerArt,
    public readonly restVersuche?: number,
  ) {
    super(message)
    this.name = 'KartenError'
  }

  /** Behebt sich das von selbst (Karte wieder gesteckt, Brücke wieder da)? */
  get vorlaeufig(): boolean {
    return this.art === 'nicht_erreichbar' || this.art === 'keine_karte' || this.art === 'karte_fehler'
  }
}

// ---------------------------------------------------------------------------
// Kartentypen (ATR-Präfixe aus dem A-Trust-Beispielcode)
// ---------------------------------------------------------------------------

export interface KartenTyp {
  bezeichnung: string
  /** PIN-Referenz im VERIFY (P2) */
  pinReferenz: number
  /**
   * true = Kartengeneration, die laut A-Trust/WKO seit 07.06.2025 nicht mehr für neue Registrierungen
   * zertifiziert ist und bis spätestens Mai 2027 getauscht werden muss
   */
  tauschpflichtig: boolean
}

const KARTEN: { praefix: string; typ: KartenTyp }[] = [
  { praefix: '3BDF97008131FE4680319052410464050401AC73D622C0F9', typ: { bezeichnung: 'A-Trust ACOS-ID 4.1', pinReferenz: 0x8a, tauschpflichtig: false } },
  { praefix: '3BDF96FF910131FE4680319052410264050200AC73D622C017', typ: { bezeichnung: 'A-Trust ACOS-ID V2', pinReferenz: 0x8a, tauschpflichtig: true } },
  { praefix: '3BDF18FF910131FE4680319052410264050200AC73D622C099', typ: { bezeichnung: 'A-Trust ACOS-ID V2', pinReferenz: 0x8a, tauschpflichtig: true } },
  { praefix: '3BDF97008131FE4680319052410364050201AC73D622C0F8', typ: { bezeichnung: 'A-Trust ACOS-ID 2.1', pinReferenz: 0x8a, tauschpflichtig: true } },
  { praefix: '3BDF18008131FE588031B05202046405C903AC73B7B1D422', typ: { bezeichnung: 'A-Trust CardOS 5.3', pinReferenz: 0x81, tauschpflichtig: true } },
  { praefix: '3BDF18008131FE588031905241016405C903AC73B7B1D444', typ: { bezeichnung: 'A-Trust CardOS 5.3', pinReferenz: 0x81, tauschpflichtig: true } },
]

/** Kartentyp zum ATR, null = keine bekannte RKSV-Signaturkarte */
export function erkenneKartentyp(atrHex: string): KartenTyp | null {
  const atr = atrHex.replace(/\s+/g, '').toUpperCase()
  return KARTEN.find(k => atr.startsWith(k.praefix))?.typ ?? null
}

// ---------------------------------------------------------------------------
// APDUs
// ---------------------------------------------------------------------------

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex')

export const APDU = {
  selectMf:          hex('00A4000C02 3F00'),
  selectDfSig:       hex('00A4000C02 DF01'),
  selectEfZert:      hex('00A4000C02 C000'),
  leseBinaer: (offset: number): Buffer => Buffer.from([0x00, 0xb0, (offset >> 8) & 0x7f, offset & 0xff, 0x00]),
  verify:     (pinReferenz: number, pinBlock: Buffer): Buffer =>
    Buffer.concat([Buffer.from([0x00, 0x20, 0x00, pinReferenz, pinBlock.length]), pinBlock]),
  signiere:   (hash: Buffer): Buffer => Buffer.concat([hex('002A9E9A20'), hash, Buffer.from([0x40])]),
} as const

/**
 * PIN-Block Format 2 (ISO 9564): 0x2N, BCD-Ziffern, mit F aufgefüllt auf 8 Byte.
 * „123456“ → 26 12 34 56 FF FF FF FF.
 */
export function pinBlockFormat2(pin: string): Buffer {
  if (!/^\d{4,12}$/.test(pin)) throw new KartenError('Die Karten-PIN muss aus 4 bis 12 Ziffern bestehen', 'pin_fehlt')
  const ziffern = (pin + 'F'.repeat(14 - pin.length))
  return Buffer.from((0x20 | pin.length).toString(16).padStart(2, '0') + ziffern, 'hex')
}

export function statuswort(antwort: Buffer): string {
  if (antwort.length < 2) return '----'
  return antwort.subarray(antwort.length - 2).toString('hex').toUpperCase()
}

const daten = (antwort: Buffer): Buffer => antwort.subarray(0, Math.max(0, antwort.length - 2))

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

export interface GefundeneKarte {
  leser: string
  atr:   string
  typ:   KartenTyp
}

/** Erste gesteckte RKSV-Signaturkarte (andere Karten — Windows Hello, Bankomatkarte — werden übergangen) */
export async function findeKarte(transport: ApduTransport): Promise<GefundeneKarte> {
  const leser = await transport.leser()
  if (leser.length === 0) throw new KartenError('Kein Kartenleser angeschlossen', 'keine_karte')
  for (const l of leser) {
    if (!l.atr) continue
    const typ = erkenneKartentyp(l.atr)
    if (typ) return { leser: l.name, atr: l.atr.toUpperCase(), typ }
  }
  const gesteckt = leser.filter(l => l.atr)
  throw new KartenError(
    gesteckt.length === 0
      ? 'Keine Signaturkarte im Kartenleser'
      : `Im Kartenleser steckt keine A-Trust-Signaturkarte (gefunden: ${gesteckt.map(l => l.name).join(', ')})`,
    'keine_karte',
  )
}

function erwarte9000(antworten: Buffer[], schritte: string[]): void {
  for (let i = 0; i < schritte.length; i++) {
    const a = antworten[i]
    if (!a) throw new KartenError(`Karte: keine Antwort auf ${schritte[i]}`, 'karte_fehler')
    const sw = statuswort(a)
    if (sw !== '9000') throw new KartenError(`Karte: ${schritte[i]} fehlgeschlagen (Statuswort ${sw})`, 'karte_fehler')
  }
}

/** Länge eines DER-Objekts aus seinem Kopf (null = Kopf unvollständig) */
function derGesamtlaenge(kopf: Buffer): number | null {
  if (kopf.length < 2 || kopf[0] !== 0x30) return null
  const l = kopf[1]!
  if (l < 0x80) return 2 + l
  const n = l & 0x7f
  if (n < 1 || n > 3 || kopf.length < 2 + n) return null
  let len = 0
  for (let i = 0; i < n; i++) len = len * 256 + kopf[2 + i]!
  return 2 + n + len
}

/** Liest das Signaturzertifikat (DER) von der Karte — ohne PIN */
export async function leseZertifikat(transport: ApduTransport, karte: GefundeneKarte): Promise<Buffer> {
  const vorspann = [APDU.selectMf, APDU.selectDfSig, APDU.selectEfZert]
  const schritte = ['SELECT MF', 'SELECT DF Signatur', 'SELECT Zertifikat']
  // Erster Block: Länge aus dem DER-Kopf, danach genau die nötigen Blöcke
  const erste = await transport.sende(karte.leser, [...vorspann, APDU.leseBinaer(0)])
  erwarte9000(erste, schritte)
  const block0 = erste[3]
  if (!block0 || !['9000', '6282'].includes(statuswort(block0))) {
    throw new KartenError(`Karte: Zertifikat nicht lesbar (Statuswort ${block0 ? statuswort(block0) : '----'})`, 'karte_fehler')
  }
  const kopf = daten(block0)
  const gesamt = derGesamtlaenge(kopf)
  if (gesamt === null || gesamt > 8192) throw new KartenError('Karte: Zertifikat hat kein gültiges Format', 'karte_fehler')

  const teile = [kopf]
  let gelesen = kopf.length
  if (gelesen < gesamt) {
    const offsets: number[] = []
    for (let o = 256; o < gesamt; o += 256) offsets.push(o)
    const rest = await transport.sende(karte.leser, [...vorspann, ...offsets.map(o => APDU.leseBinaer(o))])
    erwarte9000(rest, schritte)
    for (let i = 0; i < offsets.length; i++) {
      const a = rest[3 + i]
      if (!a || !['9000', '6282'].includes(statuswort(a))) {
        throw new KartenError(`Karte: Zertifikat bei Byte ${offsets[i]} nicht lesbar`, 'karte_fehler')
      }
      teile.push(daten(a))
      gelesen += daten(a).length
    }
  }
  const der = Buffer.concat(teile)
  if (der.length < gesamt) throw new KartenError('Karte: Zertifikat unvollständig gelesen', 'karte_fehler')
  const zert = der.subarray(0, gesamt)
  try {
    new X509Certificate(zert)
  } catch {
    throw new KartenError('Karte: Zertifikat lässt sich nicht lesen', 'karte_fehler')
  }
  return zert
}

/**
 * Signiert `signingInput` (JWS-Signing-Input, ASCII) mit der Karte.
 * @returns 64 Byte r‖s
 * @throws KartenError 'pin_falsch' (mit restVersuche) / 'pin_gesperrt' — NIE automatisch wiederholen
 */
export async function signiereMitKarte(
  transport: ApduTransport,
  karte: GefundeneKarte,
  signingInput: string,
  pin: string,
): Promise<Buffer> {
  const pinBlock = pinBlockFormat2(pin)
  const hash = createHash('sha256').update(signingInput, 'utf8').digest()
  const antworten = await transport.sende(karte.leser, [
    APDU.selectMf, APDU.selectDfSig, APDU.verify(karte.typ.pinReferenz, pinBlock), APDU.signiere(hash),
  ])
  erwarte9000(antworten, ['SELECT MF', 'SELECT DF Signatur'])

  const verify = antworten[2]
  if (!verify) throw new KartenError('Karte: keine Antwort auf die PIN-Prüfung', 'karte_fehler')
  const swV = statuswort(verify)
  if (/^63C[0-9A-F]$/.test(swV)) {
    const rest = parseInt(swV[3]!, 16)
    throw new KartenError(
      rest === 0
        ? 'Die Karten-PIN ist falsch — die Karte ist jetzt GESPERRT'
        : `Die Karten-PIN ist falsch (noch ${rest} Versuch${rest === 1 ? '' : 'e'}, danach ist die Karte gesperrt)`,
      rest === 0 ? 'pin_gesperrt' : 'pin_falsch',
      rest,
    )
  }
  if (swV === '6983') throw new KartenError('Die Karten-PIN ist gesperrt — die Karte kann nicht mehr signieren', 'pin_gesperrt', 0)
  if (swV !== '9000') throw new KartenError(`Karte: PIN-Prüfung fehlgeschlagen (Statuswort ${swV})`, 'karte_fehler')

  const sig = antworten[3]
  if (!sig) throw new KartenError('Karte: keine Antwort auf das Signieren', 'karte_fehler')
  const swS = statuswort(sig)
  if (swS !== '9000') throw new KartenError(`Karte: Signieren fehlgeschlagen (Statuswort ${swS})`, 'karte_fehler')
  const roh = daten(sig)
  if (roh.length !== 64) throw new KartenError(`Karte: unerwartete Signaturlänge ${roh.length} (erwartet 64 Byte)`, 'karte_fehler')
  return Buffer.from(roh)
}
