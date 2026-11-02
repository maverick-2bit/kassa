/**
 * RKSV-Verkettungswert gemäß RKSV Anlage 1 (Z 4, Z 6) und BMF-Detailspezifikation:
 *
 *   Verkettungswert = BASE64_STD( erste 8 Byte von SHA-256(Input) )
 *
 *   - Startbeleg (kein Vorgänger): Input = Kassen-Identifikationsnummer
 *   - Folgebeleg:                  Input = JWS-Compact-Form des Vorbelegs
 *                                  (`header.payload.signatur`, alles base64url)
 *
 * NICHT der QR-Code des Vorbelegs: dort steht die Signatur in Standard-Base64 und die Nutzlast im Klartext.
 * Die Kassa hat vor dieser Korrektur den QR-Code gehasht (Befund A der RKSV-Prüfstrecke); die BMF-Beispieldaten
 * (1284 von 1284 Folgebelegen) und das BMF-Prüftool (`CHAINING_INPUT`) verlangen die JWS-Form.
 * Gespeichert wird weiterhin der QR-Code (`kassen.letzter_beleg_code`, `belege.maschinenlesbare_code`);
 * `verkettungswertFolgebeleg` nimmt ihn entgegen und rechnet erst beim Hashen in die JWS-Form um.
 *
 * Referenzwert-Beispiel (BMF-Mustercode, Startbeleg): `cg8hNU5ihto=` — 8 Byte,
 * Standard-Base64 mit Padding (12 Zeichen).
 */

import { createHash } from 'node:crypto'
import { qrCodeZuJwsCompact } from './jws.js'

function verkettungswert(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest().subarray(0, 8).toString('base64')
}

/** Verkettungswert für den Startbeleg: Input ist die Kassen-ID. */
export function verkettungswertStartbeleg(kassenId: string): string {
  return verkettungswert(kassenId)
}

/**
 * Verkettungswert für Folgebelege aus der JWS-Compact-Form des Vorbelegs (`header.payload.signatur`) —
 * die Hash-Eingabe der Spezifikation. Für Belege, wie die Kassa sie speichert (QR-Code), `verkettungswertFolgebeleg`.
 */
export function verkettungswertAusJwsCompact(vorbelegJwsCompact: string): string {
  return verkettungswert(vorbelegJwsCompact)
}

/**
 * Verkettungswert für Folgebelege: Input ist der komplette maschinenlesbare Code (QR-Form) des Vorbelegs,
 * so wie die Kassa ihn speichert. Gehasht wird seine JWS-Compact-Form (RKSV Anlage 1 Z 4), nicht der QR-Code.
 */
export function verkettungswertFolgebeleg(vorbelegCode: string): string {
  return verkettungswertAusJwsCompact(qrCodeZuJwsCompact(vorbelegCode))
}

/**
 * Verkettungswert der Altform: Hash des QR-Codes des Vorbelegs, so wie die Kassa vor dieser Korrektur verkettet hat (Befund A).
 * Nur zum ERKENNEN bestehender Ketten (`analysiereKette`) — neue Belege werden nie so verkettet.
 */
function verkettungswertAltform(vorbelegCode: string): string {
  return verkettungswert(vorbelegCode)
}

/** Ergebnis von `analysiereKette`. Indizes zählen ab 0 in der übergebenen Belegfolge. */
export interface KettenAnalyse {
  /** Der Startbeleg stimmt, und jeder Folgebeleg trägt den Verkettungswert nach Spezifikation ODER der Altform. */
  ok: boolean
  /** Anzahl der Folgebelege, deren Verkettungswert der Altform entspricht (Hash des QR-Codes statt der JWS-Form). */
  altformat: number
  /** Erster und letzter Folgebeleg in der Altform; null, wenn es keinen gibt. */
  ersterAltformatIndex:  number | null
  letzterAltformatIndex: number | null
  /** Ein Folgebeleg in der Altform steht NACH einem nach Spezifikation verketteten (z. B. ältere Programmversion eingespielt). */
  gemischt: boolean
  /** Erster Beleg, dessen Verkettungswert zu keiner der beiden Formen passt (Kettenbruch); sonst null. */
  ersterBruchIndex: number | null
}

/**
 * Wie `pruefeKette`, aber mit Blick auf bestehende Ketten: Kassen, die vor der Korrektur von Befund A Belege signiert haben,
 * tragen ab dem 2. Beleg die Altform (Hash des QR-Codes). Sie ist Teil des signierten Codes und lässt sich nicht ändern; die Belege
 * sind in Ordnung, nur nicht nach RKSV Anlage 1 Z 4 verkettet — Prüfprogramme der Finanz melden sie. Die Analyse erkennt die Altform
 * aus den Daten (kein gespeicherter Umschaltpunkt, funktioniert auch auf Backups und übertragenen Beständen):
 *
 * Jeder Folgebeleg muss in genau EINER der beiden Formen verkettet sein, sonst ist es ein Kettenbruch. Altform nach einem
 * Beleg nach Spezifikation ist kein Bruch (die Signatur schützt den Wert; die Verkettung dient dem Erkennen gelöschter oder
 * vertauschter Belege, und ein Treffer in einer von zwei Formen ändert das nicht), wird aber als `gemischt` ausgewiesen.
 * Der Übergang ist nahtlos: der erste Beleg nach der Korrektur hasht die JWS-Form seines alt verketteten Vorgängers.
 */
export function analysiereKette(
  kassenId: string,
  belege: ReadonlyArray<{ maschinenlesbareCode: string; sigVorbeleg: string }>,
): KettenAnalyse {
  const analyse: KettenAnalyse = {
    ok: true, altformat: 0, ersterAltformatIndex: null, letzterAltformatIndex: null, gemischt: false, ersterBruchIndex: null,
  }
  if (belege.length === 0) return analyse

  const erster = belege[0]
  if (!erster || erster.sigVorbeleg !== verkettungswertStartbeleg(kassenId)) return { ...analyse, ok: false, ersterBruchIndex: 0 }

  let nachSpezifikation = false
  for (let i = 1; i < belege.length; i++) {
    const vorgaenger = belege[i - 1]
    const aktuell    = belege[i]
    if (!vorgaenger || !aktuell) return { ...analyse, ok: false, ersterBruchIndex: i }

    if (aktuell.sigVorbeleg === verkettungswertFolgebeleg(vorgaenger.maschinenlesbareCode)) {
      nachSpezifikation = true
    } else if (aktuell.sigVorbeleg === verkettungswertAltform(vorgaenger.maschinenlesbareCode)) {
      analyse.altformat++
      analyse.ersterAltformatIndex ??= i
      analyse.letzterAltformatIndex = i
      if (nachSpezifikation) analyse.gemischt = true
    } else {
      return { ...analyse, ok: false, ersterBruchIndex: i }
    }
  }
  return analyse
}

/**
 * Prüft die Verkettung einer chronologisch geordneten Belegfolge streng nach Spezifikation.
 * Der gespeicherte `sigVorbeleg` jedes Belegs muss dem Verkettungswert aus
 * Kassen-ID (Startbeleg) bzw. dem maschinenlesbaren Code des Vorgängers (JWS-Form) entsprechen.
 * Bestehende Ketten aus der Zeit vor der Korrektur (Altform) fallen hier durch — `analysiereKette` erkennt sie.
 */
export function pruefeKette(
  kassenId: string,
  belege: ReadonlyArray<{ maschinenlesbareCode: string; sigVorbeleg: string }>,
): boolean {
  const analyse = analysiereKette(kassenId, belege)
  return analyse.ok && analyse.altformat === 0
}
