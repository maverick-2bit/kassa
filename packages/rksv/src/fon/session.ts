/**
 * FinanzOnline Session-WebService — echte BMF-Schnittstelle.
 *
 *   Endpoint:   https://finanzonline.bmf.gv.at/fonws/ws/session
 *   Namespace:  https://finanzonline.bmf.gv.at/fon/ws/session
 *   Operationen: login (SOAPAction "login"), logout (SOAPAction "logout")
 *
 * login(tid, benid, pin, herstellerid) → { id (Session-ID), rc, msg }
 * logout(tid, benid, id)               → { rc, msg }
 * (Feldnamen + Reihenfolge aus session.xsd.)
 */

import { xmlEscape, extractValue, soapRequest } from './soap.js'

export interface SessionEndpunkte {
  /** Session-WS-URL, z. B. https://finanzonline.bmf.gv.at/fonws/ws/session */
  sessionUrl: string
}

const SESSION_NS = 'https://finanzonline.bmf.gv.at/fon/ws/session'

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
    `<fon:login xmlns:fon="${SESSION_NS}">` +
    `<fon:tid>${xmlEscape(tid)}</fon:tid>` +
    `<fon:benid>${xmlEscape(benid)}</fon:benid>` +
    `<fon:pin>${xmlEscape(pin)}</fon:pin>` +
    `<fon:herstellerid>${xmlEscape(herstellerId)}</fon:herstellerid>` +
    `</fon:login>`

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
    ...(msg && { msg }),
  }
}

export async function fonLogout(
  sessionUrl: string,
  tid: string,
  benid: string,
  sessionId: string,
): Promise<void> {
  const body =
    `<fon:logout xmlns:fon="${SESSION_NS}">` +
    `<fon:tid>${xmlEscape(tid)}</fon:tid>` +
    `<fon:benid>${xmlEscape(benid)}</fon:benid>` +
    `<fon:id>${xmlEscape(sessionId)}</fon:id>` +
    `</fon:logout>`

  // Logout-Fehler sind nicht fatal — Session läuft serverseitig ohnehin ab.
  try {
    await soapRequest(sessionUrl, 'logout', body)
  } catch {
    /* ignorieren */
  }
}
