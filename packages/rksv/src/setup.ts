/**
 * Automatische Kasseneinrichtung
 *
 * Orchestriert den vollständigen Einrichtungs-Workflow nach der ersten Inbetriebnahme:
 *
 *   1. SEE generieren (Software-Zertifikat ECDSA P-256)
 *   2. SEE bei FinanzOnline registrieren
 *   3. Kasse bei FinanzOnline registrieren (verknüpft Kassen-ID mit UID)
 *   4. Startbeleg erstellen (signiert + RKSV-konform)
 *   5. Startbeleg bei FinanzOnline prüfen lassen (Pflicht!)
 *
 * Diese Funktion wird vom Setup-Formular aufgerufen, sobald der Benutzer
 * alle Eingabefelder ausgefüllt und auf "Kasse einrichten" geklickt hat.
 *
 * Eingabefelder (UI-Formular):
 *   ┌─ Unternehmensdaten ─────────────────────────────┐
 *   │ • Firmenname              (Text, Pflicht)       │
 *   │ • UID                     (ATU12345678 Format)  │
 *   ├─ Kasse ─────────────────────────────────────────┤
 *   │ • Kassen-ID               (z.B. "KASSE-001")    │
 *   ├─ FinanzOnline-Zugang ───────────────────────────┤
 *   │ • Teilnehmer-ID (TID)     (Text)                │
 *   │ • Benutzerkennung (BenID) (Text)                │
 *   │ • PIN                     (Passwort)            │
 *   ├─ Umgebung ──────────────────────────────────────┤
 *   │ ◯ Test  ◉ Produktion                            │
 *   └─────────────────────────────────────────────────┘
 */

import type {
  FinanzOnlineCredentials,
  SEEConfig,
  SignedBeleg,
} from './types.js'
import { generateSEE } from './see.js'
import { FinanzOnlineClient } from './finanz-online.js'
import { erstelleStartbeleg } from './beleg.js'

// ---------------------------------------------------------------------------
// Eingabedaten (entsprechen den UI-Formularfeldern)
// ---------------------------------------------------------------------------

export interface KasseEinrichtenInput {
  /** Firmenname (z.B. "Restaurant Mustermann GmbH") */
  firmenname: string
  /** Österreichische UID (Format: ATU + 8 Ziffern) */
  uid: string
  /** Eindeutige Kassen-Identifikationsnummer (z.B. "KASSE-001") */
  kassenId: string
  /**
   * FinanzOnline-Zugangsdaten. Optional: Fehlen sie, wird die Kasse OHNE
   * FinanzOnline-Registrierung eingerichtet (provisorisch, z. B. am Event) —
   * SEE + Startbeleg werden lokal erstellt, die FON-Registrierung ist später
   * nachzutragen.
   */
  finanzOnline?: FinanzOnlineCredentials
  /** 'test' für FinanzOnline-Testumgebung, 'produktion' für Echtbetrieb */
  umgebung?: 'produktion' | 'test'
  /** Gültigkeitsdauer des Zertifikats in Tagen (Standard: 1826 = 5 Jahre) */
  zertifikatGueltigkeitTage?: number
}

// ---------------------------------------------------------------------------
// Schritt-für-Schritt Fortschritt (für UI-Statusanzeige)
// ---------------------------------------------------------------------------

export type EinrichtungsSchrittTyp =
  | 'eingabe-validierung'
  | 'see-generierung'
  | 'finanzonline-registrierung'
  | 'startbeleg-erstellung'
  | 'startbeleg-pruefung'

export interface EinrichtungsSchritt {
  schritt:     EinrichtungsSchrittTyp
  status:      'startet' | 'erfolgreich' | 'fehler'
  meldung:     string
  zeitstempel: Date
}

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

export interface KasseEinrichtenErgebnis {
  erfolgreich: boolean
  /** SEE-Konfiguration — MUSS persistent gespeichert werden (mit verschlüsseltem privaten Schlüssel!) */
  see?: SEEConfig
  /** Signierter Startbeleg (für DEP-Archiv) */
  startbeleg?: SignedBeleg
  /** Signaturwert des Startbelegs — Basis für die Signaturkette */
  letzterSignaturwert?: string
  /** Prüfwert von FinanzOnline (Bestätigung der Inbetriebnahme) */
  pruefwert?: string
  /**
   * true, wenn die Kasse bei FinanzOnline registriert und der Startbeleg
   * geprüft wurde. false = provisorisch ohne FON eingerichtet (nachzutragen).
   */
  fonRegistriert: boolean
  /** Alle ausgeführten Schritte mit Status (für UI und Protokollierung) */
  schritte: EinrichtungsSchritt[]
  /** Erste fehlgeschlagene Schritt-Meldung */
  fehler?: string
}

// ---------------------------------------------------------------------------
// Optionen (Dependency-Injection für Tests)
// ---------------------------------------------------------------------------

export interface KasseEinrichtenOptionen {
  /** Callback für UI-Statusanzeige */
  onSchritt?: (schritt: EinrichtungsSchritt) => void
  /** Vorkonfigurierter Client (für Tests/Mocks) */
  finanzOnlineClient?: FinanzOnlineClient
}

// ---------------------------------------------------------------------------
// Eingabevalidierung
// ---------------------------------------------------------------------------

const UID_REGEX = /^ATU\d{8}$/

export function validiereKasseEinrichtenInput(input: KasseEinrichtenInput): string[] {
  const fehler: string[] = []

  if (!input.firmenname?.trim()) {
    fehler.push('Firmenname ist erforderlich')
  }
  if (!input.uid?.trim()) {
    fehler.push('UID ist erforderlich')
  } else if (!UID_REGEX.test(input.uid)) {
    fehler.push('UID ungültig (Format: ATU + 8 Ziffern, z.B. ATU12345678)')
  }
  if (!input.kassenId?.trim()) {
    fehler.push('Kassen-ID ist erforderlich')
  }
  // FinanzOnline ist optional (provisorische Einrichtung). Wird aber ETWAS
  // angegeben, müssen alle drei Felder vorhanden sein.
  const fo = input.finanzOnline
  const foAngegeben = !!(fo && (fo.teilnehmerId?.trim() || fo.benutzerkennung?.trim() || fo.pin?.trim()))
  if (foAngegeben) {
    if (!fo!.teilnehmerId?.trim())    fehler.push('FinanzOnline Teilnehmer-ID (TID) ist erforderlich')
    if (!fo!.benutzerkennung?.trim()) fehler.push('FinanzOnline Benutzerkennung (BenID) ist erforderlich')
    if (!fo!.pin?.trim())             fehler.push('FinanzOnline PIN ist erforderlich')
  }

  return fehler
}

// ---------------------------------------------------------------------------
// Hauptfunktion: Vollständige Kasseneinrichtung
// ---------------------------------------------------------------------------

/**
 * Richtet eine neue Kasse vollständig ein.
 *
 * Bei jedem Schritt wird `onSchritt` aufgerufen (sofern angegeben), damit
 * das UI den Fortschritt anzeigen kann. Bei einem Fehler bricht die Funktion
 * ab und gibt das bisher Erreichte zurück.
 *
 * @example
 * ```typescript
 * const ergebnis = await kasseAutomatischEinrichten({
 *   firmenname: "Mustermann GmbH",
 *   uid: "ATU12345678",
 *   kassenId: "KASSE-001",
 *   finanzOnline: { teilnehmerId: "...", benutzerkennung: "...", pin: "..." },
 *   umgebung: "test",
 * }, {
 *   onSchritt: (s) => console.log(`[${s.schritt}] ${s.status}: ${s.meldung}`),
 * })
 *
 * if (ergebnis.erfolgreich) {
 *   await db.see.speichere(ergebnis.see!)
 *   await db.belege.speichere(ergebnis.startbeleg!)
 * }
 * ```
 */
export async function kasseAutomatischEinrichten(
  input: KasseEinrichtenInput,
  optionen: KasseEinrichtenOptionen = {},
): Promise<KasseEinrichtenErgebnis> {
  const schritte: EinrichtungsSchritt[] = []

  const log = (
    schritt: EinrichtungsSchrittTyp,
    status: EinrichtungsSchritt['status'],
    meldung: string,
  ): void => {
    const eintrag: EinrichtungsSchritt = { schritt, status, meldung, zeitstempel: new Date() }
    schritte.push(eintrag)
    optionen.onSchritt?.(eintrag)
  }

  // -------------------------------------------------------------------------
  // 0. Eingabevalidierung
  // -------------------------------------------------------------------------
  log('eingabe-validierung', 'startet', 'Prüfe Eingabedaten...')
  const validierungFehler = validiereKasseEinrichtenInput(input)
  if (validierungFehler.length > 0) {
    const meldung = validierungFehler.join('; ')
    log('eingabe-validierung', 'fehler', meldung)
    return { erfolgreich: false, fonRegistriert: false, schritte, fehler: meldung }
  }
  log('eingabe-validierung', 'erfolgreich', 'Eingabedaten gültig')

  const umgebung = input.umgebung ?? 'produktion'
  const foClient = optionen.finanzOnlineClient ?? new FinanzOnlineClient(umgebung)

  // -------------------------------------------------------------------------
  // 1. SEE generieren (Software-Zertifikat)
  // -------------------------------------------------------------------------
  log('see-generierung', 'startet', 'Generiere Signaturzertifikat (ECDSA P-256)...')

  let see: SEEConfig
  try {
    see = await generateSEE({
      kassenId:        input.kassenId,
      uid:             input.uid,
      firmenname:      input.firmenname,
      ...(input.zertifikatGueltigkeitTage !== undefined && {
        gueltigkeitTage: input.zertifikatGueltigkeitTage,
      }),
    })
    log('see-generierung', 'erfolgreich', 'Zertifikat erstellt')
  } catch (err) {
    const meldung = err instanceof Error ? err.message : String(err)
    log('see-generierung', 'fehler', `Zertifikatsgenerierung fehlgeschlagen: ${meldung}`)
    return { erfolgreich: false, fonRegistriert: false, schritte, fehler: meldung }
  }

  // FinanzOnline ist optional: fehlen die Zugangsdaten, wird die Kasse
  // provisorisch (ohne FON-Registrierung) eingerichtet.
  const fo = input.finanzOnline
  const fonAktiv = !!(fo && fo.teilnehmerId?.trim() && fo.benutzerkennung?.trim() && fo.pin?.trim())

  // -------------------------------------------------------------------------
  // 2 + 3. FinanzOnline-Registrierung (SEE + Kasse) — nur wenn Zugangsdaten da
  // -------------------------------------------------------------------------
  if (fonAktiv) {
    log('finanzonline-registrierung', 'startet',
      `Registriere SEE und Kasse bei FinanzOnline (${umgebung})...`)

    let registrierungErfolg: boolean
    let registrierungFehler: string | undefined
    try {
      const ergebnis = await foClient.kasseInBetriebNehmen({
        kassenId:      input.kassenId,
        uid:           input.uid,
        zertifikatDER: see.zertifikatDER,
        credentials:   fo!,
      })
      registrierungErfolg = ergebnis.erfolgreich
      registrierungFehler = ergebnis.fehler
    } catch (err) {
      registrierungErfolg = false
      registrierungFehler = err instanceof Error ? err.message : String(err)
    }

    if (!registrierungErfolg) {
      const meldung = registrierungFehler ?? 'Unbekannter Fehler'
      log('finanzonline-registrierung', 'fehler', meldung)
      return { erfolgreich: false, fonRegistriert: false, see, schritte, fehler: meldung }
    }
    log('finanzonline-registrierung', 'erfolgreich',
      'SEE und Kasse erfolgreich bei FinanzOnline registriert')
  } else {
    log('finanzonline-registrierung', 'erfolgreich',
      'FinanzOnline übersprungen — provisorische Einrichtung, Registrierung ist nachzutragen')
  }

  // -------------------------------------------------------------------------
  // 4. Startbeleg erstellen (immer)
  // -------------------------------------------------------------------------
  log('startbeleg-erstellung', 'startet', 'Erstelle Startbeleg...')

  let startbeleg: SignedBeleg
  try {
    const result = erstelleStartbeleg(input.kassenId, see)
    startbeleg   = result.beleg
    log('startbeleg-erstellung', 'erfolgreich',
      `Startbeleg #${startbeleg.belegNummer} signiert`)
  } catch (err) {
    const meldung = err instanceof Error ? err.message : String(err)
    log('startbeleg-erstellung', 'fehler', `Startbeleg-Erstellung fehlgeschlagen: ${meldung}`)
    return { erfolgreich: false, fonRegistriert: false, see, schritte, fehler: meldung }
  }

  // -------------------------------------------------------------------------
  // 5. Startbeleg bei FinanzOnline prüfen lassen — nur wenn FON aktiv
  // -------------------------------------------------------------------------
  let pruefwert: string | undefined
  if (fonAktiv) {
    log('startbeleg-pruefung', 'startet', 'Lasse Startbeleg von FinanzOnline prüfen...')

    let pruefungErfolg: boolean
    let pruefungFehler: string | undefined
    try {
      const pruefung = await foClient.startbelegPruefen(startbeleg, fo!)
      pruefungErfolg = pruefung.erfolgreich
      pruefwert      = pruefung.pruefwert
      pruefungFehler = pruefung.fehler
    } catch (err) {
      pruefungErfolg = false
      pruefungFehler = err instanceof Error ? err.message : String(err)
    }

    if (!pruefungErfolg) {
      const meldung = pruefungFehler ?? 'Unbekannter Fehler'
      log('startbeleg-pruefung', 'fehler', meldung)
      return { erfolgreich: false, fonRegistriert: false, see, startbeleg, schritte, fehler: meldung }
    }
    log('startbeleg-pruefung', 'erfolgreich',
      pruefwert ? `Startbeleg geprüft (Prüfwert: ${pruefwert})` : 'Startbeleg geprüft')
  } else {
    log('startbeleg-pruefung', 'erfolgreich',
      'Startbeleg-Prüfung übersprungen — bei FON-Nachtrag nachzuholen')
  }

  // -------------------------------------------------------------------------
  // Erfolgreich abgeschlossen
  // -------------------------------------------------------------------------
  return {
    erfolgreich:         true,
    fonRegistriert:      fonAktiv,
    see,
    startbeleg,
    letzterSignaturwert: startbeleg.signaturwert,
    ...(pruefwert !== undefined && { pruefwert }),
    schritte,
  }
}
