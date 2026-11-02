import { z } from 'zod'

/**
 * RKSV-Signatur-Selbsttest: verifiziert alle gespeicherten Belege einer Kasse
 * gegen das SEE-Zertifikat und prüft Signaturkette + Belegnummern-Lückenlosigkeit.
 *
 * Status je Beleg:
 *  - gueltig:        ECDSA-Signatur (P1363) passt zu den Feldern UND zum gespeicherten
 *                    QR-Code; Zeit in Wiener Ortszeit
 *  - ausfall:        SEE-Ausfallbeleg — erwartungsgemäß unsigniert (RKSV-konform)
 *  - der_altformat:  kryptographisch korrekt, aber DER-codiert (vor P1363-Fix
 *                    signierter Alt-Beleg) — Inhalt integer, Codierung alt
 *  - zeit_altformat: kryptographisch korrekt, aber die Uhrzeit im QR-Code steht in
 *                    UTC statt in Wiener Ortszeit (Beleg aus einem Container ohne
 *                    TZ, vor v0.8.75) — Inhalt integer, Uhrzeit 1 bis 2 h daneben
 *  - ungueltig:      Signatur passt nicht (Manipulation oder Defekt)
 */
export const SelbsttestStatusEnum = z.enum(['gueltig', 'ausfall', 'der_altformat', 'zeit_altformat', 'ungueltig'])
export type SelbsttestStatus = z.infer<typeof SelbsttestStatusEnum>

export const SelbsttestBelegDetailSchema = z.object({
  belegNummer: z.number().int(),
  belegDatum:  z.string(),
  belegTyp:    z.string(),
  status:      SelbsttestStatusEnum,
})
export type SelbsttestBelegDetail = z.infer<typeof SelbsttestBelegDetailSchema>

export const SignaturSelbsttestErgebnisSchema = z.object({
  kasseId:           z.string().guid(),
  /** externe Kassen-ID (KID), wie am Beleg */
  kassenId:          z.string(),
  geprueft:          z.number().int(),
  gueltig:           z.number().int(),
  ausfall:           z.number().int(),
  derAltformat:      z.number().int(),
  /** Signatur gültig, aber QR-Uhrzeit nicht in Wiener Ortszeit (siehe Status zeit_altformat) */
  zeitAltformat:     z.number().int().default(0),
  ungueltig:         z.number().int(),
  ketteOk:           z.boolean(),
  nummernLueckenlos: z.boolean(),
  dauerMs:           z.number().int(),
  /** nur auffällige Belege (Status ≠ gueltig), gekappt auf 500 */
  details:           z.array(SelbsttestBelegDetailSchema),
  detailsGekappt:    z.boolean(),
})
export type SignaturSelbsttestErgebnis = z.infer<typeof SignaturSelbsttestErgebnisSchema>
