/**
 * DEP7 – Datenerfassungsprotokoll
 *
 * Das DEP ist das gesetzlich vorgeschriebene Archiv aller Belege (7 Jahre Aufbewahrungspflicht).
 * Es wird bei Finanzprüfungen oder auf Anforderung des Finanzamts übergeben.
 *
 * Format: JSON gemäß BMF DEP7-Spezifikation.
 * Referenz: https://www.bmf.gv.at/dam/jcr:7a94c4b1-8abc-4ee9-9e96-1b8dbf7ef2a8/RKSV_DEP7.pdf
 */

import type {
  DEP7BelegPackage,
  DEP7Export,
  DEP131BelegInput,
  DEP131Export,
  SEEConfig,
  SignedBeleg,
} from './types.js'

// ---------------------------------------------------------------------------
// DEP7-Export erstellen
// ---------------------------------------------------------------------------

/**
 * Erstellt einen DEP7-Export aus einer Liste signierter Belege.
 *
 * Die Belege werden in Packages gruppiert — ein neues Package beginnt,
 * wenn das SEE-Zertifikat wechselt (z. B. nach Betreiberwechsel).
 *
 * @param belege    Chronologisch geordnete Liste aller Belege
 * @param see       Aktuelle SEE-Konfiguration (Zertifikat für diesen Export)
 * @param kassenId  Kassen-ID
 */
export function erstelleDEP7Export(
  belege: SignedBeleg[],
  see: Pick<SEEConfig, 'zertifikatDER'>,
): DEP7Export {
  const zertBase64 = see.zertifikatDER.toString('base64')

  // Belege-kompakt = JWS-Compact-Repräsentation (Detailspezifikation Abs. 3)
  const belegeKompakt: string[] = belege.map(b => b.jwsCompact)

  const package_: DEP7BelegPackage = {
    Signaturzertifikat:      zertBase64,
    Zertifizierungsstellen:  [], // leer bei self-signed
    'Belege-kompakt':        belegeKompakt,
  }

  return { 'Belege-Gruppe': [package_] }
}

/**
 * Zusammenführen mehrerer DEP7-Exporte (z. B. nach Betreiberwechsel /
 * Zertifikatswechsel). Die Packages werden der Reihe nach angehängt.
 */
export function mergeDEP7Exports(...exporte: DEP7Export[]): DEP7Export {
  if (exporte.length === 0) throw new Error('Keine Exporte angegeben')

  return { 'Belege-Gruppe': exporte.flatMap(e => e['Belege-Gruppe']) }
}

// ---------------------------------------------------------------------------
// DEP7-Validierung (für Finanzprüfung / Tests)
// ---------------------------------------------------------------------------

export interface DEP7ValidationResult {
  gueltig:       boolean
  anzahlBelege:  number
  fehler:        string[]
}

/**
 * Prüft ein DEP7-Export auf formale Korrektheit.
 * Prüft nicht die kryptographischen Signaturen (das macht die Finanzbehörde).
 */
export function validiereDEP7(dep: DEP7Export): DEP7ValidationResult {
  const fehler: string[] = []

  const gruppen = dep['Belege-Gruppe']
  if (!Array.isArray(gruppen) || gruppen.length === 0) {
    fehler.push('Keine Belege-Gruppe vorhanden')
    return { gueltig: false, anzahlBelege: 0, fehler }
  }

  let anzahlBelege = 0

  for (const pkg of gruppen) {
    if (!pkg.Signaturzertifikat) fehler.push('Gruppe ohne Signaturzertifikat')
    const kompakt = pkg['Belege-kompakt']
    if (!Array.isArray(kompakt)) {
      fehler.push('Belege-kompakt ist kein Array')
      continue
    }

    for (const jws of kompakt) {
      // JWS compact: header.payload.signature — Payload dekodiert beginnt mit _R1-
      const teile = jws.split('.')
      const payload = teile[1] ? Buffer.from(teile[1], 'base64url').toString('utf8') : ''
      if (teile.length !== 3 || !payload.startsWith('_R1-')) {
        fehler.push(`Ungültiger Beleg (kein RKSV-JWS): ${jws.substring(0, 30)}...`)
      } else {
        anzahlBelege++
      }
    }
  }

  return {
    gueltig:      fehler.length === 0,
    anzahlBelege,
    fehler,
  }
}

// ---------------------------------------------------------------------------
// JSON-Serialisierung
// ---------------------------------------------------------------------------

export function dep7ZuJson(dep: DEP7Export): string {
  return JSON.stringify(dep, null, 2)
}

export function dep7AusJson(json: string): DEP7Export {
  const parsed = JSON.parse(json) as unknown
  if (
    typeof parsed !== 'object' || parsed === null ||
    !('Belege-Gruppe' in parsed)
  ) {
    throw new Error('Ungültiges DEP7-Format')
  }
  return parsed as DEP7Export
}

// ---------------------------------------------------------------------------
// DEP131 – Erweiterter Export (§131 BAO, vollständige Belegdaten)
// ---------------------------------------------------------------------------

/**
 * Erstellt einen DEP131-Export aus strukturierten Belegdaten.
 *
 * DEP131 enthält im Gegensatz zu DEP7 die vollständigen Positionen,
 * Betraege, Zahlungsaufteilung und alle RKSV-Signaturfelder — lesbar
 * für Menschen und maschinell verarbeitbar.
 *
 * @param belege    Chronologisch geordnete Liste aller Belege
 * @param kassenId  RKSV-Kassen-ID (nicht die UUID)
 */
export function erstelleDEP131Export(
  belege: DEP131BelegInput[],
  kassenId: string,
): DEP131Export {
  return {
    exportDatum: new Date().toISOString(),
    kassenId,
    Belege: belege.map(b => ({
      Belegtyp:    b.belegTyp,
      Belegnummer: b.belegNummer,
      DatumUhrzeit: b.datumUhrzeit.toISOString(),
      Positionen: b.positionen.map(p => ({
        Bezeichnung:            p.bezeichnung,
        Menge:                  p.menge,
        EinzelpreisBreuttoCent: p.einzelpreisBreutto,
        MwStSatz:               p.mwstSatz,
      })),
      Betraege: {
        NormalCent:      b.betraege.normal,
        Ermaessigt1Cent: b.betraege.ermaessigt1,
        Ermaessigt2Cent: b.betraege.ermaessigt2,
        NullCent:        b.betraege.null,
        BesondersCent:   b.betraege.besonders,
      },
      Zahlung: {
        BarCent:      b.zahlung.barCent,
        KarteCent:    b.zahlung.karteCent,
        SonstigeCent: b.zahlung.sonstigeCent,
      },
      MaschinenlesbareCode:        b.maschinenlesbareCode,
      Signaturwert:                b.signaturwert,
      UmsatzzaehlerVerschluesselt: b.umsatzzaehlerVerschluesselt,
      ZertifikatSN:                b.zertifikatSN,
      SigVorbeleg:                 b.sigVorbeleg,
    })),
  }
}

export function dep131ZuJson(dep: DEP131Export): string {
  return JSON.stringify(dep, null, 2)
}
