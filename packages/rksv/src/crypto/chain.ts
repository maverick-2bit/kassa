/**
 * SHA-256-Chaining für den RKSV-Signaturwert des Vorbelegs.
 *
 * Gemäß BMF Detailspezifikation §4 Abs. 3:
 *   - Startbeleg (kein Vorgänger): base64url( SHA-256( 0x00 × 32 ) )
 *   - Folgebeleg:                  base64url( SHA-256( base64url_decode(vorSignaturwert) ) )
 *
 * Wichtig: Es wird nicht der rohe Signaturwert weitergegeben, sondern dessen SHA-256-Hash.
 * Damit ist die Kette auch bei sehr langen ECDSA-Signaturen kompakt (immer 44 Zeichen base64url).
 */

import { createHash } from 'node:crypto'

const NULL_VEKTOR = Buffer.alloc(32, 0)

/**
 * Berechnet den SigVorbeleg-Wert für den Startbeleg.
 * Ergibt base64url( SHA-256( 32 × 0x00 ) ).
 */
export function startbelegVorSignatur(): string {
  return hashZuBase64Url(NULL_VEKTOR)
}

/**
 * Berechnet den SigVorbeleg-Wert aus dem Signaturwert des unmittelbaren Vorgängers.
 * @param vorSignaturwert  base64url-kodierter Signaturwert des Vorgängers
 */
export function folgebelegVorSignatur(vorSignaturwert: string): string {
  const decoded = Buffer.from(vorSignaturwert, 'base64url')
  return hashZuBase64Url(decoded)
}

function hashZuBase64Url(data: Buffer): string {
  return createHash('sha256').update(data).digest().toString('base64url')
}

/**
 * Prüft ob eine Signaturkette konsistent ist.
 * @param belege  Geordnete Liste von { signaturwert, sigVorbeleg }
 */
export function pruefeKette(
  belege: ReadonlyArray<{ signaturwert: string; sigVorbeleg: string }>,
): boolean {
  if (belege.length === 0) return true

  const erster = belege[0]
  if (!erster) return false
  if (erster.sigVorbeleg !== startbelegVorSignatur()) return false

  for (let i = 1; i < belege.length; i++) {
    const vorgaenger = belege[i - 1]
    const aktuell    = belege[i]
    if (!vorgaenger || !aktuell) return false
    if (aktuell.sigVorbeleg !== folgebelegVorSignatur(vorgaenger.signaturwert)) {
      return false
    }
  }

  return true
}
