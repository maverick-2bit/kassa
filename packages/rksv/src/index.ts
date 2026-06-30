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
  BetreiberwechselExport,
  BetreiberwechselImport,
} from './types.js'

export { MWST_PROZENT, BELEG_AENDERT_ZAEHLER } from './types.js'

// Crypto
export { deriveAesKey, verschluesselUmsatzzaehler, entschluesselUmsatzzaehler } from './crypto/aes-icm.js'
export { startbelegVorSignatur, folgebelegVorSignatur, pruefeKette } from './crypto/chain.js'

// SEE
export { generateSEE, ladeSeInfo, signiere, verifiziere, zertifikatSN } from './see.js'
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
} from './beleg.js'
export type { SignierungsKontext, VerifizierbarerBeleg } from './beleg.js'

// DEP7 + DEP131
export { erstelleDEP7Export, mergeDEP7Exports, validiereDEP7, dep7ZuJson, dep7AusJson, erstelleDEP131Export, dep131ZuJson } from './dep.js'
export type { DEP7ValidationResult } from './dep.js'

// FinanzOnline
export { FinanzOnlineClient } from './finanz-online.js'

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
  static initialisieren(see: SEEConfig): { kasse: RKSVKasse; startbeleg: SignedBeleg } {
    const { beleg, kontext } = erstelleStartbeleg(see.kassenId, see)
    return { kasse: new RKSVKasse(kontext), startbeleg: beleg }
  }

  /**
   * Kasse aus dem Datenbankzustand wiederherstellen (nach Neustart).
   * @param umsatzzaehlerCent  Letzter gespeicherter Umsatzzählerstand
   * @param letzterSignaturwert Signaturwert des zuletzt gespeicherten Belegs
   */
  static wiederherstellen(
    see: SEEConfig,
    umsatzzaehlerCent: bigint,
    letzterSignaturwert: string,
  ): RKSVKasse {
    const umsatzzaehler = new Umsatzzaehler(umsatzzaehlerCent)
    return new RKSVKasse({ see, umsatzzaehler, letzterSignaturwert })
  }

  /** Beleg signieren und Kontext für nächsten Beleg aktualisieren */
  signiereBeleg(raw: RawBeleg): SignedBeleg {
    const beleg = signiereBeleg(raw, this.kontext)
    this.kontext.letzterSignaturwert = beleg.signaturwert
    return beleg
  }

  /** DEP7-Export für Finanzprüfung oder Archivierung */
  exportiereDEP(alleBelege: SignedBeleg[]): ReturnType<typeof erstelleDEP7Export> {
    return erstelleDEP7Export(alleBelege, this.kontext.see, this.kontext.see.kassenId)
  }

  /** Aktueller Umsatzzählerstand in Cent (für DB-Persistenz) */
  get umsatzzaehlerCent(): bigint {
    return this.kontext.umsatzzaehler.aktuell
  }

  /** Letzter Signaturwert (für DB-Persistenz) */
  get letzterSignaturwert(): string | undefined {
    return this.kontext.letzterSignaturwert
  }
}
