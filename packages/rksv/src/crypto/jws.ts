/**
 * JWS (RFC 7515) — RKSV signiert den Code als ES256-JWS.
 *
 * Eigenes Modul ohne Abhängigkeit zu `beleg.ts`/`chain.ts`: Verkettung und Belegsignierung brauchen beide die
 * Umrechnung QR-Code → JWS-Compact, und ein Import von `chain.ts` nach `beleg.ts` wäre ein Zirkel.
 * `beleg.ts` und `index.ts` exportieren die Funktionen weiterhin unter ihren bisherigen Namen.
 */

/** Fixer JWS-Header der RKSV-Suite R1: {"alg":"ES256"} (base64url) */
export const JWS_HEADER_B64URL: string =
  Buffer.from(JSON.stringify({ alg: 'ES256' }), 'utf8').toString('base64url')

/** JWS-Signing-Input: base64url(header) + "." + base64url(codeOhneSig) */
export function jwsSigningInput(codeOhneSig: string): string {
  return `${JWS_HEADER_B64URL}.${Buffer.from(codeOhneSig, 'utf8').toString('base64url')}`
}

/**
 * Rechnet die QR-Repräsentation in die JWS-Compact-Repräsentation um
 * (für den DEP-Export und die Verkettung): header.payload.signature, alles base64url.
 * Funktioniert auch für Ausfall-Belege (Marker wird base64url umkodiert).
 */
export function qrCodeZuJwsCompact(maschinenlesbareCode: string): string {
  const idx         = maschinenlesbareCode.lastIndexOf('_')
  const codeOhneSig = maschinenlesbareCode.slice(0, idx)
  const sigBase64   = maschinenlesbareCode.slice(idx + 1)
  const sigB64url   = Buffer.from(sigBase64, 'base64').toString('base64url')
  return `${jwsSigningInput(codeOhneSig)}.${sigB64url}`
}
