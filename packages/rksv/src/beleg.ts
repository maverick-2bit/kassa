/**
 * Beleg-Signierung – Herzstück des RKSV-Moduls (BMF-Detailspezifikation).
 *
 * Ablauf pro Beleg:
 *   1. Betragsummen pro Steuersatz berechnen
 *   2. Umsatzzähler aktualisieren und verschlüsseln (AES-256-ICM, eigener Schlüssel)
 *   3. Verkettungswert ermitteln (8 Byte SHA-256; Start: Kassen-ID, sonst Vorbeleg-Code)
 *   4. Maschinenlesbaren Code (QR-Repräsentation) aufbauen — Base64-STANDARD-Felder
 *   5. Signieren als JWS: ES256 über base64url(header) + "." + base64url(code)
 *
 * QR-Code-Format:
 *   _R1-{ZDA}_{KID}_{BNR}_{BDT}_{BS-N}_{BS-E1}_{BS-E2}_{BS-0}_{BS-B}_{BSAU}_{ZKSN}_{BSKBV}_{SIG}
 *   (BSAU/BSKBV/SIG in BASE64_STD; ZKSN hexadezimal)
 *
 * Referenz-Beleg (BMF-Mustercode):
 *   _R1-AT2_CASHBOX-DEMO-1_…_2016-03-11T03:57:08_0,00_…_4BMxCg==_011388844D20A02C087A4BE257_cg8hNU5ihto=_RFvjH0H5…Ew==
 */

import { BELEG_AENDERT_ZAEHLER } from './types.js'
import type {
  BelegPosition,
  BetraegeSummen,
  BelegTyp,
  MwStSatz,
  RawBeleg,
  SEEConfig,
  SignedBeleg,
} from './types.js'
import { verschluesselUmsatzzaehler } from './crypto/aes-icm.js'
import { verkettungswertStartbeleg, verkettungswertFolgebeleg } from './crypto/chain.js'
import { signiereRoh, verifiziere, zertifikatSN as ladeZertifikatSN } from './see.js'

// ---------------------------------------------------------------------------
// Umsatzzähler-State
// ---------------------------------------------------------------------------

/**
 * Verwaltet den laufenden Umsatzzähler einer Kasse.
 * Muss persistent gespeichert und beim Start wiederhergestellt werden.
 */
export class Umsatzzaehler {
  private zaehlerCent: bigint

  constructor(initialCent: bigint = 0n) {
    this.zaehlerCent = initialCent
  }

  /** Aktuellen Stand (für Verschlüsselung) — verändert den Stand NICHT */
  get aktuell(): bigint {
    return this.zaehlerCent
  }

  /**
   * Addiert den Betrag und gibt den neuen Stand zurück.
   * Negative Beträge sind für Stornos erlaubt (Zähler kann negativ werden).
   */
  addiere(betragCent: bigint): bigint {
    this.zaehlerCent += betragCent
    return this.zaehlerCent
  }

  /** Setzt den Zähler auf einen bekannten Stand (beim Laden aus DB) */
  setze(cent: bigint): void {
    this.zaehlerCent = cent
  }

  toJSON(): string {
    return this.zaehlerCent.toString()
  }
}

// ---------------------------------------------------------------------------
// Betragsberechnung
// ---------------------------------------------------------------------------

export function berechneBetraege(positionen: BelegPosition[]): BetraegeSummen {
  const summen: BetraegeSummen = { normal: 0, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 0 }
  for (const pos of positionen) {
    const brutto = Math.round(pos.menge * pos.einzelpreisBreutto)
    summen[pos.mwstSatz] += brutto
  }
  return summen
}

export function gesamtBetragCent(betraege: BetraegeSummen): bigint {
  return BigInt(
    betraege.normal + betraege.ermaessigt1 + betraege.ermaessigt2 +
    betraege.null   + betraege.besonders
  )
}

// ---------------------------------------------------------------------------
// Datumsformat
// ---------------------------------------------------------------------------

/** ISO 8601 ohne Zeitzone, wie von BMF vorgeschrieben: "YYYY-MM-DDTHH:MM:SS" */
function formatDatum(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Betragsformat
// ---------------------------------------------------------------------------

/**
 * Formatiert einen Centbetrag als Dezimalzahl mit Komma (BMF-Vorgabe).
 * Negative Werte erlaubt (Storno).
 * Beispiele: 1050 → "10,50"   0 → "0,00"   -500 → "-5,00"
 */
function formatBetrag(cent: number): string {
  const vorzeichen = cent < 0 ? '-' : ''
  const abs        = Math.abs(cent)
  const euro       = Math.floor(abs / 100)
  const ct         = abs % 100
  return `${vorzeichen}${euro},${String(ct).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Maschinenlesbarer Code (QR-Code-Inhalt)
// ---------------------------------------------------------------------------

/**
 * Baut den maschinenlesbaren Code gemäß BMF-Spezifikation §5.
 *
 * Format:
 *   _R1-AT_<KID>_<BNR>_<BDT>_<BS-N>_<BS-E1>_<BS-E2>_<BS-0>_<BS-B>_<BSAU>_<ZKSN>_<BSKBV>
 *
 * Dieser String wird anschließend signiert. Die Signatur wird dann angehängt:
 *   {obiger String}_{SIG}
 */
function baueMaschinenlesbareCodeOhneSig(
  zdaId: string,
  kassenId: string,
  belegNummer: number,
  datumUhrzeit: Date,
  betraege: BetraegeSummen,
  umsatzzaehlerVerschluesselt: string,
  zertifikatSN: string,
  sigVorbeleg: string,
): string {
  return [
    `_R1-${zdaId}`,
    kassenId,
    String(belegNummer),
    formatDatum(datumUhrzeit),
    formatBetrag(betraege.normal),
    formatBetrag(betraege.ermaessigt1),
    formatBetrag(betraege.ermaessigt2),
    formatBetrag(betraege.null),
    formatBetrag(betraege.besonders),
    umsatzzaehlerVerschluesselt,
    zertifikatSN,
    sigVorbeleg,
  ].join('_')
}

// ---------------------------------------------------------------------------
// JWS (RFC 7515) — RKSV signiert den Code als ES256-JWS
// ---------------------------------------------------------------------------

/** Fixer JWS-Header der RKSV-Suite R1: {"alg":"ES256"} (base64url) */
export const JWS_HEADER_B64URL: string =
  Buffer.from(JSON.stringify({ alg: 'ES256' }), 'utf8').toString('base64url')

/** JWS-Signing-Input: base64url(header) + "." + base64url(codeOhneSig) */
export function jwsSigningInput(codeOhneSig: string): string {
  return `${JWS_HEADER_B64URL}.${Buffer.from(codeOhneSig, 'utf8').toString('base64url')}`
}

/**
 * Rechnet die QR-Repräsentation in die JWS-Compact-Repräsentation um
 * (für den DEP-Export): header.payload.signature, alles base64url.
 * Funktioniert auch für Ausfall-Belege (Marker wird base64url umkodiert).
 */
export function qrCodeZuJwsCompact(maschinenlesbareCode: string): string {
  const idx         = maschinenlesbareCode.lastIndexOf('_')
  const codeOhneSig = maschinenlesbareCode.slice(0, idx)
  const sigBase64   = maschinenlesbareCode.slice(idx + 1)
  const sigB64url   = Buffer.from(sigBase64, 'base64').toString('base64url')
  return `${jwsSigningInput(codeOhneSig)}.${sigB64url}`
}

// ---------------------------------------------------------------------------
// SEE-Ausfall
// ---------------------------------------------------------------------------

/**
 * BMF-Marker für den SEE-Ausfall: fällt die Signaturerstellungseinheit aus,
 * werden Belege weiter ausgegeben, der Signaturwert wird aber durch die
 * BASE64-Standard-kodierte Zeichenkette „Sicherheitseinrichtung ausgefallen"
 * ersetzt (BMF-Detailspezifikation). Bei Wiederinbetriebnahme ist ein
 * signierter (Sammel-)Beleg zu erstellen.
 */
export const SEE_AUSFALL_SIGNATUR: string =
  Buffer.from('Sicherheitseinrichtung ausgefallen', 'utf8').toString('base64')

/** true, wenn der Signaturwert der BMF-Ausfallmarker ist (Beleg unsigniert). */
export function istAusfallBeleg(signaturwert: string): boolean {
  return signaturwert === SEE_AUSFALL_SIGNATUR
}

// ---------------------------------------------------------------------------
// Hauptfunktion: Beleg signieren
// ---------------------------------------------------------------------------

/**
 * Pluggable Signaturerstellungseinheit (Software / A-Trust HSM / später CHIP).
 * Interface lebt in see/signatur-einheit.ts — hier nur strukturell referenziert,
 * um Import-Zyklen zu vermeiden.
 */
export interface BelegSignaturEinheit {
  signiereBelegzeile(codeOhneSig: string): Promise<Buffer>
}

export interface SignierungsKontext {
  see:             SEEConfig
  umsatzzaehler:   Umsatzzaehler
  /** Kompletter maschinenlesbarer Code des zuletzt signierten Belegs, undefined für den ersten Beleg */
  letzterBelegCode?: string
  /** Optionale externe Signatureinheit — ohne sie signiert der lokale Software-Key aus `see` */
  einheit?: BelegSignaturEinheit
}

/**
 * Signiert einen Rohbeleg und gibt den vollständigen RKSV-Beleg zurück.
 * Async, weil externe Signatureinheiten (A-Trust HSM) über HTTP signieren.
 *
 * @param raw     Rohdaten des Belegs
 * @param kontext Signierungskontext mit SEE, Umsatzzähler und Vorbeleg-Code
 * @param opts    `ausfallModus`: statt ECDSA-Signatur den SEE-Ausfallmarker setzen
 */
export async function signiereBeleg(
  raw: RawBeleg,
  kontext: SignierungsKontext,
  opts: { ausfallModus?: boolean } = {},
): Promise<SignedBeleg> {
  const { see, umsatzzaehler, letzterBelegCode, einheit } = kontext

  // 1. Beträge summieren
  const betraege = berechneBetraege(raw.positionen)

  // 2. Umsatzzähler: aktualisieren (nur bei bestimmten Belegtypen)
  if (BELEG_AENDERT_ZAEHLER[raw.belegTyp]) {
    umsatzzaehler.addiere(gesamtBetragCent(betraege))
  }
  // Aktuellen Zählerstand verschlüsseln — BASE64_STD im QR-Code
  const umsatzzaehlerBuf = verschluesselUmsatzzaehler(
    umsatzzaehler.aktuell,
    see.aesSchluessel,
    see.kassenId,
    raw.belegNummer,
  )
  const umsatzzaehlerVerschluesselt = umsatzzaehlerBuf.toString('base64')

  // 3. Verkettungswert: Startbeleg über die Kassen-ID, sonst über den Vorbeleg-Code
  const sigVorbeleg = letzterBelegCode == null
    ? verkettungswertStartbeleg(raw.kassenId)
    : verkettungswertFolgebeleg(letzterBelegCode)

  // 4. Zertifikats-Seriennummer (hexadezimal, wie im QR-Code)
  const zertSN = ladeZertifikatSN(see.zertifikatDER)

  // 5. Maschinenlesbarer Code ohne Signatur
  const codeOhneSig = baueMaschinenlesbareCodeOhneSig(
    see.zdaId,
    raw.kassenId,
    raw.belegNummer,
    raw.datumUhrzeit,
    betraege,
    umsatzzaehlerVerschluesselt,
    zertSN,
    sigVorbeleg,
  )

  // 6. Signieren als JWS (ES256) — im Ausfallmodus der BMF-Marker.
  //    Externe Einheit (A-Trust) falls konfiguriert, sonst lokaler Software-Key.
  const signaturwert = opts.ausfallModus
    ? SEE_AUSFALL_SIGNATUR
    : (einheit
        ? await einheit.signiereBelegzeile(codeOhneSig)
        : signiereRoh(jwsSigningInput(codeOhneSig), see)
      ).toString('base64')

  // 7. Vollständiger maschinenlesbarer Code (QR) + JWS-Compact (DEP)
  const maschinenlesbareCode = `${codeOhneSig}_${signaturwert}`
  const jwsCompact           = qrCodeZuJwsCompact(maschinenlesbareCode)

  return {
    ...raw,
    betraege,
    umsatzzaehlerVerschluesselt,
    zertifikatSN:        zertSN,
    sigVorbeleg,
    signaturwert,
    maschinenlesbareCode,
    jwsCompact,
    ...(opts.ausfallModus && { ausgefallen: true }),
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Kasse initialisieren (Startbeleg)
// ---------------------------------------------------------------------------

export async function erstelleStartbeleg(
  kassenId: string,
  see: SEEConfig,
  einheit?: BelegSignaturEinheit,
): Promise<{
  beleg:    SignedBeleg
  kontext:  SignierungsKontext
}> {
  const umsatzzaehler = new Umsatzzaehler(0n)
  const kontext: SignierungsKontext = { see, umsatzzaehler, ...(einheit ? { einheit } : {}) }

  const raw: RawBeleg = {
    kassenId,
    belegNummer:  1,
    datumUhrzeit: new Date(),
    belegTyp:     'Startbeleg',
    positionen:   [],
  }

  const beleg = await signiereBeleg(raw, kontext)
  kontext.letzterBelegCode = beleg.maschinenlesbareCode

  return { beleg, kontext }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Nullbeleg (täglich wenn kein Umsatz)
// ---------------------------------------------------------------------------

export async function erstelleNullbeleg(
  kassenId: string,
  belegNummer: number,
  kontext: SignierungsKontext,
): Promise<SignedBeleg> {
  const raw: RawBeleg = {
    kassenId,
    belegNummer,
    datumUhrzeit: new Date(),
    belegTyp:     'Nullbeleg',
    positionen:   [],
  }
  const beleg = await signiereBeleg(raw, kontext)
  kontext.letzterBelegCode = beleg.maschinenlesbareCode
  return beleg
}

// ---------------------------------------------------------------------------
// Verifikation: erkennt nachträgliche Manipulation eines Belegs
// ---------------------------------------------------------------------------

/** Die strukturierten Felder, aus denen der signierte Code rekonstruiert wird. */
export interface VerifizierbarerBeleg {
  zdaId:                       string
  kassenId:                    string
  belegNummer:                 number
  datumUhrzeit:                Date
  betraege:                    BetraegeSummen
  umsatzzaehlerVerschluesselt: string
  zertifikatSN:                string
  sigVorbeleg:                 string
  /** BASE64_STD wie im QR-Code */
  signaturwert:                string
}

/**
 * Prüft die ECDSA-Signatur eines Belegs gegen seine strukturierten Felder.
 *
 * Der signierte maschinenlesbare Code wird aus den Feldern (Betrag, Datum,
 * Umsatzzähler, …) NEU aufgebaut, in den JWS-Signing-Input überführt und gegen
 * den gespeicherten Signaturwert verifiziert. Wurde ein Feld nachträglich
 * verändert — etwa ein Betrag direkt in der Datenbank — passt die Signatur
 * nicht mehr und die Prüfung schlägt fehl. Es wird nur das öffentliche
 * Zertifikat benötigt.
 *
 * @returns true, wenn die Signatur zu den Feldern passt (unverändert)
 */
export function verifiziereBelegSignatur(beleg: VerifizierbarerBeleg, zertifikatDER: Buffer): boolean {
  const codeOhneSig = baueMaschinenlesbareCodeOhneSig(
    beleg.zdaId,
    beleg.kassenId,
    beleg.belegNummer,
    beleg.datumUhrzeit,
    beleg.betraege,
    beleg.umsatzzaehlerVerschluesselt,
    beleg.zertifikatSN,
    beleg.sigVorbeleg,
  )
  return verifiziere(
    jwsSigningInput(codeOhneSig),
    Buffer.from(beleg.signaturwert, 'base64'),
    zertifikatDER,
  )
}

/**
 * Prüft die Signatur direkt aus dem maschinenlesbaren Code (QR-Repräsentation) —
 * ohne Rekonstruktion aus Feldern. Für Fixtures/Fremdbelege und die Finanzprüfung.
 */
export function verifiziereQrCode(maschinenlesbareCode: string, zertifikatDER: Buffer): boolean {
  const idx         = maschinenlesbareCode.lastIndexOf('_')
  const codeOhneSig = maschinenlesbareCode.slice(0, idx)
  const sigBase64   = maschinenlesbareCode.slice(idx + 1)
  return verifiziere(
    jwsSigningInput(codeOhneSig),
    Buffer.from(sigBase64, 'base64'),
    zertifikatDER,
  )
}
