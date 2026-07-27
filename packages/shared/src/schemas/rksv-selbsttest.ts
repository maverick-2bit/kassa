import { z } from 'zod'

/**
 * RKSV-Signatur-Selbsttest: verifiziert alle gespeicherten Belege einer Kasse
 * gegen das SEE-Zertifikat und prüft Signaturkette + Belegnummern-Lückenlosigkeit.
 *
 * Status je Beleg:
 *  - gueltig:       ECDSA-Signatur (P1363) passt zu den Feldern
 *  - ausfall:       SEE-Ausfallbeleg — erwartungsgemäß unsigniert (RKSV-konform)
 *  - der_altformat: kryptographisch korrekt, aber DER-codiert (vor P1363-Fix
 *                   signierter Alt-Beleg) — Inhalt integer, Codierung alt
 *  - ungueltig:     Signatur passt nicht (Manipulation oder Defekt)
 */
export const SelbsttestStatusEnum = z.enum(['gueltig', 'ausfall', 'der_altformat', 'ungueltig'])
export type SelbsttestStatus = z.infer<typeof SelbsttestStatusEnum>

export const SelbsttestBelegDetailSchema = z.object({
  belegNummer: z.number().int(),
  belegDatum:  z.string(),
  belegTyp:    z.string(),
  status:      SelbsttestStatusEnum,
})
export type SelbsttestBelegDetail = z.infer<typeof SelbsttestBelegDetailSchema>

export const SignaturSelbsttestErgebnisSchema = z.object({
  kasseId:           z.string().uuid(),
  /** externe Kassen-ID (KID), wie am Beleg */
  kassenId:          z.string(),
  geprueft:          z.number().int(),
  gueltig:           z.number().int(),
  ausfall:           z.number().int(),
  derAltformat:      z.number().int(),
  ungueltig:         z.number().int(),
  ketteOk:           z.boolean(),
  nummernLueckenlos: z.boolean(),
  dauerMs:           z.number().int(),
  /** nur auffällige Belege (Status ≠ gueltig), gekappt auf 500 */
  details:           z.array(SelbsttestBelegDetailSchema),
  detailsGekappt:    z.boolean(),
})
export type SignaturSelbsttestErgebnis = z.infer<typeof SignaturSelbsttestErgebnisSchema>
