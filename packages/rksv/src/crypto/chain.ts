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
 * Die Kassa hat bis v0.8.77 den QR-Code gehasht (Befund A der RKSV-Prüfstrecke); die BMF-Beispieldaten
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
 * Prüft die Verkettung einer chronologisch geordneten Belegfolge.
 * Der gespeicherte `sigVorbeleg` jedes Belegs muss dem Verkettungswert aus
 * Kassen-ID (Startbeleg) bzw. dem maschinenlesbaren Code des Vorgängers (JWS-Form) entsprechen.
 */
export function pruefeKette(
  kassenId: string,
  belege: ReadonlyArray<{ maschinenlesbareCode: string; sigVorbeleg: string }>,
): boolean {
  if (belege.length === 0) return true

  const erster = belege[0]
  if (!erster) return false
  if (erster.sigVorbeleg !== verkettungswertStartbeleg(kassenId)) return false

  for (let i = 1; i < belege.length; i++) {
    const vorgaenger = belege[i - 1]
    const aktuell    = belege[i]
    if (!vorgaenger || !aktuell) return false
    if (aktuell.sigVorbeleg !== verkettungswertFolgebeleg(vorgaenger.maschinenlesbareCode)) {
      return false
    }
  }

  return true
}
