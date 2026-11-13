/**
 * Ersatz für die FinanzOnline-Dienste in Tests: ersetzt `fetch`, schneidet jede Anfrage mit und antwortet je nach Art der
 * Anfrage (Login, Logout, Statusabfrage, rkdb-Paket). Die Antworten kommen aus fixtures/fon-beispiele.ts — dort sind sie
 * gegen die amtlichen Schemas geprüft (tests/fon-xsd.test.ts), die Mocks sind also selbst schema-gültig.
 */

import { vi } from 'vitest'
import { FinanzOnlineClient, type FinanzOnlineClientOptionen } from '../../src/finanz-online.js'
import { ANTWORTEN } from '../fixtures/fon-beispiele.js'
import type { FonSchema } from './xsd.js'

/** Art einer Anfrage an den Dienst */
export type AufrufArt = 'login' | 'logout' | 'status_kasse' | 'status_see' | 'rkdb'

export interface Aufruf {
  art:        AufrufArt
  url:        string
  soapAction: string
  /** der komplette SOAP-Umschlag */
  envelope:   string
  /** Inhalt von soap:Body = die Nachricht, die das Schema meint */
  body:       string
  schema:     FonSchema
}

/**
 * Eine Antwort des Dienstes: XML (HTTP 200), ein HTTP-Status mit Text oder ein Netzfehler (Ausnahme).
 * Nur die ZEICHENKETTEN-Form gilt als schema-gültige Antwort (`bedienteAntworten`); wer bewusst Unbrauchbares ausliefern
 * will (Wartungsseite, abgeschnittenes XML), nimmt die Objektform.
 */
export type DienstAntwort = string | { status: number; text: string } | Error

/**
 * Alle Antworten (XML-Zeichenketten), die der Ersatzdienst in dieser Testdatei ausgeliefert hat, mit dem Schema, gegen das
 * sie gelten. finanz-online.test.ts prüft sie am Ende gegen die amtlichen Schemas — Mocks, die selbst nicht schema-gültig
 * sind, haben die Befunde F-1 … F-11 lange verdeckt.
 */
export const bedienteAntworten = new Map<string, FonSchema>()

export type Antworter = (aufruf: Aufruf) => DienstAntwort

const xml = (name: string): string => {
  const a = ANTWORTEN[name]
  if (!a) throw new Error(`Antwort-Beispiel ${name} gibt es nicht`)
  return a.xml
}

/**
 * Standard: Login und Logout gelingen, jede rkdb-Anfrage wird mit „ok" beantwortet. `ueberschreibe` ersetzt die Antwort
 * je Art (z. B. `{ status_see: <XML der Antwort „SE unbekannt"> }`).
 */
export function standardAntworter(ueberschreibe: Partial<Record<AufrufArt, DienstAntwort>> = {}): Antworter {
  const standard: Record<AufrufArt, DienstAntwort> = {
    login:        xml('login-ok'),
    logout:       xml('logout-ok'),
    status_kasse: xml('rkdb-ok'),
    status_see:   xml('rkdb-ok'),
    rkdb:         xml('rkdb-ok'),
  }
  return (aufruf) => ueberschreibe[aufruf.art] ?? standard[aufruf.art]
}

function artVon(body: string): AufrufArt {
  if (body.includes('loginRequest'))   return 'login'
  if (body.includes('logoutRequest'))  return 'logout'
  if (body.includes('<rk:status_kasse>')) return 'status_kasse'
  if (body.includes('<rk:status_see>'))   return 'status_see'
  return 'rkdb'
}

/**
 * Führt `aktion` mit einem Client aus, dessen Netzzugriff ersetzt ist. Liefert alle Anfragen in der Reihenfolge, in der der
 * Client sie gesendet hat, und das Ergebnis der Aktion.
 */
export async function mitDienst<T>(
  antworter: Antworter,
  aktion: (client: FinanzOnlineClient) => Promise<T>,
  umgebung: 'test' | 'produktion' = 'test',
  clientOptionen: FinanzOnlineClientOptionen = {},
): Promise<{ aufrufe: Aufruf[]; ergebnis: T }> {
  const aufrufe: Aufruf[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = /<soap:Body>([\s\S]*)<\/soap:Body>/.exec(init.body)?.[1]
    if (body === undefined) throw new Error(`Kein soap:Body im Umschlag: ${init.body.slice(0, 200)}`)
    const aufruf: Aufruf = {
      art: artVon(body), url, soapAction: init.headers['SOAPAction']!, envelope: init.body, body,
      schema: url.endsWith('/session') ? 'session' : 'rkdb',
    }
    aufrufe.push(aufruf)
    const antwort = antworter(aufruf)
    if (antwort instanceof Error) return Promise.reject(antwort)
    if (typeof antwort === 'string') bedienteAntworten.set(antwort, aufruf.schema)
    const { status, text } = typeof antwort === 'string' ? { status: 200, text: antwort } : antwort
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) })
  }))
  try {
    return { aufrufe, ergebnis: await aktion(new FinanzOnlineClient(umgebung, clientOptionen)) }
  } finally {
    vi.unstubAllGlobals()
  }
}
