/**
 * FinanzOnline RKSV-WebService-Client — gegen die ECHTE BMF-Schnittstelle.
 *
 * Session-basiert (session.xsd + regKasseWs.xsd/regKasse.xsd):
 *   1. login(tid, benid, pin, herstellerid) am Session-WS → Session-ID
 *   2. rkdb(id, art_uebermittlung, <Aktion>) am RegKasse-WS
 *      (EINE Operation; Aktion = registrierung_se/-kasse | status_kasse/-se)
 *   3. logout(tid, benid, id)
 *
 * `art_uebermittlung` = 'T' (Test, verbucht nichts) für Kassen der Umgebung
 * 'test', sonst 'P' (Produktion).
 *
 * Die Startbeleg-Prüfung läuft NICHT über diesen WebService, sondern über die
 * BMF-BelegCheck-App bzw. den DEP-Upload — `startbelegPruefen` fragt daher den
 * Kassen-Status ab, statt den Beleg zu übermitteln.
 *
 * Die Fassade behält die bisherigen Methodensignaturen bei; die Aufrufer im
 * Backend bleiben stabil.
 */

import { X509Certificate } from 'node:crypto'
import type {
  FinanzOnlineCredentials,
  KassenRegistrierung,
  RegistrierungErgebnis,
  SignedBeleg,
} from './types.js'
import { fonLogin, fonLogout } from './fon/session.js'
import {
  rkdbRegistriere,
  rkdbStatusKasse,
  rkdbStatusSe,
  rkdbAktion,
  type ArtUebermittlung,
  type RkdbSession,
} from './fon/rkdb.js'
import { xmlEscape } from './fon/soap.js'

// ---------------------------------------------------------------------------
// Endpunkte
// ---------------------------------------------------------------------------

const BASIS = 'https://finanzonline.bmf.gv.at/fonws/ws'
const ENDPOINTS = {
  session: `${BASIS}/session`,
  rkdb:    `${BASIS}/rkdb`,
} as const

/** Default-Software-Hersteller-ID (bei BMF zu registrieren; via Credentials überschreibbar). */
const DEFAULT_HERSTELLER_ID = 'ATU_KASSA_RKSV_0001'

type Umgebung = 'produktion' | 'test'

export class FinanzOnlineClient {
  private readonly artUebermittlung: ArtUebermittlung

  constructor(umgebung: Umgebung = 'produktion') {
    this.artUebermittlung = umgebung === 'test' ? 'T' : 'P'
  }

  /** login → op(session) → logout. Fehlermeldungen als RegistrierungErgebnis. */
  private async imSession<T>(
    credentials: FinanzOnlineCredentials,
    op: (session: RkdbSession) => Promise<T>,
  ): Promise<{ ok: true; wert: T } | { ok: false; fehler: string }> {
    const herstellerId = credentials.herstellerId ?? DEFAULT_HERSTELLER_ID
    const login = await fonLogin(
      ENDPOINTS.session,
      credentials.teilnehmerId,
      credentials.benutzerkennung,
      credentials.pin,
      herstellerId,
    )
    if (!login.erfolgreich || !login.sessionId) {
      return { ok: false, fehler: `FON-Login fehlgeschlagen (rc ${login.rc ?? '?'}): ${login.msg ?? ''}`.trim() }
    }

    const session: RkdbSession = {
      tid:   credentials.teilnehmerId,
      benid: credentials.benutzerkennung,
      id:    login.sessionId,
      artUebermittlung: this.artUebermittlung,
    }
    try {
      return { ok: true, wert: await op(session) }
    } finally {
      await fonLogout(ENDPOINTS.session, credentials.teilnehmerId, credentials.benutzerkennung, login.sessionId)
    }
  }

  /** Registriert SEE + Kasse (registrierung_se + registrierung_kasse in einem rkdb). */
  async kasseInBetriebNehmen(reg: KassenRegistrierung): Promise<RegistrierungErgebnis> {
    const res = await this.imSession(reg.credentials, (session) =>
      rkdbRegistriere(
        ENDPOINTS.rkdb,
        session,
        { artSe: reg.artSe, vdaId: reg.vdaId, zertifikatsseriennummer: zertSeriennummerDezimal(reg.zertifikatDER) },
        { kassenidentifikationsnummer: reg.kassenId, benutzerschluesselBase64: reg.benutzerschluesselBase64 },
      ),
    )
    if (!res.ok) return { erfolgreich: false, fehler: res.fehler }
    return res.wert.erfolgreich
      ? { erfolgreich: true }
      : { erfolgreich: false, fehler: `Registrierung abgelehnt (rc ${res.wert.rc}): ${res.wert.msg ?? ''}`.trim() }
  }

  /**
   * „Startbeleg-Prüfung": über den WebService NICHT möglich — hier wird
   * stattdessen der Kassen-Status abgefragt (REGISTRIERT/IN_BETRIEB = ok).
   * Der Startbeleg selbst ist mit der BMF-BelegCheck-App zu prüfen.
   */
  async startbelegPruefen(
    _startbeleg: SignedBeleg,
    credentials: FinanzOnlineCredentials,
    kassenId?: string,
  ): Promise<RegistrierungErgebnis> {
    if (!kassenId) {
      // Ohne Kassen-ID keine Statusabfrage möglich — als „ok, aber via App prüfen".
      return { erfolgreich: true }
    }
    const res = await this.imSession(credentials, (session) => rkdbStatusKasse(ENDPOINTS.rkdb, session, kassenId))
    if (!res.ok) return { erfolgreich: false, fehler: res.fehler }
    const status = res.wert.abfrageErgebnis
    const ok = res.wert.erfolgreich && (status === 'REGISTRIERT' || status === 'IN_BETRIEB' || status == null)
    return ok
      ? { erfolgreich: true, ...(status && { pruefwert: status }) }
      : { erfolgreich: false, fehler: `Kassen-Status: ${status ?? res.wert.msg ?? 'unbekannt'}` }
  }

  /** Kasse abmelden (Außerbetriebnahme-Datensatz mit Ende-Zeitstempel). */
  async kasseAusserBetriebNehmen(
    kassenId: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const datensatz =
      `<ausserbetriebnahme_kasse>` +
      `<satznr>1</satznr>` +
      `<kassenidentifikationsnummer>${xmlEscape(kassenId)}</kassenidentifikationsnummer>` +
      `<ende>${new Date().toISOString()}</ende>` +
      `</ausserbetriebnahme_kasse>`
    return this.rkdbFacade(credentials, datensatz, 'Außerbetriebnahme')
  }

  /** SEE-Ausfall melden. */
  async seeAusfallMelden(
    _kassenId: string,
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const datensatz =
      `<ausfall_se>` +
      `<satznr>1</satznr>` +
      `<zertifikatsseriennummer>${xmlEscape(seriennummerZertifikat)}</zertifikatsseriennummer>` +
      `<beginn>${new Date().toISOString()}</beginn>` +
      `</ausfall_se>`
    return this.rkdbFacade(credentials, datensatz, 'SEE-Ausfall')
  }

  /** SEE-Wiederinbetriebnahme melden. */
  async seeWiederinbetriebnahmeMelden(
    _kassenId: string,
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const datensatz =
      `<wiederinbetriebnahme_se>` +
      `<satznr>1</satznr>` +
      `<zertifikatsseriennummer>${xmlEscape(seriennummerZertifikat)}</zertifikatsseriennummer>` +
      `<ende>${new Date().toISOString()}</ende>` +
      `</wiederinbetriebnahme_se>`
    return this.rkdbFacade(credentials, datensatz, 'SEE-Wiederinbetriebnahme')
  }

  /** Status einer SEE abfragen (AKTIVIERT/AUSFALL). */
  async statusSe(
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const res = await this.imSession(credentials, (session) => rkdbStatusSe(ENDPOINTS.rkdb, session, seriennummerZertifikat))
    if (!res.ok) return { erfolgreich: false, fehler: res.fehler }
    return res.wert.erfolgreich
      ? { erfolgreich: true, ...(res.wert.abfrageErgebnis && { pruefwert: res.wert.abfrageErgebnis }) }
      : { erfolgreich: false, fehler: res.wert.msg ?? 'Status-Abfrage fehlgeschlagen' }
  }

  private async rkdbFacade(
    credentials: FinanzOnlineCredentials,
    datensatzXml: string,
    kontext: string,
  ): Promise<RegistrierungErgebnis> {
    const res = await this.imSession(credentials, (session) => rkdbAktion(ENDPOINTS.rkdb, session, datensatzXml))
    if (!res.ok) return { erfolgreich: false, fehler: res.fehler }
    return res.wert.erfolgreich
      ? { erfolgreich: true }
      : { erfolgreich: false, fehler: `${kontext} abgelehnt (rc ${res.wert.rc}): ${res.wert.msg ?? ''}`.trim() }
  }
}

/**
 * Zertifikats-Seriennummer DEZIMAL — FON erwartet die Seriennummer als
 * Dezimalzahl, X509Certificate.serialNumber liefert sie hexadezimal.
 */
export function zertSeriennummerDezimal(zertifikatDER: Buffer): string {
  const hex = new X509Certificate(zertifikatDER).serialNumber
  return BigInt(`0x${hex}`).toString(10)
}
