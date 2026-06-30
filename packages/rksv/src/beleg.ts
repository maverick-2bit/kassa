/**
 * Beleg-Signierung – Herzstück des RKSV-Moduls.
 *
 * Ablauf pro Beleg:
 *   1. Betragsummen pro Steuersatz berechnen
 *   2. Umsatzzähler aktualisieren und verschlüsseln (AES-256-ICM)
 *   3. SigVorbeleg ermitteln (SHA-256 des Vorgänger-Signaturwerts)
 *   4. Maschinenlesbaren Code (QR-Code-String) gemäß BMF-Format aufbauen
 *   5. Signieren (ECDSA-P256-SHA256)
 *
 * QR-Code-Format (BMF Detailspezifikation §5):
 *   _R1-AT_{KID}_{BNR}_{BDT}_{BS-N}_{BS-E1}_{BS-E2}_{BS-0}_{BS-B}_{BSAU}_{ZKSN}_{BSKBV}_{SIG}
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
import { startbelegVorSignatur, folgebelegVorSignatur } from './crypto/chain.js'
import { signiere, verifiziere, zertifikatSN as ladeZertifikatSN } from './see.js'

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
  kassenId: string,
  belegNummer: number,
  datumUhrzeit: Date,
  betraege: BetraegeSummen,
  umsatzzaehlerVerschluesselt: string,
  zertifikatSN: string,
  sigVorbeleg: string,
): string {
  return [
    '_R1-AT',
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
// SEE-Ausfall
// ---------------------------------------------------------------------------

/**
 * BMF-Marker für den SEE-Ausfall: fällt die Signaturerstellungseinheit aus,
 * werden Belege weiter ausgegeben, der Signaturwert wird aber durch die
 * base64(url)-kodierte Zeichenkette „Sicherheitseinrichtung ausgefallen"
 * ersetzt (RKSV / BMF-Detailspezifikation §). Bei Wiederinbetriebnahme ist ein
 * signierter (Sammel-)Beleg zu erstellen.
 */
export const SEE_AUSFALL_SIGNATUR: string =
  Buffer.from('Sicherheitseinrichtung ausgefallen', 'utf8').toString('base64url')

/** true, wenn der Signaturwert der BMF-Ausfallmarker ist (Beleg unsigniert). */
export function istAusfallBeleg(signaturwert: string): boolean {
  return signaturwert === SEE_AUSFALL_SIGNATUR
}

// ---------------------------------------------------------------------------
// Hauptfunktion: Beleg signieren
// ---------------------------------------------------------------------------

export interface SignierungsKontext {
  see:             SEEConfig
  umsatzzaehler:   Umsatzzaehler
  /** Signaturwert des zuletzt signierten Belegs (base64url), undefined für den ersten Beleg */
  letzterSignaturwert?: string
}

/**
 * Signiert einen Rohbeleg und gibt den vollständigen RKSV-Beleg zurück.
 *
 * @param raw     Rohdaten des Belegs
 * @param kontext Signierungskontext mit SEE, Umsatzzähler und Vorgänger-Signaturwert
 * @param opts    `ausfallModus`: statt ECDSA-Signatur den SEE-Ausfallmarker setzen
 */
export function signiereBeleg(
  raw: RawBeleg,
  kontext: SignierungsKontext,
  opts: { ausfallModus?: boolean } = {},
): SignedBeleg {
  const { see, umsatzzaehler, letzterSignaturwert } = kontext

  // 1. Beträge summieren
  const betraege = berechneBetraege(raw.positionen)

  // 2. Umsatzzähler: aktualisieren (nur bei bestimmten Belegtypen)
  if (BELEG_AENDERT_ZAEHLER[raw.belegTyp]) {
    umsatzzaehler.addiere(gesamtBetragCent(betraege))
  }
  // Aktuellen Zählerstand verschlüsseln
  const umsatzzaehlerBuf = verschluesselUmsatzzaehler(
    umsatzzaehler.aktuell,
    see.zertifikatDER,
    see.kassenId,
    raw.belegNummer,
  )
  const umsatzzaehlerVerschluesselt = umsatzzaehlerBuf.toString('base64url')

  // 3. SigVorbeleg
  const sigVorbeleg = letzterSignaturwert == null
    ? startbelegVorSignatur()
    : folgebelegVorSignatur(letzterSignaturwert)

  // 4. Zertifikats-Seriennummer
  const zertSN = ladeZertifikatSN(see.zertifikatDER)

  // 5. Maschinenlesbarer Code ohne Signatur
  const codeOhneSig = baueMaschinenlesbareCodeOhneSig(
    raw.kassenId,
    raw.belegNummer,
    raw.datumUhrzeit,
    betraege,
    umsatzzaehlerVerschluesselt,
    zertSN,
    sigVorbeleg,
  )

  // 6. Signieren — im Ausfallmodus den BMF-Marker statt der ECDSA-Signatur
  const signaturwert = opts.ausfallModus
    ? SEE_AUSFALL_SIGNATUR
    : signiere(codeOhneSig, see)

  // 7. Vollständiger maschinenlesbarer Code
  const maschinenlesbareCode = `${codeOhneSig}_${signaturwert}`

  return {
    ...raw,
    betraege,
    umsatzzaehlerVerschluesselt,
    zertifikatSN:        zertSN,
    sigVorbeleg,
    signaturwert,
    maschinenlesbareCode,
    ...(opts.ausfallModus && { ausgefallen: true }),
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Kasse initialisieren (Startbeleg)
// ---------------------------------------------------------------------------

export function erstelleStartbeleg(kassenId: string, see: SEEConfig): {
  beleg:    SignedBeleg
  kontext:  SignierungsKontext
} {
  const umsatzzaehler = new Umsatzzaehler(0n)
  const kontext: SignierungsKontext = { see, umsatzzaehler }

  const raw: RawBeleg = {
    kassenId,
    belegNummer:  1,
    datumUhrzeit: new Date(),
    belegTyp:     'Startbeleg',
    positionen:   [],
  }

  const beleg = signiereBeleg(raw, kontext)
  kontext.letzterSignaturwert = beleg.signaturwert

  return { beleg, kontext }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Nullbeleg (täglich wenn kein Umsatz)
// ---------------------------------------------------------------------------

export function erstelleNullbeleg(
  kassenId: string,
  belegNummer: number,
  kontext: SignierungsKontext,
): SignedBeleg {
  const raw: RawBeleg = {
    kassenId,
    belegNummer,
    datumUhrzeit: new Date(),
    belegTyp:     'Nullbeleg',
    positionen:   [],
  }
  const beleg = signiereBeleg(raw, kontext)
  kontext.letzterSignaturwert = beleg.signaturwert
  return beleg
}

// ---------------------------------------------------------------------------
// Verifikation: erkennt nachträgliche Manipulation eines Belegs
// ---------------------------------------------------------------------------

/** Die strukturierten Felder, aus denen der signierte Code rekonstruiert wird. */
export interface VerifizierbarerBeleg {
  kassenId:                    string
  belegNummer:                 number
  datumUhrzeit:                Date
  betraege:                    BetraegeSummen
  umsatzzaehlerVerschluesselt: string
  zertifikatSN:                string
  sigVorbeleg:                 string
  signaturwert:                string
}

/**
 * Prüft die ECDSA-Signatur eines Belegs gegen seine strukturierten Felder.
 *
 * Der signierte maschinenlesbare Code wird aus den Feldern (Betrag, Datum,
 * Umsatzzähler, …) NEU aufgebaut und gegen den gespeicherten Signaturwert
 * verifiziert. Wurde ein Feld nachträglich verändert — etwa ein Betrag direkt
 * in der Datenbank — passt die Signatur nicht mehr und die Prüfung schlägt
 * fehl. Es wird nur das öffentliche Zertifikat benötigt.
 *
 * @returns true, wenn die Signatur zu den Feldern passt (unverändert)
 */
export function verifiziereBelegSignatur(beleg: VerifizierbarerBeleg, zertifikatDER: Buffer): boolean {
  const codeOhneSig = baueMaschinenlesbareCodeOhneSig(
    beleg.kassenId,
    beleg.belegNummer,
    beleg.datumUhrzeit,
    beleg.betraege,
    beleg.umsatzzaehlerVerschluesselt,
    beleg.zertifikatSN,
    beleg.sigVorbeleg,
  )
  return verifiziere(codeOhneSig, beleg.signaturwert, {
    kassenId:      beleg.kassenId,
    zertifikatDER,
    privateKeyDER: Buffer.alloc(0), // bei der Verifikation ungenutzt
  })
}
