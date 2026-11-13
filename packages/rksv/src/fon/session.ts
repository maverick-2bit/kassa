/**
 * FinanzOnline Session-WebService — echte BMF-Schnittstelle.
 *
 *   Endpoint:   https://finanzonline.bmf.gv.at/fonws/ws/session
 *   Namespace:  https://finanzonline.bmf.gv.at/fon/ws/session   (session.xsd, elementFormDefault="qualified")
 *   Operationen: login (SOAPAction "login"), logout (SOAPAction "logout")
 *
 * Document/literal: die SOAP-Nachricht ist genau EIN Element im Body — `loginRequest` bzw. `logoutRequest`
 * (nicht `login`/`logout`: das sind die Namen der Operationen, nicht der Nachrichten).
 *
 *   loginRequest  (tid, benid, pin, herstellerid)  →  loginResponse (id = Session-ID, rc, msg?)
 *   logoutRequest (tid, benid, id)                 →  logoutResponse (rc, msg?)
 *
 * `rc` ist hier eine ganze Zahl (xs:int); 0 = ok.
 */

import { xmlEscape, xmlUnescape, extractValue, soapRequest } from './soap.js'

export interface SessionEndpunkte {
  /** Session-WS-URL, z. B. https://finanzonline.bmf.gv.at/fonws/ws/session */
  sessionUrl: string
}

const SESSION_NS = 'https://finanzonline.bmf.gv.at/fon/ws/session'

/**
 * Hersteller-ID im Login: 10–24 Buchstaben/Ziffern (session.xsd, `loginRequest/herstellerid`).
 * Laut BMF-Beschreibung des Session-Webservice ist das die UID-Nummer des SOFTWAREHERSTELLERS
 * (nicht des Betriebs, der die Kasse benutzt), ohne Leerzeichen — z. B. `ATU12345678`.
 */
export const FON_HERSTELLER_ID_MUSTER = /^[0-9A-Za-z]{10,24}$/

/**
 * Platzhalter, solange keine Hersteller-ID eingestellt ist. Er erfüllt das Muster des Schemas (der Login ist
 * also wohlgeformt), ist aber ERKENNBAR kein echter Wert: FinanzOnline wird ihn voraussichtlich ablehnen, und
 * der Client weist dann in der Fehlermeldung darauf hin.
 */
export const FON_HERSTELLER_ID_PLATZHALTER = 'KASSANICHTGESETZT'

export interface LoginErgebnis {
  erfolgreich: boolean
  sessionId?:  string
  rc?:         string
  msg?:        string
}

export async function fonLogin(
  sessionUrl: string,
  tid: string,
  benid: string,
  pin: string,
  herstellerId: string,
): Promise<LoginErgebnis> {
  const body =
    `<ses:loginRequest xmlns:ses="${SESSION_NS}">` +
    `<ses:tid>${xmlEscape(tid)}</ses:tid>` +
    `<ses:benid>${xmlEscape(benid)}</ses:benid>` +
    `<ses:pin>${xmlEscape(pin)}</ses:pin>` +
    `<ses:herstellerid>${xmlEscape(herstellerId)}</ses:herstellerid>` +
    `</ses:loginRequest>`

  const xml = await soapRequest(sessionUrl, 'login', body)
  const rc  = extractValue(xml, 'rc')
  const id  = extractValue(xml, 'id')
  const msg = extractValue(xml, 'msg')

  // rc === '0' = Erfolg; die Session-ID steht dann im Feld id.
  const erfolgreich = rc === '0' && !!id && id.length > 0
  return {
    erfolgreich,
    ...(id  && { sessionId: id }),
    ...(rc  && { rc }),
    ...(msg && { msg: xmlUnescape(msg) }),
  }
}

export async function fonLogout(
  sessionUrl: string,
  tid: string,
  benid: string,
  sessionId: string,
): Promise<void> {
  const body =
    `<ses:logoutRequest xmlns:ses="${SESSION_NS}">` +
    `<ses:tid>${xmlEscape(tid)}</ses:tid>` +
    `<ses:benid>${xmlEscape(benid)}</ses:benid>` +
    `<ses:id>${xmlEscape(sessionId)}</ses:id>` +
    `</ses:logoutRequest>`

  // Logout-Fehler sind nicht fatal — Session läuft serverseitig ohnehin ab.
  try {
    await soapRequest(sessionUrl, 'logout', body)
  } catch {
    /* ignorieren */
  }
}
