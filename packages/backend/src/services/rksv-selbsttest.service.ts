/**
 * RKSV-Signatur-Selbsttest: verifiziert alle gespeicherten Belege einer Kasse
 * gegen ihr SEE-Zertifikat (nur öffentliches Material, kein Private-Key-Zugriff)
 * und prüft die Signaturkette sowie die Lückenlosigkeit der Belegnummern.
 *
 * Erkennt drei Auffälligkeits-Klassen:
 *  - ausfall:       SEE-Ausfallbelege (Marker statt Signatur) — RKSV-konform
 *  - der_altformat: vor dem P1363-Fix signierte Alt-Belege (Signatur DER-codiert;
 *                   kryptographisch korrekt → Beleg integer, nur Codierung alt)
 *  - ungueltig:     Signatur passt nicht zu den Feldern (Manipulation/Defekt)
 */

import {
  istAusfallBeleg,
  pruefeKette,
  verifiziereBelegSignatur,
  verifiziereBelegSignaturAltDer,
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

  let gueltig = 0, ausfall = 0, derAltformat = 0, ungueltig = 0
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
        null:        r.betragNullCent,
        besonders:   r.betragBesondersCent,
      },
      umsatzzaehlerVerschluesselt: r.umsatzzaehlerVerschluesselt,
      zertifikatSN:                r.zertifikatSn,
      sigVorbeleg:                 r.sigVorbeleg,
      signaturwert:                r.signaturwert,
    }

    let status: SelbsttestStatus
    if (istAusfallBeleg(r.signaturwert)) {
      status = 'ausfall'; ausfall++
    } else if (verifiziereBelegSignatur(v, zertifikatDER)) {
      status = 'gueltig'; gueltig++
    } else if (verifiziereBelegSignaturAltDer(v, zertifikatDER)) {
      status = 'der_altformat'; derAltformat++
    } else {
      status = 'ungueltig'; ungueltig++
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

  const ketteOk = pruefeKette(
    kasse.kassenId,
    rows.map(r => ({ maschinenlesbareCode: r.maschinenlesbareCode, sigVorbeleg: r.sigVorbeleg })),
  )

  const ergebnis: SignaturSelbsttestErgebnis = {
    kasseId:           kasse.id,
    kassenId:          kasse.kassenId,
    geprueft:          rows.length,
    gueltig,
    ausfall,
    derAltformat,
    ungueltig,
    ketteOk,
    nummernLueckenlos,
    dauerMs:           Date.now() - start,
    details:           alleDetails.slice(0, DETAILS_CAP),
    detailsGekappt:    alleDetails.length > DETAILS_CAP,
  }

  return { ergebnis, alleDetails }
}
