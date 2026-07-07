/**
 * RKSV-Verkettungswert gemäß BMF-Detailspezifikation:
 *
 *   Verkettungswert = BASE64_STD( erste 8 Byte von SHA-256(Input) )
 *
 *   - Startbeleg (kein Vorgänger): Input = Kassen-Identifikationsnummer
 *   - Folgebeleg:                  Input = KOMPLETTER maschinenlesbarer Code
 *                                  des Vorbelegs (QR-Repräsentation inkl. Signatur)
 *
 * Referenzwert-Beispiel (BMF-Mustercode): `cg8hNU5ihto=` — 8 Byte,
 * Standard-Base64 mit Padding (12 Zeichen).
 */

import { createHash } from 'node:crypto'

function verkettungswert(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest().subarray(0, 8).toString('base64')
}

/** Verkettungswert für den Startbeleg: Input ist die Kassen-ID. */
export function verkettungswertStartbeleg(kassenId: string): string {
  return verkettungswert(kassenId)
}

/** Verkettungswert für Folgebelege: Input ist der komplette maschinenlesbare Code des Vorbelegs. */
export function verkettungswertFolgebeleg(vorbelegCode: string): string {
  return verkettungswert(vorbelegCode)
}

/**
 * Prüft die Verkettung einer chronologisch geordneten Belegfolge.
 * Der gespeicherte `sigVorbeleg` jedes Belegs muss dem Verkettungswert aus
 * Kassen-ID (Startbeleg) bzw. dem maschinenlesbaren Code des Vorgängers entsprechen.
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
