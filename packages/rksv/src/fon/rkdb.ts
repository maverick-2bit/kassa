/**
 * FinanzOnline Registrierkassen-WebService (rkdb) — echte BMF-Schnittstelle.
 *
 *   Endpoint:   https://finanzonline.bmf.gv.at/fonws/ws/rkdb
 *   Namespace:  https://finanzonline.bmf.gv.at/rkdb   (regKasseWs.xsd + regKasse.xsd)
 *   Operation:  EINE Operation `rkdb` (SOAPAction "rkdb") transportiert ALLE Aktionen; der Aktionstyp steckt
 *               im Payload.
 *
 * Quellen: die amtlichen Schemas (tests/fixtures/fon-xsd, Prüfung in tests/fon-xsd.test.ts) und die BMF-Beschreibung
 * „Registrierkassen-Webservice" (Stand 12.05.2017). Beides, nicht ein früherer Stand dieser Datei, ist maßgeblich.
 *
 * Aufbau der Anfrage `rkdbRequest`:  tid, benid, id (Session-ID), art_uebermittlung ("T"|"P"), erzwinge_asynchron?,
 * dann GENAU EIN Aktions-Element:
 *   - `status_kasse` / `status_see` / `status_ggs` — Statusabfrage (paket_nr, ts_erstellung, satznr, Objekt)
 *   - `rkdb` — Paket (paket_nr, ts_erstellung) mit Datensätzen EINER Art (xs:choice): registrierung_se, registrierung_kasse,
 *     registrierung_ggs, ausfall_se, wiederinbetriebnahme_se, ausfall_kasse, wiederinbetriebnahme_kasse, ausfall_ggs,
 *     wiederinbetriebnahme_ggs oder belegpruefung. SE und Kasse brauchen daher getrennte Aufrufe.
 *
 * ALLE Elemente (Datensätze wie Felder) sind globale Elemente des Namespace und tragen ihn (hier das Präfix `rk:`).
 * Nur die drei Kinder von `abfrage_ergebnis` in der Antwort sind lokal und stehen OHNE Namespace.
 *
 * Mehrere Datensätze in einem Paket verarbeitet FinanzOnline asynchron (Ergebnis in die Databox); ein einzelner
 * Datensatz und jede Statusabfrage laufen synchron. Der Client schickt deshalb immer genau einen Datensatz.
 *
 * Antwort `rkdbResponse`: paket_nr, ts_erstellung, result+ — je Datensatz ein `result` mit satznr, einer oder mehreren
 * `rkdbMessage` (rc, msg) und bei Statusabfragen `abfrage_ergebnis` (ts_registrierung, status, ts_status).
 * `rc` ist ein TEXT (z. B. `0`, `-1`, `4`, `B14`, `V6`); `0` ist der einzige Erfolg.
 */

import type { ArtSe } from '../types.js'
import { xmlEscape, xmlUnescape, extractValue, extractAll, soapRequest } from './soap.js'
import { xsdDateTimeWien } from './datum.js'

export const RKDB_NS = 'https://finanzonline.bmf.gv.at/rkdb'

export type ArtUebermittlung = 'T' | 'P'

export interface RkdbSession {
  tid:   string
  benid: string
  /** Session-ID aus dem login */
  id:    string
  artUebermittlung: ArtUebermittlung
}

/**
 * Seriennummer eines Zertifikats: entweder in der Original-Kodierung (Dezimalzahl) oder hexadezimal mit dem
 * Attribut `hex="true"` und OHNE Präfix `0x` (BMF-Beschreibung, Feld `zertifikatsseriennummer`).
 */
export interface Seriennummer {
  wert: string
  hex?: boolean
}

// ---------------------------------------------------------------------------
// Begründungscodes (BMF-Beschreibung „Registrierkassen-Webservice", Stand 12.05.2017, Punkt 4)
// ---------------------------------------------------------------------------

/** Ausfall einer Signaturerstellungseinheit: 1 = Diebstahl/Verlust, 2 = Signatur unmöglich oder fehlerhaft, 99 = sonstiger Grund */
export type BegruendungAusfallSe = 1 | 2 | 99
/** Außerbetriebnahme (SE und Kasse): 6 = planmäßig, 7 = wegen eines irreparablen Ausfalls */
export type BegruendungAusserbetrieb = 6 | 7

/** Eine Signatureinheit der Kassa „fällt aus", wenn das Signieren nicht (mehr) gelingt — Code 2. */
export const BEGRUENDUNG_AUSFALL_SE_STANDARD: BegruendungAusfallSe = 2
/** Die Kassa nimmt Kassen planmäßig außer Betrieb (Schlussbeleg) — Code 6. */
export const BEGRUENDUNG_AUSSERBETRIEB_STANDARD: BegruendungAusserbetrieb = 6

// ---------------------------------------------------------------------------
// Antwort
// ---------------------------------------------------------------------------

/** Eine Meldung (`rkdbMessage`) zu einem Datensatz. */
export interface RkdbMeldung {
  rc:  string
  msg: string
}

/** Das Statusergebnis `abfrage_ergebnis` (nur bei Statusabfragen). */
export interface RkdbStatus {
  tsRegistrierung?: string
  /** AKTIVIERT | REGISTRIERT | IN_BETRIEB | AUSFALL */
  status?:          string
  tsStatus?:        string
}

/** Ein Ergebnisblock (`result`) — je Datensatz einer. */
export interface RkdbErgebnisSatz {
  satznr?:   string
  meldungen: RkdbMeldung[]
  status?:   RkdbStatus
}

export interface RkdbErgebnis {
  /**
   * true NUR, wenn es mindestens ein Ergebnis gibt, jedes Ergebnis mindestens eine Meldung hat und JEDE Meldung
   * aller Ergebnisse `rc` = `0` trägt. Eine unlesbare oder leere Antwort ist kein Erfolg.
   */
  erfolgreich: boolean
  /** Alle Ergebnisblöcke in der Reihenfolge der Antwort */
  ergebnisse:  RkdbErgebnisSatz[]
  /** rc und Text der ERSTEN fehlgeschlagenen Meldung — bei Erfolg die der ersten Meldung */
  rc?:         string
  msg?:        string
  /** Nur bei Statusabfragen: `abfrage_ergebnis/status` (AKTIVIERT | REGISTRIERT | IN_BETRIEB | AUSFALL) */
  abfrageErgebnis?: string
}

/**
 * Wertet die Antwort des rkdb-Dienstes aus. Alle Ergebnisblöcke und alle Meldungen zählen — ein abgelehnter zweiter
 * Datensatz oder eine zweite Meldung mit Fehler macht das Ganze zum Fehlschlag.
 * Die Auswertung kennt Präfixe beliebig (`rk:result`, `ns2:result`, `result`).
 */
export function parseRkdbAntwort(xml: string): RkdbErgebnis {
  const ergebnisse: RkdbErgebnisSatz[] = extractAll(xml, 'result').map((block) => {
    const satznr  = extractValue(block, 'satznr')
    const abfrage = extractValue(block, 'abfrage_ergebnis')
    const status: RkdbStatus = {}
    if (abfrage !== undefined) {
      const tsRegistrierung = extractValue(abfrage, 'ts_registrierung')
      const st              = extractValue(abfrage, 'status')
      const tsStatus        = extractValue(abfrage, 'ts_status')
      if (tsRegistrierung) status.tsRegistrierung = tsRegistrierung
      if (st)              status.status          = st
      if (tsStatus)        status.tsStatus        = tsStatus
    }
    return {
      ...(satznr && { satznr }),
      meldungen: extractAll(block, 'rkdbMessage').map((m) => ({
        rc:  extractValue(m, 'rc') ?? '',
        msg: xmlUnescape(extractValue(m, 'msg') ?? ''),
      })),
      ...(abfrage !== undefined && { status }),
    }
  })

  const alle = ergebnisse.flatMap((e) => e.meldungen)
  const erfolgreich =
    ergebnisse.length > 0 &&
    ergebnisse.every((e) => e.meldungen.length > 0) &&
    alle.every((m) => m.rc === '0')

  const massgeblich = alle.find((m) => m.rc !== '0') ?? alle[0]
  const abfrageErgebnis = ergebnisse.find((e) => e.status?.status)?.status?.status

  return {
    erfolgreich,
    ergebnisse,
    ...(massgeblich && { rc: massgeblich.rc, ...(massgeblich.msg && { msg: massgeblich.msg }) }),
    ...(abfrageErgebnis && { abfrageErgebnis }),
  }
}

/**
 * Text für eine Fehlermeldung: ALLE fehlgeschlagenen Meldungen, z. B. `(rc -42): Kasse bereits registriert` —
 * bei mehreren durch Semikolon getrennt. Eine Antwort ohne verwertbares Ergebnis wird als solche benannt.
 */
export function beschreibeRkdbFehler(e: RkdbErgebnis): string {
  if (e.ergebnisse.length === 0) return '(Antwort von FinanzOnline nicht auswertbar: kein Ergebnis)'
  const texte = e.ergebnisse.flatMap((s) =>
    s.meldungen.length === 0
      ? [`(keine Meldung zu Satz ${s.satznr ?? '?'})`]
      : s.meldungen.filter((m) => m.rc !== '0').map((m) => `(rc ${m.rc || '?'})${m.msg ? `: ${m.msg}` : ''}`))
  return texte.join('; ')
}

// ---------------------------------------------------------------------------
// Bausteine der Anfrage
// ---------------------------------------------------------------------------

const el   = (name: string, inhalt: string): string => `<rk:${name}>${inhalt}</rk:${name}>`
const text = (name: string, wert: string | number): string => el(name, xmlEscape(String(wert)))

function seriennummerElement(sn: Seriennummer): string {
  return `<rk:zertifikatsseriennummer${sn.hex ? ' hex="true"' : ''}>${xmlEscape(sn.wert)}</rk:zertifikatsseriennummer>`
}

/**
 * Paketnummer: laut BMF „eine beliebige bis zu 9-stellige Nummer, die vom Übermittler zur Identifizierung seiner
 * Sendung vergeben wird". Aus der Uhr (1 … 999 999 999), damit sich eine Sendung in FinanzOnline wiederfinden lässt.
 */
export function paketNr(jetzt: Date): number {
  const M = 999_999_999
  return ((jetzt.getTime() % M) + M) % M + 1
}

/** `paket_nr` + `ts_erstellung` (Zeitpunkt der Übermittlung) — der Kopf jedes Pakets und jeder Statusabfrage. */
function paketKopf(jetzt: Date): string {
  return text('paket_nr', paketNr(jetzt)) + text('ts_erstellung', xsdDateTimeWien(jetzt))
}

// ---------------------------------------------------------------------------
// Datensätze
// ---------------------------------------------------------------------------

/** registrierung_se — Signaturerstellungseinheit (Zertifikat eines Vertrauensdiensteanbieters) anmelden. */
export function datensatzRegistrierungSe(satznr: number, artSe: ArtSe, vdaId: string, seriennummer: Seriennummer): string {
  return el('registrierung_se',
    text('satznr', satznr) + text('art_se', artSe) + text('vda_id', vdaId) + seriennummerElement(seriennummer))
}

/** registrierung_kasse — Kasse anmelden (benutzerschluessel = Umsatzzähler-AES-Schlüssel, Base64, 44 Zeichen). */
export function datensatzRegistrierungKasse(satznr: number, kassenidentifikationsnummer: string, benutzerschluesselBase64: string): string {
  return el('registrierung_kasse',
    text('satznr', satznr) + text('kassenidentifikationsnummer', kassenidentifikationsnummer) + text('benutzerschluessel', benutzerschluesselBase64))
}

/** ausfall_se — Ausfall einer Signaturerstellungseinheit (der Beginn darf nicht in der Zukunft liegen). */
export function datensatzAusfallSe(satznr: number, seriennummer: Seriennummer, begruendung: BegruendungAusfallSe, beginn: Date): string {
  return el('ausfall_se',
    text('satznr', satznr) + seriennummerElement(seriennummer) +
    el('ausfall', text('begruendung', begruendung) + text('beginn_ausfall', xsdDateTimeWien(beginn))))
}

/** wiederinbetriebnahme_se — Signaturerstellungseinheit nach einem Ausfall wieder in Betrieb. */
export function datensatzWiederinbetriebnahmeSe(satznr: number, seriennummer: Seriennummer, ende: Date): string {
  return el('wiederinbetriebnahme_se',
    text('satznr', satznr) + seriennummerElement(seriennummer) + text('ende_ausfall', xsdDateTimeWien(ende)))
}

/**
 * Kasse außer Betrieb nehmen: kein eigener Datensatz, sondern `ausfall_kasse` mit dem Unterelement `ausserbetriebnahme`.
 * Einen Zeitpunkt gibt es dafür nicht — FinanzOnline nimmt den der Übermittlung.
 */
export function datensatzAusserbetriebnahmeKasse(satznr: number, kassenidentifikationsnummer: string, begruendung: BegruendungAusserbetrieb): string {
  return el('ausfall_kasse',
    text('satznr', satznr) + text('kassenidentifikationsnummer', kassenidentifikationsnummer) +
    el('ausserbetriebnahme', text('begruendung', begruendung)))
}

// ---------------------------------------------------------------------------
// Aktionen (das eine Element der Anfrage nach art_uebermittlung)
// ---------------------------------------------------------------------------

/** `rkdb`-Paket mit genau EINEM Datensatz. */
export function aktionPaket(datensatz: string, jetzt: Date = new Date()): string {
  return el('rkdb', paketKopf(jetzt) + datensatz)
}

/** Statusabfrage einer Kasse (Antwort: REGISTRIERT | IN_BETRIEB | AUSFALL …). */
export function aktionStatusKasse(kassenidentifikationsnummer: string, jetzt: Date = new Date()): string {
  return el('status_kasse', paketKopf(jetzt) + text('satznr', 1) + text('kassenidentifikationsnummer', kassenidentifikationsnummer))
}

/** Statusabfrage einer Signaturerstellungseinheit (Element heißt `status_see`, nicht `status_se`). */
export function aktionStatusSee(seriennummer: Seriennummer, jetzt: Date = new Date()): string {
  return el('status_see', paketKopf(jetzt) + text('satznr', 1) + seriennummerElement(seriennummer))
}

/** Body der Anfrage: Kopf mit Session + Aktion. */
export function baueRkdbBody(session: RkdbSession, aktion: string): string {
  return `<rk:rkdbRequest xmlns:rk="${RKDB_NS}">` +
    text('tid', session.tid) +
    text('benid', session.benid) +
    text('id', session.id) +
    text('art_uebermittlung', session.artUebermittlung) +
    aktion +
    `</rk:rkdbRequest>`
}

// ---------------------------------------------------------------------------
// rkdb-Aufrufe
// ---------------------------------------------------------------------------

async function sende(rkdbUrl: string, session: RkdbSession, aktion: string): Promise<RkdbErgebnis> {
  const xml = await soapRequest(rkdbUrl, 'rkdb', baueRkdbBody(session, aktion))
  return parseRkdbAntwort(xml)
}

/** Registriert die Signaturerstellungseinheit (registrierung_se) — ein eigener Aufruf, nicht zusammen mit der Kasse. */
export function rkdbRegistriereSe(
  rkdbUrl: string,
  session: RkdbSession,
  se: { artSe: ArtSe; vdaId: string; seriennummer: Seriennummer },
  jetzt: Date = new Date(),
): Promise<RkdbErgebnis> {
  return sende(rkdbUrl, session, aktionPaket(datensatzRegistrierungSe(1, se.artSe, se.vdaId, se.seriennummer), jetzt))
}

/** Registriert die Kasse (registrierung_kasse) — ein eigener Aufruf. */
export function rkdbRegistriereKasse(
  rkdbUrl: string,
  session: RkdbSession,
  kasse: { kassenidentifikationsnummer: string; benutzerschluesselBase64: string },
  jetzt: Date = new Date(),
): Promise<RkdbErgebnis> {
  return sende(rkdbUrl, session, aktionPaket(datensatzRegistrierungKasse(1, kasse.kassenidentifikationsnummer, kasse.benutzerschluesselBase64), jetzt))
}

/** Status einer Kasse abfragen (abfrageErgebnis: REGISTRIERT | IN_BETRIEB | AUSFALL | …). */
export function rkdbStatusKasse(
  rkdbUrl: string,
  session: RkdbSession,
  kassenidentifikationsnummer: string,
  jetzt: Date = new Date(),
): Promise<RkdbErgebnis> {
  return sende(rkdbUrl, session, aktionStatusKasse(kassenidentifikationsnummer, jetzt))
}

/** Status einer Signaturerstellungseinheit abfragen (abfrageErgebnis: AKTIVIERT | AUSFALL | …). */
export function rkdbStatusSe(
  rkdbUrl: string,
  session: RkdbSession,
  seriennummer: Seriennummer,
  jetzt: Date = new Date(),
): Promise<RkdbErgebnis> {
  return sende(rkdbUrl, session, aktionStatusSee(seriennummer, jetzt))
}

/** Meldet den Ausfall einer Signaturerstellungseinheit. */
export function rkdbAusfallSe(
  rkdbUrl: string,
  session: RkdbSession,
  se: { seriennummer: Seriennummer; begruendung: BegruendungAusfallSe; beginn: Date },
  jetzt: Date = new Date(),
): Promise<RkdbErgebnis> {
  return sende(rkdbUrl, session, aktionPaket(datensatzAusfallSe(1, se.seriennummer, se.begruendung, se.beginn), jetzt))
}

/** Meldet die Wiederinbetriebnahme einer Signaturerstellungseinheit nach einem Ausfall. */
export function rkdbWiederinbetriebnahmeSe(
  rkdbUrl: string,
  session: RkdbSession,
  se: { seriennummer: Seriennummer; ende: Date },
  jetzt: Date = new Date(),
): Promise<RkdbErgebnis> {
  return sende(rkdbUrl, session, aktionPaket(datensatzWiederinbetriebnahmeSe(1, se.seriennummer, se.ende), jetzt))
}

/** Meldet die Außerbetriebnahme einer Kasse. */
export function rkdbAusserbetriebnahmeKasse(
  rkdbUrl: string,
  session: RkdbSession,
  kasse: { kassenidentifikationsnummer: string; begruendung: BegruendungAusserbetrieb },
  jetzt: Date = new Date(),
): Promise<RkdbErgebnis> {
  return sende(rkdbUrl, session, aktionPaket(datensatzAusserbetriebnahmeKasse(1, kasse.kassenidentifikationsnummer, kasse.begruendung), jetzt))
}
