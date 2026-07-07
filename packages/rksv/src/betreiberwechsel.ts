/**
 * Betreiberwechsel-Workflow
 *
 * Ablauf beim Verkauf oder Übernahme eines Betriebs:
 *
 * VERKÄUFER (alter Betreiber):
 *   1. Letzten Tagesabschluss (Monatsbeleg) erstellen
 *   2. Schlussbeleg erstellen
 *   3. DEP7-Export erstellen (Übergabedokument)
 *   4. Kasse bei FinanzOnline abmelden (Außerbetriebnahme)
 *   → Ergebnis: BetreiberwechselExport-Paket
 *
 * KÄUFER (neuer Betreiber):
 *   5. Neue SEE generieren (neues Zertifikat, neue UID)
 *   6. Neue Kasse bei FinanzOnline registrieren
 *   7. Startbeleg mit neuer Signaturkette erstellen
 *   8. Startbeleg bei FinanzOnline prüfen lassen
 *   → Kasse einsatzbereit unter neuer UID
 *
 * Die historischen Belege (DEP7-Export) bleiben beim alten Betreiber
 * archiviert (7 Jahre Aufbewahrungspflicht).
 */

import type {
  BetreiberwechselExport,
  BetreiberwechselImport,
  RawBeleg,
  SEEConfig,
  SignedBeleg,
} from './types.js'
import { signiereBeleg, Umsatzzaehler, type SignierungsKontext } from './beleg.js'
import { erstelleDEP7Export } from './dep.js'
import { FinanzOnlineClient } from './finanz-online.js'
import { generateSEE } from './see.js'

// ---------------------------------------------------------------------------
// Verkäufer-Seite: Kasse abgeben
// ---------------------------------------------------------------------------

export interface VerkaufsVorbereitung {
  /** Alle bisher signierten Belege der Kasse (aus DB laden) */
  alleBelege:           SignedBeleg[]
  kontext:              SignierungsKontext
  credentials:          { teilnehmerId: string; benutzerkennung: string; pin: string }
  /** Laufende Belegnummer für den Schlussbeleg */
  naechsteBelegNummer:  number
}

/**
 * Schritt 1–4: Schlussbeleg erstellen, DEP exportieren, FinanzOnline abmelden.
 *
 * @returns BetreiberwechselExport – dieses Paket wird dem Käufer übergeben
 *          (enthält DEP7-Archiv und alle Metadaten für lückenlose Dokumentation)
 */
export async function kasseAbgeben(
  vorbereitung: VerkaufsVorbereitung,
  umgebung: 'produktion' | 'test' = 'produktion',
): Promise<BetreiberwechselExport> {
  const { alleBelege, kontext, credentials, naechsteBelegNummer } = vorbereitung

  // Schlussbeleg erstellen
  const schlussRaw: RawBeleg = {
    kassenId:     kontext.see.kassenId,
    belegNummer:  naechsteBelegNummer,
    datumUhrzeit: new Date(),
    belegTyp:     'Schlussbeleg',
    positionen:   [],
  }
  const schlussbeleg = await signiereBeleg(schlussRaw, kontext)

  // DEP7-Export
  const depExport = erstelleDEP7Export([...alleBelege, schlussbeleg], kontext.see)

  // FinanzOnline: Kasse abmelden
  const foClient = new FinanzOnlineClient(umgebung)
  const abmeldung = await foClient.kasseAusserBetriebNehmen(kontext.see.kassenId, credentials)

  if (!abmeldung.erfolgreich) {
    throw new Error(`FinanzOnline Außerbetriebnahme fehlgeschlagen: ${abmeldung.fehler}`)
  }

  return {
    kassenId:            kontext.see.kassenId,
    exportDatum:         new Date().toISOString(),
    schlussbeleg,
    depExport,
    letzterBelegNummer:  naechsteBelegNummer,
    letzterSignaturwert: schlussbeleg.signaturwert,
  }
}

// ---------------------------------------------------------------------------
// Käufer-Seite: Kasse übernehmen
// ---------------------------------------------------------------------------

export interface UebernahmeErgebnis {
  startbeleg:    SignedBeleg
  kontext:       SignierungsKontext
  neueKassenId:  string
}

/**
 * Schritt 5–8: Neue SEE generieren, bei FinanzOnline registrieren, Startbeleg erstellen und prüfen.
 *
 * @param imp  Import-Paket mit dem BetreiberwechselExport des Verkäufers
 */
export async function kasseUebernehmen(
  imp: BetreiberwechselImport,
  firmenname: string,
  umgebung: 'produktion' | 'test' = 'produktion',
): Promise<UebernahmeErgebnis> {
  const neueKassenId = imp.neueKassenId ?? imp.export.kassenId

  // Neue SEE generieren (falls nicht schon in imp.neueSEEConfig vorhanden)
  const see: SEEConfig = imp.neueSEEConfig

  // Bei FinanzOnline registrieren
  const foClient = new FinanzOnlineClient(umgebung)
  const registrierung = await foClient.kasseInBetriebNehmen({
    kassenId:      neueKassenId,
    uid:           imp.neueUid,
    zertifikatDER: see.zertifikatDER,
    credentials:   imp.foCredentials,
    benutzerschluesselBase64: see.aesSchluessel.toString('base64'),
    vdaId:         see.zdaId,
    artSe:         see.zdaId === 'AT0' ? 'EIGENES_HSM' : 'HSM_DIENSTLEISTER',
  })

  if (!registrierung.erfolgreich) {
    throw new Error(`FinanzOnline Registrierung fehlgeschlagen: ${registrierung.fehler}`)
  }

  // Startbeleg – neue Signaturkette beginnt bei Belegnummer 1
  const umsatzzaehler = new Umsatzzaehler(0n)
  const kontext: SignierungsKontext = { see, umsatzzaehler }

  const startRaw: RawBeleg = {
    kassenId:     neueKassenId,
    belegNummer:  1,
    datumUhrzeit: new Date(),
    belegTyp:     'Startbeleg',
    positionen:   [],
  }
  const startbeleg = await signiereBeleg(startRaw, kontext)
  kontext.letzterBelegCode = startbeleg.maschinenlesbareCode

  // Startbeleg bei FinanzOnline prüfen
  const pruefung = await foClient.startbelegPruefen(startbeleg, imp.foCredentials)
  if (!pruefung.erfolgreich) {
    throw new Error(`Startbeleg-Prüfung fehlgeschlagen: ${pruefung.fehler}`)
  }

  return { startbeleg, kontext, neueKassenId }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Neue SEE für Übernahme generieren
// ---------------------------------------------------------------------------

export async function generiereNeuesEE(
  neueKassenId: string,
  neueUid: string,
  firmenname: string,
): Promise<SEEConfig> {
  return generateSEE({
    kassenId:       neueKassenId,
    uid:            neueUid,
    firmenname,
    gueltigkeitTage: 1826, // 5 Jahre
  })
}
