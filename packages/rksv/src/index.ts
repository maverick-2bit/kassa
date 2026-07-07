/**
 * @kassa/rksv – RKSV-Kernmodul
 *
 * Österreichische Registrierkassensicherheitsverordnung (RKSV)
 * Vollständige Software-Implementierung ohne externe Abhängigkeiten.
 *
 * Hauptklassen:
 *   - RKSVKasse       → Täglicher Kassenbetrieb (Belege signieren)
 *   - FinanzOnlineClient → FinanzOnline-Anbindung
 *   - Betreiberwechsel  → Übergabe bei Unternehmensverkauf
 */

// Typen
export type {
  MwStSatz,
  BelegTyp,
  BelegPosition,
  BetraegeSummen,
  RawBeleg,
  SignedBeleg,
  SEEConfig,
  SEEInfo,
  DEP7Export,
  DEP7BelegPackage,
  DEP131BelegInput,
  DEP131Beleg,
  DEP131Export,
  FinanzOnlineCredentials,
  KassenRegistrierung,
  RegistrierungErgebnis,
  ArtSe,
  BetreiberwechselExport,
  BetreiberwechselImport,
} from './types.js'

export { MWST_PROZENT, BELEG_AENDERT_ZAEHLER } from './types.js'

// Crypto
export { generiereAesSchluessel, berechneIV, verschluesselUmsatzzaehler, entschluesselUmsatzzaehler } from './crypto/aes-icm.js'
export { verkettungswertStartbeleg, verkettungswertFolgebeleg, pruefeKette } from './crypto/chain.js'

// SEE
export { generateSEE, ladeSeInfo, signiereRoh, verifiziere, zertifikatSN } from './see.js'

// Signatureinheiten (Software / A-Trust HSM)
export {
  SoftwareSignaturEinheit,
  ATrustHsmEinheit,
  ATrustHsmError,
  ATRUST_ABNAHME_BASIS_URL,
  ATRUST_PRODUKTION_BASIS_URL,
} from './see/signatur-einheit.js'
export type { SignaturEinheit, ZertifikatInfo, ATrustHsmConfig } from './see/signatur-einheit.js'
export type { SEEGenerierungsOptionen } from './see.js'

// Beleg
export {
  Umsatzzaehler,
  berechneBetraege,
  gesamtBetragCent,
  signiereBeleg,
  erstelleStartbeleg,
  erstelleNullbeleg,
  verifiziereBelegSignatur,
  verifiziereQrCode,
  jwsSigningInput,
  qrCodeZuJwsCompact,
  JWS_HEADER_B64URL,
  SEE_AUSFALL_SIGNATUR,
  istAusfallBeleg,
} from './beleg.js'
export type { SignierungsKontext, VerifizierbarerBeleg } from './beleg.js'

// DEP7 + DEP131
export { erstelleDEP7Export, mergeDEP7Exports, validiereDEP7, dep7ZuJson, dep7AusJson, erstelleDEP131Export, dep131ZuJson } from './dep.js'
export type { DEP7ValidationResult } from './dep.js'

// FinanzOnline
export { FinanzOnlineClient, zertSeriennummerDezimal } from './finanz-online.js'
export { fonLogin, fonLogout } from './fon/session.js'
export {
  baueRkdbBody,
  datensatzRegistrierungSe,
  datensatzRegistrierungKasse,
  rkdbRegistriere,
  rkdbStatusKasse,
  rkdbStatusSe,
} from './fon/rkdb.js'
export { xmlEscape, extractValue, extractAll, soapEnvelope, FonSoapError } from './fon/soap.js'

// Setup-Orchestrierung (automatische Einrichtung)
export {
  kasseAutomatischEinrichten,
  validiereKasseEinrichtenInput,
} from './setup.js'
export type {
  KasseEinrichtenInput,
  KasseEinrichtenOptionen,
  KasseEinrichtenErgebnis,
  EinrichtungsSchritt,
  EinrichtungsSchrittTyp,
} from './setup.js'

// Betreiberwechsel
export {
  kasseAbgeben,
  kasseUebernehmen,
  generiereNeuesEE,
} from './betreiberwechsel.js'
export type { VerkaufsVorbereitung, UebernahmeErgebnis } from './betreiberwechsel.js'

// ---------------------------------------------------------------------------
// Hochrangige Fassade: RKSVKasse
// ---------------------------------------------------------------------------

import type { RawBeleg, SEEConfig, SignedBeleg } from './types.js'
import { Umsatzzaehler, signiereBeleg, erstelleStartbeleg, type SignierungsKontext } from './beleg.js'
import { erstelleDEP7Export } from './dep.js'

/**
 * Einfache Fassade für den täglichen Kassenbetrieb.
 * Kapselt Umsatzzähler und Signierungskontext.
 *
 * Verwendung:
 *   const kasse = await RKSVKasse.initialisieren(see)
 *   const beleg = kasse.signiereBeleg(rawBeleg)
 *   const dep   = kasse.exportiereDEP(alleBelege)
 */
export class RKSVKasse {
  private kontext: SignierungsKontext

  private constructor(kontext: SignierungsKontext) {
    this.kontext = kontext
  }

  /** Neue Kasse initialisieren und Startbeleg erstellen */
  static async initialisieren(see: SEEConfig): Promise<{ kasse: RKSVKasse; startbeleg: SignedBeleg }> {
    const { beleg, kontext } = await erstelleStartbeleg(see.kassenId, see)
    return { kasse: new RKSVKasse(kontext), startbeleg: beleg }
  }

  /**
   * Kasse aus dem Datenbankzustand wiederherstellen (nach Neustart).
   * @param umsatzzaehlerCent  Letzter gespeicherter Umsatzzählerstand
   * @param letzterBelegCode   Maschinenlesbarer Code des zuletzt gespeicherten Belegs
   */
  static wiederherstellen(
    see: SEEConfig,
    umsatzzaehlerCent: bigint,
    letzterBelegCode: string,
  ): RKSVKasse {
    const umsatzzaehler = new Umsatzzaehler(umsatzzaehlerCent)
    return new RKSVKasse({ see, umsatzzaehler, letzterBelegCode })
  }

  /** Beleg signieren und Kontext für nächsten Beleg aktualisieren */
  async signiereBeleg(raw: RawBeleg): Promise<SignedBeleg> {
    const beleg = await signiereBeleg(raw, this.kontext)
    this.kontext.letzterBelegCode = beleg.maschinenlesbareCode
    return beleg
  }

  /** DEP7-Export für Finanzprüfung oder Archivierung */
  exportiereDEP(alleBelege: SignedBeleg[]): ReturnType<typeof erstelleDEP7Export> {
    return erstelleDEP7Export(alleBelege, this.kontext.see)
  }

  /** Aktueller Umsatzzählerstand in Cent (für DB-Persistenz) */
  get umsatzzaehlerCent(): bigint {
    return this.kontext.umsatzzaehler.aktuell
  }

  /** Maschinenlesbarer Code des letzten Belegs (für DB-Persistenz) */
  get letzterBelegCode(): string | undefined {
    return this.kontext.letzterBelegCode
  }
}
