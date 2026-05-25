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
  see: SEEConfig,
  kassenId: string,
): DEP7Export {
  const zertBase64 = see.zertifikatDER.toString('base64')

  const dep7Belege: string[] = belege.map(b => b.maschinenlesbareCode)

  const package_: DEP7BelegPackage = {
    Signaturzertifikat:      zertBase64,
    Zertifizierungsstellen:  [], // leer bei self-signed
    Belege:                  dep7Belege,
  }

  return {
    exportDatum: new Date().toISOString(),
    kassenId,
    Belege: [package_],
  }
}

/**
 * Zusammenführen mehrerer DEP7-Exporte (z. B. nach Betreiberwechsel).
 * Die Packages werden der Reihe nach angehängt.
 */
export function mergeDEP7Exports(...exporte: DEP7Export[]): DEP7Export {
  if (exporte.length === 0) throw new Error('Keine Exporte angegeben')
  const erster = exporte[0]
  if (!erster) throw new Error('Keine Exporte angegeben')

  return {
    exportDatum: new Date().toISOString(),
    kassenId:    erster.kassenId,
    Belege:      exporte.flatMap(e => e.Belege),
  }
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

  if (!dep.kassenId) fehler.push('kassenId fehlt')
  if (!dep.exportDatum) fehler.push('exportDatum fehlt')
  if (!Array.isArray(dep.Belege) || dep.Belege.length === 0) {
    fehler.push('Keine Belegpackages vorhanden')
    return { gueltig: false, anzahlBelege: 0, fehler }
  }

  let anzahlBelege = 0

  for (const pkg of dep.Belege) {
    if (!pkg.Signaturzertifikat) fehler.push('Package ohne Signaturzertifikat')
    if (!Array.isArray(pkg.Belege)) {
      fehler.push('Package.Belege ist kein Array')
      continue
    }

    for (const belegCode of pkg.Belege) {
      if (!belegCode.startsWith('_R1-AT_')) {
        fehler.push(`Ungültiger Beleg-Code: ${belegCode.substring(0, 30)}...`)
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
    !('kassenId' in parsed) || !('Belege' in parsed)
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
