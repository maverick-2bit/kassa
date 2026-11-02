/**
 * Von Hand nach den amtlichen Schemas (fixtures/fon-xsd) geschriebene Soll-Beispiele für den
 * FinanzOnline-Registrierkassen-Webservice — so MÜSSTEN Requests und Antworten aussehen.
 *
 * Jedes Beispiel wird in `fon-xsd.test.ts` gegen das Schema geprüft (sonst wäre „Soll" nur eine Behauptung).
 * Wer den FinanzOnline-Client auf die Schemas bringt, kann daran ablesen, wie die Nachrichten
 * aufgebaut sind; die Antworten taugen als Mock-Antworten, die der echte Dienst so liefern darf.
 *
 * Inhaltliche Vorbehalte (aus dem Schema nicht ableitbar, erst mit Testzugang klärbar): Bedeutung der
 * Begründungs-Codes (`begruendung`, 1–99) und die Hersteller-ID (nur das Muster `[0-9A-Za-z]{10,24}` ist bekannt).
 */

import type { FonSchema } from '../helpers/xsd.js'

export const NS_SESSION = 'https://finanzonline.bmf.gv.at/fon/ws/session'
export const NS_RKDB    = 'https://finanzonline.bmf.gv.at/rkdb'

export interface FonBeispiel {
  schema: FonSchema
  xml:    string
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

export const BSP_TID          = '123456789'
export const BSP_BENID        = 'WEBSERV1'
export const BSP_SESSION_ID   = 'ABCDEF1234567890'
export const BSP_HERSTELLER   = 'ATU12345678'
export const BSP_KASSE        = 'KASSE-1'
export const BSP_SEE_SN       = '1793602611047'
/** 32 Byte AES-Schlüssel als Base64 = 44 Zeichen (Schema: `benutzerschluessel` length 44) */
export const BSP_AES_B64      = 'PPrlztI80Y9fMmCCUtsiWoKgGKcNVAqFbKj0KZoJrHE='

const paket = '<rk:paket_nr>1</rk:paket_nr><rk:ts_erstellung>2026-11-02T08:00:00</rk:ts_erstellung>'

const rkdbAnfrage = (aktion: string): string =>
  `<rk:rkdbRequest xmlns:rk="${NS_RKDB}">` +
  `<rk:tid>${BSP_TID}</rk:tid><rk:benid>${BSP_BENID}</rk:benid><rk:id>${BSP_SESSION_ID}</rk:id>` +
  `<rk:art_uebermittlung>T</rk:art_uebermittlung>${aktion}</rk:rkdbRequest>`

/** Maschinenlesbarer Code eines Belegs für `belegpruefung` (13 Gruppen, QR-Form) — aus den BMF-Beispieldaten (offenes System). */
export const BSP_BELEG_CODE =
  '_R1-AT100_CASHBOX-DEMO-1_CASHBOX-DEMO-1-Receipt-ID-1_2016-03-11T03:57:08_0,00_0,00_0,00_0,00_0,00_4r1iIdZG_82424e8077297aa3_cg8hNU5ihto=' +
  '_rKThZdYRoO4cyowsAK3KQjmgXg9cA3XmGVnR53EtYloroivDePObBTlGy6XhAOx2d4ZROEMcGI5crmBGLo0mBA=='

// ---------------------------------------------------------------------------
// Soll-Requests
// ---------------------------------------------------------------------------

export const SOLL_ANFRAGEN: Record<string, FonBeispiel> = {
  'login': {
    schema: 'session',
    xml: `<ses:loginRequest xmlns:ses="${NS_SESSION}"><ses:tid>${BSP_TID}</ses:tid><ses:benid>${BSP_BENID}</ses:benid>` +
         `<ses:pin>geheim123</ses:pin><ses:herstellerid>${BSP_HERSTELLER}</ses:herstellerid></ses:loginRequest>`,
  },
  'logout': {
    schema: 'session',
    xml: `<ses:logoutRequest xmlns:ses="${NS_SESSION}"><ses:tid>${BSP_TID}</ses:tid><ses:benid>${BSP_BENID}</ses:benid>` +
         `<ses:id>${BSP_SESSION_ID}</ses:id></ses:logoutRequest>`,
  },
  'status-kasse': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:status_kasse>${paket}<rk:satznr>1</rk:satznr>` +
         `<rk:kassenidentifikationsnummer>${BSP_KASSE}</rk:kassenidentifikationsnummer></rk:status_kasse>`),
  },
  'status-see': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:status_see>${paket}<rk:satznr>1</rk:satznr>` +
         `<rk:zertifikatsseriennummer>${BSP_SEE_SN}</rk:zertifikatsseriennummer></rk:status_see>`),
  },
  'registrierung-se': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:registrierung_se><rk:satznr>1</rk:satznr><rk:art_se>HSM_DIENSTLEISTER</rk:art_se>` +
         `<rk:vda_id>AT1</rk:vda_id><rk:zertifikatsseriennummer>${BSP_SEE_SN}</rk:zertifikatsseriennummer></rk:registrierung_se></rk:rkdb>`),
  },
  'registrierung-kasse': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:registrierung_kasse><rk:satznr>1</rk:satznr>` +
         `<rk:kassenidentifikationsnummer>${BSP_KASSE}</rk:kassenidentifikationsnummer>` +
         `<rk:benutzerschluessel>${BSP_AES_B64}</rk:benutzerschluessel></rk:registrierung_kasse></rk:rkdb>`),
  },
  /** Software-SEE (AT0, „geschlossenes Gesamtsystem"): wird als GGS gemeldet, nicht als SE + Kasse. */
  'registrierung-ggs': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:registrierung_ggs><rk:satznr>1</rk:satznr><rk:art_ob>UID</rk:art_ob>` +
         `<rk:ob>ATU12345678</rk:ob><rk:art_se_ggs>SW_GGS</rk:art_se_ggs>` +
         `<rk:public_key>-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjSZpXaQBGpFGVe4M8zSmds8v2TmMFBhO56xvxOsAUKeZ9MbBWchv4Dom0POP\n-----END PUBLIC KEY-----</rk:public_key>` +
         `</rk:registrierung_ggs></rk:rkdb>`),
  },
  'ausfall-se': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:ausfall_se><rk:satznr>1</rk:satznr>` +
         `<rk:zertifikatsseriennummer>${BSP_SEE_SN}</rk:zertifikatsseriennummer>` +
         `<rk:ausfall><rk:begruendung>1</rk:begruendung><rk:beginn_ausfall>2026-11-02T07:30:00</rk:beginn_ausfall></rk:ausfall>` +
         `</rk:ausfall_se></rk:rkdb>`),
  },
  'wiederinbetriebnahme-se': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:wiederinbetriebnahme_se><rk:satznr>1</rk:satznr>` +
         `<rk:zertifikatsseriennummer>${BSP_SEE_SN}</rk:zertifikatsseriennummer>` +
         `<rk:ende_ausfall>2026-11-02T09:00:00</rk:ende_ausfall></rk:wiederinbetriebnahme_se></rk:rkdb>`),
  },
  /** Kasse außer Betrieb nehmen = `ausfall_kasse` mit Unterelement `ausserbetriebnahme` (kein eigener Datensatz). */
  'ausserbetriebnahme-kasse': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:ausfall_kasse><rk:satznr>1</rk:satznr>` +
         `<rk:kassenidentifikationsnummer>${BSP_KASSE}</rk:kassenidentifikationsnummer>` +
         `<rk:ausserbetriebnahme><rk:begruendung>1</rk:begruendung></rk:ausserbetriebnahme></rk:ausfall_kasse></rk:rkdb>`),
  },
  'wiederinbetriebnahme-kasse': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:wiederinbetriebnahme_kasse><rk:satznr>1</rk:satznr>` +
         `<rk:kassenidentifikationsnummer>${BSP_KASSE}</rk:kassenidentifikationsnummer>` +
         `<rk:ende_ausfall>2026-11-02T09:00:00</rk:ende_ausfall></rk:wiederinbetriebnahme_kasse></rk:rkdb>`),
  },
  /** Amtliche Belegprüfung (Start-/Jahresbeleg) über den Webservice — der Client nutzt sie bisher nicht. */
  'belegpruefung': {
    schema: 'rkdb',
    xml: rkdbAnfrage(`<rk:rkdb>${paket}<rk:belegpruefung><rk:satznr>1</rk:satznr><rk:beleg>${BSP_BELEG_CODE}</rk:beleg></rk:belegpruefung></rk:rkdb>`),
  },
}

// ---------------------------------------------------------------------------
// Antworten, die der Dienst laut Schema liefern darf
// ---------------------------------------------------------------------------

const rkdbAntwort = (ergebnisse: string): string =>
  `<rk:rkdbResponse xmlns:rk="${NS_RKDB}"><rk:paket_nr>1</rk:paket_nr>` +
  `<rk:ts_erstellung>2026-11-02T08:00:01</rk:ts_erstellung>${ergebnisse}</rk:rkdbResponse>`

const ergebnis = (satznr: number, rc: string, msg: string, extra = ''): string =>
  `<rk:result><rk:satznr>${satznr}</rk:satznr><rk:rkdbMessage><rk:rc>${rc}</rk:rc><rk:msg>${msg}</rk:msg></rk:rkdbMessage>${extra}</rk:result>`

/** Die Kinder von `abfrage_ergebnis` sind im Schema lokale Elemente — ohne Namespace (kein `elementFormDefault`). */
export const abfrageErgebnis = (status: 'AKTIVIERT' | 'REGISTRIERT' | 'IN_BETRIEB' | 'AUSFALL'): string =>
  `<rk:abfrage_ergebnis><ts_registrierung>2026-11-01T10:00:00</ts_registrierung><status>${status}</status>` +
  `<ts_status>2026-11-01T10:00:00</ts_status></rk:abfrage_ergebnis>`

export const ANTWORTEN: Record<string, FonBeispiel> = {
  'login-ok': {
    schema: 'session',
    xml: `<ses:loginResponse xmlns:ses="${NS_SESSION}"><ses:id>${BSP_SESSION_ID}</ses:id><ses:rc>0</ses:rc><ses:msg>ok</ses:msg></ses:loginResponse>`,
  },
  'login-fehler': {
    schema: 'session',
    xml: `<ses:loginResponse xmlns:ses="${NS_SESSION}"><ses:id></ses:id><ses:rc>-4</ses:rc><ses:msg>Zugangsdaten falsch</ses:msg></ses:loginResponse>`,
  },
  'logout-ok': {
    schema: 'session',
    xml: `<ses:logoutResponse xmlns:ses="${NS_SESSION}"><ses:rc>0</ses:rc></ses:logoutResponse>`,
  },
  'rkdb-ok': {
    schema: 'rkdb',
    xml: rkdbAntwort(ergebnis(1, '0', 'ok')),
  },
  /** Zwei Datensätze, der zweite abgelehnt — der Gesamt-rc steht NICHT vorn, jeder Datensatz hat sein eigenes Ergebnis. */
  'rkdb-zweiter-datensatz-abgelehnt': {
    schema: 'rkdb',
    xml: rkdbAntwort(ergebnis(1, '0', 'ok') + ergebnis(2, '-42', 'Kasse bereits registriert')),
  },
  /** Ein Datensatz mit mehreren Meldungen (eine Warnung, dann der Fehler). */
  'rkdb-mehrere-meldungen': {
    schema: 'rkdb',
    xml: rkdbAntwort(
      `<rk:result><rk:satznr>1</rk:satznr>` +
      `<rk:rkdbMessage><rk:rc>0</rk:rc><rk:msg>Hinweis</rk:msg></rk:rkdbMessage>` +
      `<rk:rkdbMessage><rk:rc>-7</rk:rc><rk:msg>Zertifikat unbekannt</rk:msg></rk:rkdbMessage></rk:result>`),
  },
  'status-kasse-registriert': {
    schema: 'rkdb',
    xml: rkdbAntwort(ergebnis(1, '0', 'ok', abfrageErgebnis('REGISTRIERT'))),
  },
  'status-see-aktiviert': {
    schema: 'rkdb',
    xml: rkdbAntwort(ergebnis(1, '0', 'ok', abfrageErgebnis('AKTIVIERT'))),
  },
}
