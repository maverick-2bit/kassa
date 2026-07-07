/**
 * FinanzOnline Registrierkassen-WebService (rkdb) — echte BMF-Schnittstelle.
 *
 *   Endpoint:   https://finanzonline.bmf.gv.at/fonws/ws/rkdb
 *   Namespace:  https://finanzonline.bmf.gv.at/rkdb
 *   Operation:  EINE Operation `rkdb` (SOAPAction "rkdb") transportiert ALLE
 *               Aktionen; der Aktionstyp steckt im Payload.
 *
 * rkdbRequest: tid, benid, id (Session-ID), art_uebermittlung ("T"|"P"),
 *              erzwinge_asynchron?, dann genau ein Aktions-Element
 *              (`rkdb` mit Registrierungs-Datensätzen | `status_kasse` | `status_se`).
 * rkdbResponse: result[] → { satznr, rkdbMessage[] (rc, msg), abfrage_ergebnis? }
 *
 * Datensätze (regKasse.xsd):
 *   registrierung_se:    satznr, art_se, vda_id, (zertifikatsseriennummer | zertifikat)
 *   registrierung_kasse: satznr, kassenidentifikationsnummer, benutzerschluessel
 */

import type { ArtSe } from '../types.js'
import { xmlEscape, extractValue, soapRequest } from './soap.js'

const RKDB_NS = 'https://finanzonline.bmf.gv.at/rkdb'

export type ArtUebermittlung = 'T' | 'P'

export interface RkdbSession {
  tid:   string
  benid: string
  /** Session-ID aus dem login */
  id:    string
  artUebermittlung: ArtUebermittlung
}

export interface RkdbErgebnis {
  erfolgreich:     boolean
  rc?:             string
  msg?:            string
  /** Nur bei Status-Abfragen: AKTIVIERT | REGISTRIERT | IN_BETRIEB | AUSFALL | … */
  abfrageErgebnis?: string
}

// ---------------------------------------------------------------------------
// Datensatz-Builder
// ---------------------------------------------------------------------------

/** registrierung_se — SEE (Signaturzertifikat) anmelden. */
export function datensatzRegistrierungSe(satznr: number, artSe: ArtSe, vdaId: string, zertifikatsseriennummer: string): string {
  return `<registrierung_se>` +
    `<satznr>${satznr}</satznr>` +
    `<art_se>${xmlEscape(artSe)}</art_se>` +
    `<vda_id>${xmlEscape(vdaId)}</vda_id>` +
    `<zertifikatsseriennummer>${xmlEscape(zertifikatsseriennummer)}</zertifikatsseriennummer>` +
    `</registrierung_se>`
}

/** registrierung_kasse — Kasse anmelden (benutzerschluessel = Umsatzzähler-AES-Schlüssel base64). */
export function datensatzRegistrierungKasse(satznr: number, kassenidentifikationsnummer: string, benutzerschluesselBase64: string): string {
  return `<registrierung_kasse>` +
    `<satznr>${satznr}</satznr>` +
    `<kassenidentifikationsnummer>${xmlEscape(kassenidentifikationsnummer)}</kassenidentifikationsnummer>` +
    `<benutzerschluessel>${xmlEscape(benutzerschluesselBase64)}</benutzerschluessel>` +
    `</registrierung_kasse>`
}

// ---------------------------------------------------------------------------
// rkdb-Aufrufe
// ---------------------------------------------------------------------------

/** Baut den rkdbRequest-Envelope-Body mit einem Aktions-Element. */
export function baueRkdbBody(session: RkdbSession, aktion: string): string {
  return `<rk:rkdbRequest xmlns:rk="${RKDB_NS}">` +
    `<rk:tid>${xmlEscape(session.tid)}</rk:tid>` +
    `<rk:benid>${xmlEscape(session.benid)}</rk:benid>` +
    `<rk:id>${xmlEscape(session.id)}</rk:id>` +
    `<rk:art_uebermittlung>${session.artUebermittlung}</rk:art_uebermittlung>` +
    aktion +
    `</rk:rkdbRequest>`
}

function ergebnisAusXml(xml: string): RkdbErgebnis {
  const rc  = extractValue(xml, 'rc')
  const msg = extractValue(xml, 'msg')
  const abfrage = extractValue(xml, 'abfrage_ergebnis')
  return {
    erfolgreich: rc === '0',
    ...(rc  && { rc }),
    ...(msg && { msg }),
    ...(abfrage && { abfrageErgebnis: abfrage }),
  }
}

/** Registriert SEE + Kasse in einem rkdb-Aufruf. */
export async function rkdbRegistriere(
  rkdbUrl: string,
  session: RkdbSession,
  se: { artSe: ArtSe; vdaId: string; zertifikatsseriennummer: string },
  kasse: { kassenidentifikationsnummer: string; benutzerschluesselBase64: string },
): Promise<RkdbErgebnis> {
  const aktion = `<rk:rkdb>` +
    datensatzRegistrierungSe(1, se.artSe, se.vdaId, se.zertifikatsseriennummer) +
    datensatzRegistrierungKasse(2, kasse.kassenidentifikationsnummer, kasse.benutzerschluesselBase64) +
    `</rk:rkdb>`
  const xml = await soapRequest(rkdbUrl, 'rkdb', baueRkdbBody(session, aktion))
  return ergebnisAusXml(xml)
}

/** Status einer Kasse abfragen (abfrage_ergebnis: REGISTRIERT | IN_BETRIEB | …). */
export async function rkdbStatusKasse(
  rkdbUrl: string,
  session: RkdbSession,
  kassenidentifikationsnummer: string,
): Promise<RkdbErgebnis> {
  const aktion = `<rk:status_kasse>` +
    `<kassenidentifikationsnummer>${xmlEscape(kassenidentifikationsnummer)}</kassenidentifikationsnummer>` +
    `</rk:status_kasse>`
  const xml = await soapRequest(rkdbUrl, 'rkdb', baueRkdbBody(session, aktion))
  return ergebnisAusXml(xml)
}

/** Status einer SEE abfragen (abfrage_ergebnis: AKTIVIERT | AUSFALL | …). */
export async function rkdbStatusSe(
  rkdbUrl: string,
  session: RkdbSession,
  zertifikatsseriennummer: string,
): Promise<RkdbErgebnis> {
  const aktion = `<rk:status_se>` +
    `<zertifikatsseriennummer>${xmlEscape(zertifikatsseriennummer)}</zertifikatsseriennummer>` +
    `</rk:status_se>`
  const xml = await soapRequest(rkdbUrl, 'rkdb', baueRkdbBody(session, aktion))
  return ergebnisAusXml(xml)
}

/**
 * Meldet Kassen-Außerbetriebnahme bzw. SEE-Ausfall/Wiederinbetriebnahme.
 * Übermittelt einen Datensatz mit Beginn-/Ende-Zeitstempel im rkdb-Container.
 * ⚠️ Feldnamen dieser Datensätze sind gegen die vollständige regKasse.xsd +
 * einen FON-Testbenutzer final zu verifizieren (Registrierung + Status sind bestätigt).
 */
export async function rkdbAktion(
  rkdbUrl: string,
  session: RkdbSession,
  datensatzXml: string,
): Promise<RkdbErgebnis> {
  const xml = await soapRequest(rkdbUrl, 'rkdb', baueRkdbBody(session, `<rk:rkdb>${datensatzXml}</rk:rkdb>`))
  return ergebnisAusXml(xml)
}
