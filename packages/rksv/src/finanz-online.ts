/**
 * FinanzOnline RKSV-WebService-Client — gegen die ECHTE BMF-Schnittstelle.
 *
 * Session-basiert (session.xsd + regKasseWs.xsd/regKasse.xsd, siehe fon/session.ts und fon/rkdb.ts):
 *   1. loginRequest(tid, benid, pin, herstellerid) am Session-WS → Session-ID
 *   2. rkdbRequest(id, art_uebermittlung, <Aktion>) am RegKasse-WS — je Aufruf GENAU EINE Aktion; eine
 *      Registrierung von Signaturerstellungseinheit (SE) und Kasse sind daher zwei Aufrufe
 *   3. logoutRequest(tid, benid, id)
 *
 * `art_uebermittlung` = 'T' (Test, verbucht nichts) für Kassen der Umgebung 'test', sonst 'P' (Produktion).
 *
 * Jede Nachricht, die dieser Client erzeugt, wird in tests/fon-xsd.test.ts mit libxml2 gegen die unveränderten
 * amtlichen Schemas geprüft (Stand der Umsetzung und offene Punkte: FINANZONLINE-ABGLEICH.md). Was mit einer echten
 * Testübermittlung noch zu bestätigen ist, steht dort ebenfalls.
 *
 * Software-Signatur (Kennung AT0): als Signaturerstellungseinheit NICHT meldbar — das Schema lässt für `vda_id` nur
 * Kennungen von Vertrauensdiensteanbietern zu (AT1 A-Trust, AT2 GlobalTrust, AT3 PrimeSign). Der Client weist AT0
 * mit einer Meldung ab, statt eine ungültige Nachricht zu senden. Wie sie stattdessen gemeldet wird
 * (`registrierung_ggs`, geschlossenes Gesamtsystem), ist eine offene Entscheidung (FINANZONLINE-ABGLEICH.md).
 *
 * Die Fassade behält die bisherigen Methodennamen bei; die Aufrufer im Backend bleiben stabil.
 */

import { X509Certificate } from 'node:crypto'
import type {
  FinanzOnlineCredentials,
  KassenRegistrierung,
  RegistrierungErgebnis,
  SignedBeleg,
} from './types.js'
import {
  fonLogin,
  fonLogout,
  FON_HERSTELLER_ID_MUSTER,
  FON_HERSTELLER_ID_PLATZHALTER,
} from './fon/session.js'
import {
  rkdbRegistriereSe,
  rkdbRegistriereKasse,
  rkdbStatusKasse,
  rkdbStatusSe,
  rkdbAusfallSe,
  rkdbWiederinbetriebnahmeSe,
  rkdbAusserbetriebnahmeKasse,
  beschreibeRkdbFehler,
  BEGRUENDUNG_AUSFALL_SE_STANDARD,
  BEGRUENDUNG_AUSSERBETRIEB_STANDARD,
  type ArtUebermittlung,
  type BegruendungAusfallSe,
  type BegruendungAusserbetrieb,
  type RkdbErgebnis,
  type RkdbSession,
  type Seriennummer,
} from './fon/rkdb.js'
import { FonSoapError } from './fon/soap.js'

// ---------------------------------------------------------------------------
// Endpunkte
// ---------------------------------------------------------------------------

const BASIS = 'https://finanzonline.bmf.gv.at/fonws/ws'
const ENDPOINTS = {
  session: `${BASIS}/session`,
  rkdb:    `${BASIS}/rkdb`,
} as const

type Umgebung = 'produktion' | 'test'

export interface FinanzOnlineClientOptionen {
  /**
   * Hersteller-ID für den Login: die UID-Nummer des SOFTWAREHERSTELLERS (10–24 Buchstaben/Ziffern, ohne Leerzeichen,
   * z. B. `ATU12345678`). Fehlt sie, gilt ein Platzhalter, der das Schema erfüllt, aber kein echter Wert ist.
   * Eine in den Zugangsdaten (`FinanzOnlineCredentials.herstellerId`) mitgegebene Hersteller-ID hat Vorrang.
   */
  herstellerId?: string | undefined
}

/** Optionen der SEE-Ausfallmeldung. */
export interface SeeAusfallOptionen {
  /** Beginn des Ausfalls (Standard und Obergrenze: jetzt — ein Beginn in der Zukunft ist laut BMF unzulässig) */
  beginn?:      Date
  /** Begründungscode (BMF Punkt 4.1); Standard 2 = Signatur- bzw. Siegelerstellung unmöglich oder fehlerhaft */
  begruendung?: BegruendungAusfallSe
}

/** Optionen der SEE-Wiederinbetriebnahme. */
export interface SeeWiederinbetriebnahmeOptionen {
  /** Zeitpunkt der Wiederinbetriebnahme (Standard: jetzt) */
  ende?: Date
}

/** Optionen der Kassen-Außerbetriebnahme. */
export interface KasseAusserBetriebOptionen {
  /** Begründungscode (BMF Punkt 4.3); Standard 6 = planmäßige Außerbetriebnahme */
  begruendung?: BegruendungAusserbetrieb
}

type Sitzungsergebnis<T> = { ok: true; wert: T } | { ok: false; fehler: string }

/** Kennung des Vertrauensdiensteanbieters laut regKasse.xsd (`vda_id`): zwei Buchstaben, Ziffer 1–9, optional eine weitere. */
const VDA_ID_MUSTER = /^[A-Z]{2}[1-9][0-9]?$/

/** Seriennummer hexadezimal, ohne `0x` (regKasse.xsd: `[0-9A-Fa-f]+`, höchstens 50 Zeichen) */
const SERIENNUMMER_HEX_MUSTER = /^[0-9A-Fa-f]{1,50}$/

const HINWEIS_PLATZHALTER =
  ' — Hinweis: Es wird noch die Platzhalter-Hersteller-ID verwendet. Die Hersteller-ID (UID des Softwareherstellers) ' +
  'ist in der Konfiguration der Kassa einzustellen (FON_HERSTELLER_ID).'

const MELDUNG_AT0 =
  'Die Software-Signatur dieser Kasse (Kennung AT0, selbst erzeugtes Zertifikat) kann bei FinanzOnline nicht als ' +
  'Signaturerstellungseinheit registriert werden: Zugelassen sind nur Vertrauensdiensteanbieter mit den Kennungen ' +
  'AT1 (A-Trust), AT2 (GlobalTrust) und AT3 (PrimeSign). Für den Echtbetrieb die Kasse in den Einstellungen unter ' +
  '„Signaturerstellungseinheit (SEE)“ auf A-Trust umstellen; die Software-Signatur ist für Entwicklung, Test und den ' +
  'provisorischen Betrieb gedacht.'

/** Prüft die Kennung des Vertrauensdiensteanbieters, BEVOR etwas gesendet wird. Gibt die Meldung zurück oder `undefined`. */
function pruefeVdaId(vdaId: string): string | undefined {
  if (vdaId === 'AT0') return MELDUNG_AT0
  if (!VDA_ID_MUSTER.test(vdaId)) {
    return `Die Kennung des Vertrauensdiensteanbieters „${vdaId}“ ist ungültig (erwartet z. B. AT1 für A-Trust).`
  }
  return undefined
}

/** Seriennummer aus Datenbank/Beleg (hexadezimal) als Angabe für FinanzOnline: mit Attribut `hex="true"`. */
function hexSeriennummer(wert: string): { ok: true; sn: Seriennummer } | { ok: false; fehler: string } {
  if (!SERIENNUMMER_HEX_MUSTER.test(wert)) {
    return { ok: false, fehler: `Die Zertifikats-Seriennummer „${wert}“ ist ungültig (hexadezimal, ohne 0x, höchstens 50 Zeichen).` }
  }
  return { ok: true, sn: { wert, hex: true } }
}

export class FinanzOnlineClient {
  private readonly artUebermittlung: ArtUebermittlung
  private readonly herstellerId:     string

  constructor(umgebung: Umgebung = 'produktion', optionen: FinanzOnlineClientOptionen = {}) {
    this.artUebermittlung = umgebung === 'test' ? 'T' : 'P'
    this.herstellerId     = optionen.herstellerId?.trim() || FON_HERSTELLER_ID_PLATZHALTER
  }

  /**
   * login → op(session) → logout. Fehlermeldungen (auch Netz- und SOAP-Fehler) kommen als Ergebnis zurück,
   * nicht als Ausnahme.
   */
  private async imSession<T>(
    credentials: FinanzOnlineCredentials,
    op: (session: RkdbSession) => Promise<T>,
  ): Promise<Sitzungsergebnis<T>> {
    const herstellerId = credentials.herstellerId?.trim() || this.herstellerId
    if (!FON_HERSTELLER_ID_MUSTER.test(herstellerId)) {
      return {
        ok: false,
        fehler: `Die Hersteller-ID „${herstellerId}“ ist ungültig: erwartet werden 10 bis 24 Buchstaben oder Ziffern ` +
                '(die UID des Softwareherstellers, z. B. ATU12345678).',
      }
    }

    let login: Awaited<ReturnType<typeof fonLogin>>
    try {
      login = await fonLogin(ENDPOINTS.session, credentials.teilnehmerId, credentials.benutzerkennung, credentials.pin, herstellerId)
    } catch (err) {
      if (err instanceof FonSoapError) return { ok: false, fehler: err.message }
      throw err
    }
    if (!login.erfolgreich || !login.sessionId) {
      const hinweis = herstellerId === FON_HERSTELLER_ID_PLATZHALTER ? HINWEIS_PLATZHALTER : ''
      return { ok: false, fehler: `FON-Login fehlgeschlagen (rc ${login.rc ?? '?'}): ${login.msg ?? ''}${hinweis}`.trim() }
    }

    const session: RkdbSession = {
      tid:   credentials.teilnehmerId,
      benid: credentials.benutzerkennung,
      id:    login.sessionId,
      artUebermittlung: this.artUebermittlung,
    }
    try {
      return { ok: true, wert: await op(session) }
    } catch (err) {
      if (err instanceof FonSoapError) return { ok: false, fehler: err.message }
      throw err
    } finally {
      await fonLogout(ENDPOINTS.session, credentials.teilnehmerId, credentials.benutzerkennung, login.sessionId)
    }
  }

  /**
   * Registriert Signaturerstellungseinheit (SE) und Kasse — in ZWEI Aufrufen (registrierung_se, dann
   * registrierung_kasse), weil das Schema je Aufruf nur eine Datensatzart erlaubt.
   *
   * Kennt FinanzOnline die SE schon (Statusabfrage über die Seriennummer), wird sie nicht noch einmal gemeldet: Nach
   * einem Abbruch zwischen den beiden Schritten käme sonst bei jedem Wiederholen „bereits gespeichert", und die Kasse
   * würde nie angemeldet. Eine bereits registrierte KASSE wird dagegen nie stillschweigend übernommen — FinanzOnline
   * kennt dann womöglich einen anderen Benutzerschlüssel; die Ablehnung muss sichtbar bleiben.
   */
  async kasseInBetriebNehmen(reg: KassenRegistrierung): Promise<RegistrierungErgebnis> {
    const vdaFehler = pruefeVdaId(reg.vdaId)
    if (vdaFehler) return { erfolgreich: false, fehler: vdaFehler }

    let seriennummer: Seriennummer
    try {
      seriennummer = { wert: zertSeriennummerDezimal(reg.zertifikatDER) }
    } catch (err) {
      return {
        erfolgreich: false,
        fehler: `Das Zertifikat der Signaturerstellungseinheit ist nicht lesbar: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const res = await this.imSession(reg.credentials, async (session) => {
      // Die Vorabfrage darf nie selbst zum Hindernis werden: scheitert sie technisch (SOAP-Fault, Netz), gilt die SE als
      // unbekannt — die Registrierung unten meldet einen echten Fehler dann selbst.
      let bekannt: RkdbErgebnis | undefined
      try {
        bekannt = await rkdbStatusSe(ENDPOINTS.rkdb, session, seriennummer)
      } catch (err) {
        if (!(err instanceof FonSoapError)) throw err
      }
      if (!(bekannt?.erfolgreich && bekannt.abfrageErgebnis)) {
        const se = await rkdbRegistriereSe(ENDPOINTS.rkdb, session, { artSe: reg.artSe, vdaId: reg.vdaId, seriennummer })
        if (!se.erfolgreich) return { gegenstand: 'der Signaturerstellungseinheit', ergebnis: se }
      }
      const kasse = await rkdbRegistriereKasse(ENDPOINTS.rkdb, session, {
        kassenidentifikationsnummer: reg.kassenId,
        benutzerschluesselBase64:    reg.benutzerschluesselBase64,
      })
      return { gegenstand: 'der Kasse', ergebnis: kasse }
    })
    if (!res.ok) return { erfolgreich: false, fehler: res.fehler }
    const { gegenstand, ergebnis } = res.wert
    return ergebnis.erfolgreich
      ? { erfolgreich: true }
      : { erfolgreich: false, fehler: `Registrierung ${gegenstand} abgelehnt ${beschreibeRkdbFehler(ergebnis)}` }
  }

  /**
   * „Startbeleg-Prüfung": hier wird der Kassen-Status abgefragt (REGISTRIERT/IN_BETRIEB = ok), nicht der Beleg
   * übermittelt. Der Startbeleg selbst ist mit der BMF-Belegcheck-App zu prüfen. Der Webservice kennt zwar
   * `belegpruefung` (ein Beleg je Aufruf, Antwort synchron), der Client nutzt sie bewusst noch nicht — siehe
   * FINANZONLINE-ABGLEICH.md.
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
    if (!res.wert.erfolgreich) {
      return { erfolgreich: false, fehler: `Kassen-Status abgelehnt ${beschreibeRkdbFehler(res.wert)}` }
    }
    const status = res.wert.abfrageErgebnis
    return status === undefined || status === 'REGISTRIERT' || status === 'IN_BETRIEB'
      ? { erfolgreich: true, ...(status && { pruefwert: status }) }
      : { erfolgreich: false, fehler: `Kassen-Status: ${status}` }
  }

  /** Kasse abmelden (`ausfall_kasse` mit `ausserbetriebnahme`; FinanzOnline nimmt den Zeitpunkt der Übermittlung). */
  async kasseAusserBetriebNehmen(
    kassenId: string,
    credentials: FinanzOnlineCredentials,
    optionen: KasseAusserBetriebOptionen = {},
  ): Promise<RegistrierungErgebnis> {
    const res = await this.imSession(credentials, (session) =>
      rkdbAusserbetriebnahmeKasse(ENDPOINTS.rkdb, session, {
        kassenidentifikationsnummer: kassenId,
        begruendung:                 optionen.begruendung ?? BEGRUENDUNG_AUSSERBETRIEB_STANDARD,
      }))
    return meldungsergebnis(res, 'Außerbetriebnahme')
  }

  /**
   * SEE-Ausfall melden.
   * @param seriennummerZertifikat  Seriennummer des Zertifikats HEXADEZIMAL (wie in Datenbank und Beleg), ohne 0x
   */
  async seeAusfallMelden(
    _kassenId: string,
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
    optionen: SeeAusfallOptionen = {},
  ): Promise<RegistrierungErgebnis> {
    const sn = hexSeriennummer(seriennummerZertifikat)
    if (!sn.ok) return { erfolgreich: false, fehler: sn.fehler }
    const jetzt  = new Date()
    const beginn = optionen.beginn && optionen.beginn.getTime() < jetzt.getTime() ? optionen.beginn : jetzt
    const res = await this.imSession(credentials, (session) =>
      rkdbAusfallSe(ENDPOINTS.rkdb, session, {
        seriennummer: sn.sn,
        begruendung:  optionen.begruendung ?? BEGRUENDUNG_AUSFALL_SE_STANDARD,
        beginn,
      }))
    return meldungsergebnis(res, 'SEE-Ausfall')
  }

  /**
   * SEE-Wiederinbetriebnahme melden.
   * @param seriennummerZertifikat  Seriennummer des Zertifikats HEXADEZIMAL (wie in Datenbank und Beleg), ohne 0x
   */
  async seeWiederinbetriebnahmeMelden(
    _kassenId: string,
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
    optionen: SeeWiederinbetriebnahmeOptionen = {},
  ): Promise<RegistrierungErgebnis> {
    const sn = hexSeriennummer(seriennummerZertifikat)
    if (!sn.ok) return { erfolgreich: false, fehler: sn.fehler }
    const res = await this.imSession(credentials, (session) =>
      rkdbWiederinbetriebnahmeSe(ENDPOINTS.rkdb, session, { seriennummer: sn.sn, ende: optionen.ende ?? new Date() }))
    return meldungsergebnis(res, 'SEE-Wiederinbetriebnahme')
  }

  /**
   * Status einer SEE abfragen (AKTIVIERT/AUSFALL …).
   * @param seriennummerZertifikat  Seriennummer des Zertifikats HEXADEZIMAL (wie in Datenbank und Beleg), ohne 0x
   */
  async statusSe(
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const sn = hexSeriennummer(seriennummerZertifikat)
    if (!sn.ok) return { erfolgreich: false, fehler: sn.fehler }
    const res = await this.imSession(credentials, (session) => rkdbStatusSe(ENDPOINTS.rkdb, session, sn.sn))
    if (!res.ok) return { erfolgreich: false, fehler: res.fehler }
    return res.wert.erfolgreich
      ? { erfolgreich: true, ...(res.wert.abfrageErgebnis && { pruefwert: res.wert.abfrageErgebnis }) }
      : { erfolgreich: false, fehler: `Status-Abfrage abgelehnt ${beschreibeRkdbFehler(res.wert)}` }
  }
}

/** Ergebnis einer Meldung (Ausfall, Wiederinbetriebnahme, Außerbetriebnahme): Erfolg = jede Meldung mit rc 0. */
function meldungsergebnis(res: Sitzungsergebnis<RkdbErgebnis>, kontext: string): RegistrierungErgebnis {
  if (!res.ok) return { erfolgreich: false, fehler: res.fehler }
  return res.wert.erfolgreich
    ? { erfolgreich: true }
    : { erfolgreich: false, fehler: `${kontext} abgelehnt ${beschreibeRkdbFehler(res.wert)}` }
}

/**
 * Zertifikats-Seriennummer DEZIMAL (die „Original-Kodierung" der BMF-Beschreibung) —
 * X509Certificate.serialNumber liefert sie hexadezimal.
 */
export function zertSeriennummerDezimal(zertifikatDER: Buffer): string {
  const hex = new X509Certificate(zertifikatDER).serialNumber
  return BigInt(`0x${hex}`).toString(10)
}
