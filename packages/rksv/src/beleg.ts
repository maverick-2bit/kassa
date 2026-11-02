/**
 * Beleg-Signierung – Herzstück des RKSV-Moduls (BMF-Detailspezifikation).
 *
 * Ablauf pro Beleg:
 *   1. Betragsummen pro Steuersatz berechnen
 *   2. Umsatzzähler aktualisieren und verschlüsseln (AES-256-ICM, eigener Schlüssel)
 *   3. Verkettungswert ermitteln (8 Byte SHA-256; Start: Kassen-ID, sonst JWS-Compact-Form des Vorbelegs)
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
import { jwsSigningInput, qrCodeZuJwsCompact } from './crypto/jws.js'
import { signiereRoh, verifiziere, verifiziereDerCodiert, zertifikatSN as ladeZertifikatSN } from './see.js'
import { formatBelegDatumUhrzeit } from './zeit.js'

// JWS-Hilfen leben in crypto/jws.ts (chain.ts braucht sie ebenfalls); hier unter den bisherigen Namen weiter exportiert.
export { JWS_HEADER_B64URL, jwsSigningInput, qrCodeZuJwsCompact } from './crypto/jws.js'

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

/**
 * Rundet auf ganze Cent, halbe Cent von Null weg (4,5 → 5, −4,5 → −5).
 *
 * `Math.round` rundet bei negativen Werten zur Null hin (−4,5 → −4). Ein Storno (negierter Preis,
 * gleiche Menge) ergab dadurch bei halben Cent, z. B. 1,5 kg zu 3,33 €, einen Cent weniger als das
 * Original — der Storno ließ sich nicht buchen. So ist der Storno immer exakt das Negativ des Originals.
 */
export function rundeCent(wert: number): number {
  const gerundet = wert < 0 ? -Math.round(-wert) : Math.round(wert)
  return gerundet === 0 ? 0 : gerundet   // kein „−0"
}

export function berechneBetraege(positionen: BelegPosition[]): BetraegeSummen {
  const summen: BetraegeSummen = { normal: 0, ermaessigt1: 0, ermaessigt2: 0, ermaessigt3: 0, null: 0, besonders: 0 }
  for (const pos of positionen) {
    const brutto = rundeCent(pos.menge * pos.einzelpreisBreutto)
    summen[pos.mwstSatz] += brutto
  }
  return summen
}

export function gesamtBetragCent(betraege: BetraegeSummen): bigint {
  return BigInt(
    betraege.normal + betraege.ermaessigt1 + betraege.ermaessigt2 + betraege.ermaessigt3 +
    betraege.null   + betraege.besonders
  )
}

// ---------------------------------------------------------------------------
// Datumsformat
// ---------------------------------------------------------------------------

/**
 * ISO 8601 ohne Zeitzone, wie von BMF vorgeschrieben: "YYYY-MM-DDTHH:MM:SS" —
 * immer in österreichischer Ortszeit, egal in welcher Zeitzone der Prozess läuft
 * (siehe zeit.ts). Das ist `formatBelegDatumUhrzeit`.
 *
 * Bis v0.8.74 stand hier die Zeit der Prozess-Zeitzone (`getHours()` & Co.). Im
 * Docker-Container ohne `TZ` ist das UTC: Der QR-Code trug dann eine um 1 bis 2
 * Stunden falsche Uhrzeit (und um Mitternacht den falschen Tag). Solche Belege
 * sind signiert und bleiben, wie sie sind — die Prüfung kennt beide Schreibweisen
 * (`zeitDarstellungen`).
 */

/** Frühere Schreibweise: Zeit der Prozess-Zeitzone (nur noch zum Erkennen alter Belege). */
function formatProzessZeit(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** UTC in derselben Schreibweise — die Zone eines Containers ohne `TZ`. */
function formatUtcZeit(d: Date): string {
  return d.toISOString().slice(0, 19)
}

/**
 * Die Schreibweisen, in denen der Zeitpunkt eines Belegs im signierten Code stehen
 * kann: zuerst die richtige (Wiener Ortszeit), dann die der Altbelege (UTC bzw. die
 * Zone des Prozesses, in dem sie signiert wurden). Doppelte entfallen.
 */
function zeitDarstellungen(d: Date): { wien: string; alt: string[] } {
  const wien = formatBelegDatumUhrzeit(d)
  const alt  = [...new Set([formatUtcZeit(d), formatProzessZeit(d)])].filter(t => t !== wien)
  return { wien, alt }
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
  /** `JJJJ-MM-TT'T'hh:mm:ss`, Wiener Ortszeit (siehe formatBelegDatumUhrzeit) */
  datumUhrzeit: string,
  betraege: BetraegeSummen,
  umsatzzaehlerVerschluesselt: string,
  zertifikatSN: string,
  sigVorbeleg: string,
): string {
  return [
    `_R1-${zdaId}`,
    kassenId,
    String(belegNummer),
    datumUhrzeit,
    formatBetrag(betraege.normal),
    formatBetrag(betraege.ermaessigt1),
    formatBetrag(betraege.ermaessigt2),
    formatBetrag(betraege.null),
    // Betrag-Satz-Besonders (19 %, 4,9 %): die RKSV hat dafür EIN Feld (Anlage 1 Z 4).
    // `?? 0`: Beträge aus der Zeit vor dem 4,9-%-Satz haben das Feld nicht.
    formatBetrag(betraege.besonders + (betraege.ermaessigt3 ?? 0)),
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
  /**
   * Kompletter maschinenlesbarer Code (QR-Form) des zuletzt signierten Belegs, undefined für den ersten Beleg.
   * Gehasht wird seine JWS-Compact-Form (`verkettungswertFolgebeleg` rechnet um).
   */
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

  // 2. Umsatzzähler: aktualisieren (nur bei bestimmten Belegtypen). Scheitert
  //    irgendein späterer Schritt, steht der Zähler wieder auf dem alten Stand —
  //    der Aufrufer darf nach einer Ausnahme nie einen halb gebuchten Zähler sehen.
  const zaehlerVorher = umsatzzaehler.aktuell
  try {
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
      formatBelegDatumUhrzeit(raw.datumUhrzeit),
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

    // 8. Gegenprobe: Die frische Signatur MUSS zum Zertifikat der Kasse passen —
    //    genau das prüft später jede Finanzprüfung (BMF-Prüftool, Belegcheck-App).
    //    Eine Einheit, die Unsinn liefert (Schlüssel passt nicht zum gespeicherten
    //    Zertifikat, HSM-Fehlerantwort mit 64 Byte, Fehler in der eigenen Codierung),
    //    fiele sonst erst bei der Prüfung auf — mit einem schon gedruckten Beleg.
    //    Kostet unter einer Millisekunde. Ausfallbelege tragen den Marker, keine Signatur.
    if (!opts.ausfallModus && !verifiziereQrCode(maschinenlesbareCode, see.zertifikatDER)) {
      throw new SignaturUngueltigError(
        `Beleg ${raw.belegNummer} der Kasse ${raw.kassenId}: Die frisch erzeugte Signatur passt nicht zum ` +
        `Zertifikat der Kasse (Seriennummer ${zertSN}). Der Beleg wurde verworfen.`,
      )
    }

    const jwsCompact = qrCodeZuJwsCompact(maschinenlesbareCode)

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
  } catch (err) {
    umsatzzaehler.setze(zaehlerVorher)
    throw err
  }
}

/**
 * Die Signatur eines frisch signierten Belegs besteht die Gegenprobe gegen das
 * Zertifikat der Kasse nicht. Der Beleg ist verworfen, der Umsatzzähler
 * zurückgesetzt — behandeln wie einen Ausfall der Signaturerstellungseinheit.
 */
export class SignaturUngueltigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignaturUngueltigError'
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
  /**
   * Der GESPEICHERTE maschinenlesbare Code (QR-Inhalt samt Signatur). Ist er
   * angegeben, muss der aus den Feldern aufgebaute Code ihm Zeichen für Zeichen
   * gleichen — sonst wurde entweder ein Feld oder der Code selbst nachträglich
   * verändert. Fehlt er, prüft die Signatur allein.
   */
  maschinenlesbareCode?:       string
}

/** Ergebnis von `pruefeBelegSignatur`. */
export type BelegSignaturPruefung =
  /** Signatur passt zu den Feldern; Zeit in Wiener Ortszeit, P1363-codiert */
  | 'gueltig'
  /**
   * Signatur passt, aber der Zeitpunkt steht im Code in UTC bzw. der Zone des
   * damaligen Prozesses statt in Wiener Ortszeit (Belege aus einem Container
   * ohne TZ, vor v0.8.75). Inhalt integer, die Uhrzeit im QR-Code ist 1 bis 2
   * Stunden daneben.
   */
  | 'zeit_altformat'
  /** Signatur passt, aber DER-codiert (vor dem P1363-Fix); Zeit egal in welcher Schreibweise */
  | 'der_altformat'
  /** Weder noch: Feld, Code oder Signatur wurden verändert, oder falsches Zertifikat */
  | 'ungueltig'

/**
 * Prüft die ECDSA-Signatur eines Belegs gegen seine strukturierten Felder und
 * ordnet sie ein (siehe `BelegSignaturPruefung`).
 *
 * Der signierte maschinenlesbare Code wird aus den Feldern (Betrag, Datum,
 * Umsatzzähler, …) NEU aufgebaut, in den JWS-Signing-Input überführt und gegen
 * den gespeicherten Signaturwert verifiziert. Wurde ein Feld nachträglich
 * verändert — etwa ein Betrag direkt in der Datenbank — passt die Signatur
 * nicht mehr und die Prüfung schlägt fehl. Es wird nur das öffentliche
 * Zertifikat benötigt.
 *
 * Der Zeitpunkt wird in Wiener Ortszeit aufgebaut. Altbelege tragen ihn in UTC
 * (Container ohne TZ) — sie würden nach der Umstellung auf feste Ortszeit
 * sonst alle als „ungültig" gemeldet. Deshalb gelten genau diese Schreibweisen
 * des SELBEN Zeitpunkts zusätzlich (und nur die: eine um Stunden verschobene
 * Zeit in der Datenbank fällt weiterhin auf).
 */
export function pruefeBelegSignatur(beleg: VerifizierbarerBeleg, zertifikatDER: Buffer): BelegSignaturPruefung {
  const { wien, alt } = zeitDarstellungen(beleg.datumUhrzeit)
  const signatur      = Buffer.from(beleg.signaturwert, 'base64')

  const passt = (
    zeitText: string,
    pruefe:   (daten: string, sig: Buffer, cert: Buffer) => boolean,
  ): boolean => {
    const codeOhneSig = baueMaschinenlesbareCodeOhneSig(
      beleg.zdaId,
      beleg.kassenId,
      beleg.belegNummer,
      zeitText,
      beleg.betraege,
      beleg.umsatzzaehlerVerschluesselt,
      beleg.zertifikatSN,
      beleg.sigVorbeleg,
    )
    if (!pruefe(jwsSigningInput(codeOhneSig), signatur, zertifikatDER)) return false
    // Der gespeicherte Code muss genau dieser Code samt Signatur sein
    return beleg.maschinenlesbareCode === undefined
        || beleg.maschinenlesbareCode === `${codeOhneSig}_${beleg.signaturwert}`
  }

  if (passt(wien, verifiziere)) return 'gueltig'
  if (alt.some(t => passt(t, verifiziere))) return 'zeit_altformat'
  if (passt(wien, verifiziereDerCodiert) || alt.some(t => passt(t, verifiziereDerCodiert))) return 'der_altformat'
  return 'ungueltig'
}

/**
 * true, wenn die Signatur zu den Feldern passt (unverändert) — auch bei einem
 * Altbeleg mit der Zeit in UTC. Die Einordnung liefert `pruefeBelegSignatur`.
 */
export function verifiziereBelegSignatur(beleg: VerifizierbarerBeleg, zertifikatDER: Buffer): boolean {
  const ergebnis = pruefeBelegSignatur(beleg, zertifikatDER)
  return ergebnis === 'gueltig' || ergebnis === 'zeit_altformat'
}

/**
 * Zweitprüfung für Alt-Belege aus der Zeit vor dem P1363-Fix: Der gespeicherte
 * Signaturwert ist dort DER-codiert (ASN.1) statt roh (r ‖ s, 64 Byte). Liefert
 * true, wenn die Signatur in DIESEM Altformat kryptographisch korrekt ist —
 * der Beleg ist dann integer, nur die Codierung entsprach nicht der RKSV-Norm.
 */
export function verifiziereBelegSignaturAltDer(beleg: VerifizierbarerBeleg, zertifikatDER: Buffer): boolean {
  return pruefeBelegSignatur(beleg, zertifikatDER) === 'der_altformat'
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
