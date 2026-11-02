/**
 * RKSV-Signatur-Selbsttest: verifiziert alle gespeicherten Belege einer Kasse
 * gegen ihr SEE-Zertifikat (nur öffentliches Material, kein Private-Key-Zugriff)
 * und prüft die Signaturkette sowie die Lückenlosigkeit der Belegnummern.
 *
 * Erkennt vier Auffälligkeits-Klassen:
 *  - ausfall:        SEE-Ausfallbelege (Marker statt Signatur) — RKSV-konform
 *  - der_altformat:  vor dem P1363-Fix signierte Alt-Belege (Signatur DER-codiert;
 *                    kryptographisch korrekt → Beleg integer, nur Codierung alt)
 *  - zeit_altformat: vor v0.8.75 in einem Container ohne TZ signierte Belege: die
 *                    Uhrzeit im QR-Code steht in UTC statt in Wiener Ortszeit
 *                    (kryptographisch korrekt → Beleg integer, Uhrzeit 1–2 h daneben)
 *  - ungueltig:      Signatur passt nicht zu den Feldern oder der gespeicherte
 *                    QR-Code weicht von ihnen ab (Manipulation/Defekt)
 *
 * Geprüft wird gegen den GESPEICHERTEN maschinenlesbaren Code: Der aus den Feldern
 * aufgebaute Code muss ihm gleichen, und seine Signatur muss zum Zertifikat passen.
 * (Die Uhrzeit allein aus `belegDatum` plus der aktuellen Zeitzone aufzubauen
 * würde nach der Umstellung auf feste Wiener Ortszeit jeden Altbeleg verwerfen.)
 *
 * Die Verkettung steht neben den Beleg-Status, weil sie eine Eigenschaft der Folge ist:
 * Belege aus Programmversionen vor der Korrektur tragen ab dem 2. Beleg den Hash des QR-Codes ihres Vorgängers
 * statt der JWS-Form (Altformat, `analysiereKette`). Das gilt als geschlossene Kette und wird
 * ausgewiesen (`ketteAltformat*`); ein Wert, der zu keiner der beiden Formen passt, bleibt
 * ein Kettenbruch (`ketteOk: false`, `ketteBruchBeleg`).
 */

import {
  analysiereKette,
  istAusfallBeleg,
  pruefeBelegSignatur,
  type VerifizierbarerBeleg,
} from '@kassa/rksv'
import type { SelbsttestBelegDetail, SelbsttestStatus, SignaturSelbsttestErgebnis } from '@kassa/shared'
import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { belege, kassen } from '../db/schema.js'

const DETAILS_CAP = 500

export interface SelbsttestResultat {
  ergebnis:    SignaturSelbsttestErgebnis
  /** ungekappte Liste für den CSV-Export */
  alleDetails: SelbsttestBelegDetail[]
}

export async function fuehreSignaturSelbsttestAus(
  db:        Db,
  mandantId: string,
  kasseId:   string,
): Promise<SelbsttestResultat | null> {
  const [kasse] = await db.select().from(kassen)
    .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse) return null

  const start = Date.now()
  const zertifikatDER = Buffer.from(kasse.seeZertifikatDer, 'base64')

  const rows = await db.select().from(belege)
    .where(eq(belege.kasseId, kasse.id))
    .orderBy(asc(belege.belegNummer))

  let gueltig = 0, ausfall = 0, derAltformat = 0, zeitAltformat = 0, ungueltig = 0
  const alleDetails: SelbsttestBelegDetail[] = []

  for (const r of rows) {
    const v: VerifizierbarerBeleg = {
      zdaId:        kasse.seeZdaId,
      kassenId:     kasse.kassenId,
      belegNummer:  r.belegNummer,
      datumUhrzeit: r.belegDatum,
      betraege: {
        normal:      r.betragNormalCent,
        ermaessigt1: r.betragErmaessigt1Cent,
        ermaessigt2: r.betragErmaessigt2Cent,
        ermaessigt3: r.betragErmaessigt3Cent,
        null:        r.betragNullCent,
        besonders:   r.betragBesondersCent,
      },
      umsatzzaehlerVerschluesselt: r.umsatzzaehlerVerschluesselt,
      zertifikatSN:                r.zertifikatSn,
      sigVorbeleg:                 r.sigVorbeleg,
      signaturwert:                r.signaturwert,
      maschinenlesbareCode:        r.maschinenlesbareCode,
    }

    let status: SelbsttestStatus
    if (istAusfallBeleg(r.signaturwert)) {
      status = 'ausfall'; ausfall++
    } else {
      switch (pruefeBelegSignatur(v, zertifikatDER)) {
        case 'gueltig':        status = 'gueltig';        gueltig++;       break
        case 'zeit_altformat': status = 'zeit_altformat'; zeitAltformat++; break
        case 'der_altformat':  status = 'der_altformat';  derAltformat++;  break
        default:               status = 'ungueltig';      ungueltig++
      }
    }

    if (status !== 'gueltig') {
      alleDetails.push({
        belegNummer: r.belegNummer,
        belegDatum:  r.belegDatum.toISOString(),
        belegTyp:    r.belegTyp,
        status,
      })
    }
  }

  let nummernLueckenlos = true
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.belegNummer !== rows[i - 1]!.belegNummer + 1) { nummernLueckenlos = false; break }
  }

  const kette = analysiereKette(
    kasse.kassenId,
    rows.map(r => ({ maschinenlesbareCode: r.maschinenlesbareCode, sigVorbeleg: r.sigVorbeleg })),
  )
  const belegNummerAn = (index: number | null): number | null => (index === null ? null : rows[index]?.belegNummer ?? null)

  const ergebnis: SignaturSelbsttestErgebnis = {
    kasseId:           kasse.id,
    kassenId:          kasse.kassenId,
    geprueft:          rows.length,
    gueltig,
    ausfall,
    derAltformat,
    zeitAltformat,
    ungueltig,
    ketteOk:           kette.ok,
    ketteAltformat:    kette.altformat,
    ketteAltformatVon: belegNummerAn(kette.ersterAltformatIndex),
    ketteAltformatBis: belegNummerAn(kette.letzterAltformatIndex),
    ketteGemischt:     kette.gemischt,
    ketteBruchBeleg:   belegNummerAn(kette.ersterBruchIndex),
    nummernLueckenlos,
    dauerMs:           Date.now() - start,
    details:           alleDetails.slice(0, DETAILS_CAP),
    detailsGekappt:    alleDetails.length > DETAILS_CAP,
  }

  return { ergebnis, alleDetails }
}
