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
 *
 * Die Verkettung (Sig-Voriger-Beleg) ist kein Beleg-Status, sondern eine Eigenschaft der Folge und steht daneben:
 * Belege aus Programmversionen bis 0.8.77 tragen ab dem 2. Beleg den Hash des QR-Codes ihres Vorgängers statt
 * der JWS-Compact-Form (RKSV Anlage 1 Z 4) — „Altformat". Der Wert ist signiert und unveränderlich, die Kette
 * gilt als geschlossen (`ketteOk`), die Altstrecke wird ausgewiesen (`ketteAltformat*`).
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
  /** Kette geschlossen: jeder Folgebeleg ist nach Spezifikation ODER im Altformat verkettet (kein Bruch, keine Lücke) */
  ketteOk:           z.boolean(),
  /** Folgebelege im Altformat (Hash des QR-Codes statt der JWS-Form, Programmversionen bis 0.8.77) */
  ketteAltformat:    z.number().int().default(0),
  /** Belegnummer des ersten / letzten Belegs im Altformat; null, wenn es keinen gibt */
  ketteAltformatVon: z.number().int().nullable().default(null),
  ketteAltformatBis: z.number().int().nullable().default(null),
  /** Altformat steht NACH einem nach Spezifikation verketteten Beleg (z. B. ältere Programmversion eingespielt) */
  ketteGemischt:     z.boolean().default(false),
  /** Belegnummer des ersten Belegs, dessen Verkettungswert zu keiner Form passt (Kettenbruch); sonst null */
  ketteBruchBeleg:   z.number().int().nullable().default(null),
  nummernLueckenlos: z.boolean(),
  dauerMs:           z.number().int(),
  /** nur auffällige Belege (Status ≠ gueltig), gekappt auf 500 */
  details:           z.array(SelbsttestBelegDetailSchema),
  detailsGekappt:    z.boolean(),
})
export type SignaturSelbsttestErgebnis = z.infer<typeof SignaturSelbsttestErgebnisSchema>
