/**
 * RKSV – Registrierkassensicherheitsverordnung
 * Typen gemäß BMF Detailspezifikation v1.5
 * https://www.bmf.gv.at/themen/steuern/selbststaendige-unternehmer/registrierkassenpflicht.html
 */

// ---------------------------------------------------------------------------
// Steuersätze
// ---------------------------------------------------------------------------

export type MwStSatz = 'normal' | 'ermaessigt1' | 'ermaessigt2' | 'null' | 'besonders'

/** Prozentwerte der österreichischen MwSt-Sätze */
export const MWST_PROZENT: Record<MwStSatz, number> = {
  normal:      20,
  ermaessigt1: 10,
  ermaessigt2: 13,
  null:         0,
  besonders:   19,
} as const

// ---------------------------------------------------------------------------
// Belegtypen
// ---------------------------------------------------------------------------

export type BelegTyp =
  | 'Barzahlungsbeleg'
  | 'Startbeleg'
  | 'Schlussbeleg'
  | 'Monatsbeleg'
  | 'Jahresbeleg'
  | 'Nullbeleg'
  | 'Stornobeleg'
  | 'Trainingsbeleg'

/**
 * Ob ein Belegtyp den Umsatzzähler verändert.
 * Nur Barzahlungs- und Stornobelege ändern den Zähler.
 */
export const BELEG_AENDERT_ZAEHLER: Record<BelegTyp, boolean> = {
  Barzahlungsbeleg: true,
  Stornobeleg:      true,
  Startbeleg:       false,
  Schlussbeleg:     false,
  Monatsbeleg:      false,
  Jahresbeleg:      false,
  Nullbeleg:        false,
  Trainingsbeleg:   false,
} as const

// ---------------------------------------------------------------------------
// Beleg-Positionen & Beträge
// ---------------------------------------------------------------------------

export interface BelegPosition {
  bezeichnung: string
  menge: number
  /** Bruttopreis in Cent (inklusive MwSt) */
  einzelpreisBreutto: number
  mwstSatz: MwStSatz
  /** Zugewiesene Seriennummern (für den Aufdruck auf der Rechnung/dem Bon) */
  seriennummern?: string[]
}

/** Summen pro Steuersatz in Cent (brutto) */
export interface BetraegeSummen {
  /** 20 % */
  normal:      number
  /** 10 % */
  ermaessigt1: number
  /** 13 % */
  ermaessigt2: number
  /** 0 % */
  null:        number
  /** Sondersteuersatz */
  besonders:   number
}

// ---------------------------------------------------------------------------
// Beleg
// ---------------------------------------------------------------------------

/** Rohdaten eines Belegs vor der RKSV-Signierung */
export interface RawBeleg {
  kassenId:    string
  /** Lückenlose aufsteigende Nummer, beginnt bei 1 */
  belegNummer: number
  datumUhrzeit: Date
  belegTyp:    BelegTyp
  positionen:  BelegPosition[]
}

/** Vollständig signierter RKSV-Beleg */
export interface SignedBeleg extends RawBeleg {
  betraege: BetraegeSummen
  /** BASE64-Standard-kodierte AES-256-ICM-Verschlüsselung des Umsatzzählers (8 Byte) */
  umsatzzaehlerVerschluesselt: string
  /** Hexadezimale Seriennummer des SEE-Zertifikats (wie im QR-Code) */
  zertifikatSN: string
  /**
   * Verkettungswert Vorbeleg: BASE64_STD( erste 8 Byte von SHA-256(Input) ).
   * Startbeleg: Input = Kassen-ID; Folgebeleg: Input = kompletter
   * maschinenlesbarer Code des Vorbelegs (Detailspezifikation).
   */
  sigVorbeleg: string
  /**
   * ECDSA-P256-Signatur (64 Byte P1363) über den JWS-Signing-Input
   * base64url(header{"alg":"ES256"}) + "." + base64url(codeOhneSig),
   * BASE64-Standard-kodiert wie im QR-Code.
   */
  signaturwert: string
  /** Vollständiger QR-Code-Inhalt gemäß BMF-Spezifikation */
  maschinenlesbareCode: string
  /** JWS-Compact-Repräsentation (header.payload.signature, base64url) — für den DEP-Export */
  jwsCompact: string
  /**
   * true, wenn der Beleg im SEE-Ausfallmodus erzeugt wurde: statt einer
   * ECDSA-Signatur trägt `signaturwert` den BMF-Marker für „Sicherheits-
   * einrichtung ausgefallen". Der Beleg ist regulär verkettet, aber nicht
   * kryptographisch signiert.
   */
  ausgefallen?: boolean
}

// ---------------------------------------------------------------------------
// SEE – Signaturerstellungseinheit
// ---------------------------------------------------------------------------

export interface SEEConfig {
  kassenId: string
  /** DER-kodiertes X.509-Zertifikat */
  zertifikatDER: Buffer
  /** PKCS#8 DER-kodierter privater Schlüssel (ECDSA P-256) */
  privateKeyDER: Buffer
  /**
   * Eigenständiger AES-256-Schlüssel (32 Byte) für die Umsatzzähler-
   * Verschlüsselung — wird bei der FON-Kassenregistrierung als base64 gemeldet
   * (Detailspezifikation; NICHT aus dem Zertifikat abgeleitet).
   */
  aesSchluessel: Buffer
  /**
   * ZDA-Kennzeichen im QR-Prefix `_R1-<ZDA>_`: 'AT1' (A-Trust), 'AT2' (GlobalTrust),
   * 'AT3' (PrimeSign); 'AT0' = geschlossenes Gesamtsystem — Kennzeichen der
   * Software-SEE (nur Entwicklung/Test).
   */
  zdaId: string
}

export interface SEEInfo {
  kassenId:    string
  zertifikatSN: string
  gueltigAb:   Date
  gueltigBis:  Date
  algorithmus: 'ES256'
}

// ---------------------------------------------------------------------------
// DEP7 – Datenerfassungsprotokoll
// ---------------------------------------------------------------------------

/**
 * DEP7-Exportformat gemäß BMF-Detailspezifikation Abs. 3:
 * `{"Belege-Gruppe":[{ "Signaturzertifikat", "Zertifizierungsstellen", "Belege-kompakt": [JWS…] }]}`
 */
export interface DEP7Export {
  'Belege-Gruppe': DEP7BelegPackage[]
}

export interface DEP7BelegPackage {
  /** base64-Standard-kodiertes DER-Zertifikat der SEE */
  Signaturzertifikat: string
  /** base64-Standard-kodierte DER-Zwischenzertifikate (leer bei Self-signed) */
  Zertifizierungsstellen: string[]
  /** Belege als JWS-Compact-Repräsentation (header.payload.signature, base64url) */
  'Belege-kompakt': string[]
}

// ---------------------------------------------------------------------------
// DEP131 – Erweitertes Datenerfassungsprotokoll (§131 BAO)
// ---------------------------------------------------------------------------

/** Einzelne Position für den DEP131-Export (menschenlesbar) */
export interface DEP131Position {
  Bezeichnung:             string
  Menge:                   number
  EinzelpreisBreuttoCent:  number
  MwStSatz:                MwStSatz
}

/** Vollständiger Beleg für den DEP131-Export */
export interface DEP131Beleg {
  Belegtyp:                    BelegTyp
  Belegnummer:                 number
  DatumUhrzeit:                string
  Positionen:                  DEP131Position[]
  Betraege: {
    NormalCent:      number
    Ermaessigt1Cent: number
    Ermaessigt2Cent: number
    NullCent:        number
    BesondersCent:   number
  }
  Zahlung: {
    BarCent:      number
    KarteCent:    number
    SonstigeCent: number
  }
  MaschinenlesbareCode:        string
  Signaturwert:                string
  UmsatzzaehlerVerschluesselt: string
  ZertifikatSN:                string
  SigVorbeleg:                 string
}

/** DEP131-Export-Datei (strukturiert, menschenlesbar + maschinell verarbeitbar) */
export interface DEP131Export {
  exportDatum: string
  kassenId:    string
  Belege:      DEP131Beleg[]
}

/** Eingabe-Daten pro Beleg für die DEP131-Assemblierung */
export interface DEP131BelegInput {
  belegNummer:                 number
  datumUhrzeit:                Date
  belegTyp:                    BelegTyp
  positionen:                  BelegPosition[]
  betraege:                    BetraegeSummen
  zahlung: {
    barCent:      number
    karteCent:    number
    sonstigeCent: number
  }
  maschinenlesbareCode:        string
  signaturwert:                string
  umsatzzaehlerVerschluesselt: string
  zertifikatSN:                string
  sigVorbeleg:                 string
}

// ---------------------------------------------------------------------------
// FinanzOnline
// ---------------------------------------------------------------------------

export interface FinanzOnlineCredentials {
  /** Teilnehmer-Identifikation (TID) */
  teilnehmerId: string
  /** Benutzer-Identifikation (BENID) */
  benutzerkennung: string
  pin: string
  /**
   * Software-Hersteller-ID (10–24 Zeichen), bei BMF registriert. Optional —
   * fehlt sie, wird die konfigurierte Default-Hersteller-ID verwendet.
   */
  herstellerId?: string
}

/** Art der Signaturerstellungseinheit im FON-rkdb-Datensatz `registrierung_se`. */
export type ArtSe = 'SIGNATURKARTE' | 'EIGENES_HSM' | 'HSM_DIENSTLEISTER'

export interface KassenRegistrierung {
  kassenId:        string
  uid:             string
  zertifikatDER:   Buffer
  credentials:     FinanzOnlineCredentials
  /** Umsatzzähler-AES-Schlüssel base64 (FON-Feld `benutzerschluessel`) */
  benutzerschluesselBase64: string
  /** ZDA-/VDA-Kennung (FON-Feld `vda_id`), z. B. 'AT1' (A-Trust), 'AT0' (Software) */
  vdaId:           string
  /** Art der SEE (FON-Feld `art_se`) */
  artSe:           ArtSe
}

export interface RegistrierungErgebnis {
  erfolgreich: boolean
  pruefwert?:  string
  fehler?:     string
}

// ---------------------------------------------------------------------------
// Betreiberwechsel
// ---------------------------------------------------------------------------

export interface BetreiberwechselExport {
  kassenId:             string
  exportDatum:          string
  schlussbeleg:         SignedBeleg
  depExport:            DEP7Export
  letzterBelegNummer:   number
  letzterSignaturwert:  string
}

export interface BetreiberwechselImport {
  export:              BetreiberwechselExport
  neueUid:             string
  neueKassenId?:       string
  neueSEEConfig:       SEEConfig
  foCredentials:       FinanzOnlineCredentials
}
