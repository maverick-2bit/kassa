/**
 * FinanzOnline RKSV WebService Client
 *
 * Schnittstelle zur Registrierung und Abmeldung von Registrierkassen
 * bei der österreichischen Finanzbehörde (BMF).
 *
 * WSDL: https://finanzonline.bmf.gv.at/fon/ws/rksv/RKSVService.wsdl
 * Testumgebung: https://finanzonline-test.bmf.gv.at/fon/ws/rksv/
 *
 * Implementiert als direkte SOAP-Aufrufe via fetch (kein node-soap).
 */

import { X509Certificate } from 'node:crypto'
import type {
  FinanzOnlineCredentials,
  KassenRegistrierung,
  RegistrierungErgebnis,
  SignedBeleg,
} from './types.js'

// ---------------------------------------------------------------------------
// Endpunkte
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  produktion: 'https://finanzonline.bmf.gv.at/fon/ws/rksv/',
  test:       'https://finanzonline-test.bmf.gv.at/fon/ws/rksv/',
} as const

type Umgebung = keyof typeof ENDPOINTS

// ---------------------------------------------------------------------------
// SOAP-Hilfsfunktionen
// ---------------------------------------------------------------------------

function soapEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:rksv="https://finanzonline.bmf.gv.at/fon/ws/rksv">
  <soapenv:Header/>
  <soapenv:Body>
    ${body}
  </soapenv:Body>
</soapenv:Envelope>`
}

function extractSoapValue(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`)
  return regex.exec(xml)?.[1]?.trim()
}

async function soapRequest(
  endpoint: string,
  action: string,
  body: string,
): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction':   `"${action}"`,
    },
    body: soapEnvelope(body),
  })

  if (!response.ok) {
    throw new Error(`FinanzOnline HTTP ${response.status}: ${await response.text()}`)
  }

  return response.text()
}

// ---------------------------------------------------------------------------
// FinanzOnline Client
// ---------------------------------------------------------------------------

export class FinanzOnlineClient {
  private endpoint: string

  constructor(umgebung: Umgebung = 'produktion') {
    this.endpoint = ENDPOINTS[umgebung]
  }

  // -------------------------------------------------------------------------
  // Kasse in Betrieb nehmen
  // -------------------------------------------------------------------------

  /**
   * Registriert eine Kasse und ihr Signaturzertifikat bei FinanzOnline.
   * Muss VOR dem ersten Startbeleg aufgerufen werden.
   */
  async kasseInBetriebNehmen(reg: KassenRegistrierung): Promise<RegistrierungErgebnis> {
    const cert       = new X509Certificate(reg.zertifikatDER)
    const certBase64 = reg.zertifikatDER.toString('base64')

    // Schritt 1: SEE registrieren
    const seeBody = `
      <rksv:SEERegistrierung>
        <rksv:TID>${xmlEscape(reg.credentials.teilnehmerId)}</rksv:TID>
        <rksv:BenID>${xmlEscape(reg.credentials.benutzerkennung)}</rksv:BenID>
        <rksv:PIN>${xmlEscape(reg.credentials.pin)}</rksv:PIN>
        <rksv:ArtDerSEE>SOFTWARE</rksv:ArtDerSEE>
        <rksv:ZertifikatSEE>${certBase64}</rksv:ZertifikatSEE>
        <rksv:SeriennummerZertifikat>${cert.serialNumber}</rksv:SeriennummerZertifikat>
      </rksv:SEERegistrierung>`

    const seeXml = await soapRequest(
      this.endpoint,
      'https://finanzonline.bmf.gv.at/fon/ws/rksv/SEERegistrierung',
      seeBody,
    )

    const seeCode = extractSoapValue(seeXml, 'Code')
    if (seeCode !== '000') {
      return {
        erfolgreich: false,
        fehler: `SEE-Registrierung fehlgeschlagen (Code ${seeCode}): ${extractSoapValue(seeXml, 'Info')}`,
      }
    }

    // Schritt 2: Kasse registrieren
    const kasseBody = `
      <rksv:KasseRegistrierung>
        <rksv:TID>${xmlEscape(reg.credentials.teilnehmerId)}</rksv:TID>
        <rksv:BenID>${xmlEscape(reg.credentials.benutzerkennung)}</rksv:BenID>
        <rksv:PIN>${xmlEscape(reg.credentials.pin)}</rksv:PIN>
        <rksv:KUID>${xmlEscape(reg.uid)}</rksv:KUID>
        <rksv:KassenID>${xmlEscape(reg.kassenId)}</rksv:KassenID>
        <rksv:SeriennummerZertifikat>${cert.serialNumber}</rksv:SeriennummerZertifikat>
      </rksv:KasseRegistrierung>`

    const kasseXml = await soapRequest(
      this.endpoint,
      'https://finanzonline.bmf.gv.at/fon/ws/rksv/KasseRegistrierung',
      kasseBody,
    )

    const kasseCode = extractSoapValue(kasseXml, 'Code')
    if (kasseCode !== '000') {
      return {
        erfolgreich: false,
        fehler: `Kassen-Registrierung fehlgeschlagen (Code ${kasseCode}): ${extractSoapValue(kasseXml, 'Info')}`,
      }
    }

    return { erfolgreich: true }
  }

  // -------------------------------------------------------------------------
  // Startbeleg prüfen
  // -------------------------------------------------------------------------

  /**
   * Lässt den Startbeleg von FinanzOnline prüfen.
   * MUSS nach der Registrierung und dem ersten Beleg aufgerufen werden.
   */
  async startbelegPruefen(
    startbeleg: SignedBeleg,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const body = `
      <rksv:StartbelegPruefen>
        <rksv:TID>${xmlEscape(credentials.teilnehmerId)}</rksv:TID>
        <rksv:BenID>${xmlEscape(credentials.benutzerkennung)}</rksv:BenID>
        <rksv:PIN>${xmlEscape(credentials.pin)}</rksv:PIN>
        <rksv:Startbeleg>${xmlEscape(startbeleg.maschinenlesbareCode)}</rksv:Startbeleg>
      </rksv:StartbelegPruefen>`

    const xml      = await soapRequest(
      this.endpoint,
      'https://finanzonline.bmf.gv.at/fon/ws/rksv/StartbelegPruefen',
      body,
    )
    const code     = extractSoapValue(xml, 'Code')
    const pruefwert = extractSoapValue(xml, 'Pruefwert')

    const ergebnis: RegistrierungErgebnis = { erfolgreich: code === '000' }
    if (pruefwert) ergebnis.pruefwert = pruefwert
    if (code !== '000') {
      ergebnis.fehler = `Startbeleg-Prüfung fehlgeschlagen (Code ${code}): ${extractSoapValue(xml, 'Info') ?? ''}`
    }
    return ergebnis
  }

  // -------------------------------------------------------------------------
  // Kasse außer Betrieb nehmen (für Betreiberwechsel / Stilllegung)
  // -------------------------------------------------------------------------

  /**
   * Meldet eine Kasse bei FinanzOnline ab.
   * MUSS nach dem Schlussbeleg aufgerufen werden.
   */
  async kasseAusserBetriebNehmen(
    kassenId: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const body = `
      <rksv:KasseAusserBetriebnahme>
        <rksv:TID>${xmlEscape(credentials.teilnehmerId)}</rksv:TID>
        <rksv:BenID>${xmlEscape(credentials.benutzerkennung)}</rksv:BenID>
        <rksv:PIN>${xmlEscape(credentials.pin)}</rksv:PIN>
        <rksv:KassenID>${xmlEscape(kassenId)}</rksv:KassenID>
      </rksv:KasseAusserBetriebnahme>`

    const xml  = await soapRequest(
      this.endpoint,
      'https://finanzonline.bmf.gv.at/fon/ws/rksv/KasseAusserBetriebnahme',
      body,
    )
    const code = extractSoapValue(xml, 'Code')

    const ergebnis: RegistrierungErgebnis = { erfolgreich: code === '000' }
    if (code !== '000') {
      ergebnis.fehler = `Außerbetriebnahme fehlgeschlagen (Code ${code}): ${extractSoapValue(xml, 'Info') ?? ''}`
    }
    return ergebnis
  }

  // -------------------------------------------------------------------------
  // SEE-Ausfall / Wiederinbetriebnahme melden
  // -------------------------------------------------------------------------

  /**
   * Meldet den Ausfall der Signaturerstellungseinheit (SEE) an FinanzOnline.
   * RKSV verlangt die Meldung eines Ausfalls, der länger als 48 Stunden dauert.
   *
   * Hinweis: Die Element-/Action-Namen folgen dem RKSV-WebService; sie sind vor
   * dem Produktivbetrieb gegen die aktuelle BMF-WSDL zu verifizieren.
   */
  async seeAusfallMelden(
    kassenId: string,
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    return this.seeStatusMelden('SEEAusfall', kassenId, seriennummerZertifikat, credentials)
  }

  /**
   * Meldet die Wiederinbetriebnahme der SEE nach einem Ausfall an FinanzOnline.
   */
  async seeWiederinbetriebnahmeMelden(
    kassenId: string,
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    return this.seeStatusMelden('SEEWiederinbetriebnahme', kassenId, seriennummerZertifikat, credentials)
  }

  private async seeStatusMelden(
    operation: 'SEEAusfall' | 'SEEWiederinbetriebnahme',
    kassenId: string,
    seriennummerZertifikat: string,
    credentials: FinanzOnlineCredentials,
  ): Promise<RegistrierungErgebnis> {
    const body = `
      <rksv:${operation}>
        <rksv:TID>${xmlEscape(credentials.teilnehmerId)}</rksv:TID>
        <rksv:BenID>${xmlEscape(credentials.benutzerkennung)}</rksv:BenID>
        <rksv:PIN>${xmlEscape(credentials.pin)}</rksv:PIN>
        <rksv:KassenID>${xmlEscape(kassenId)}</rksv:KassenID>
        <rksv:SeriennummerZertifikat>${xmlEscape(seriennummerZertifikat)}</rksv:SeriennummerZertifikat>
      </rksv:${operation}>`

    const xml  = await soapRequest(
      this.endpoint,
      `https://finanzonline.bmf.gv.at/fon/ws/rksv/${operation}`,
      body,
    )
    const code = extractSoapValue(xml, 'Code')

    const ergebnis: RegistrierungErgebnis = { erfolgreich: code === '000' }
    if (code !== '000') {
      ergebnis.fehler = `${operation} fehlgeschlagen (Code ${code}): ${extractSoapValue(xml, 'Info') ?? ''}`
    }
    return ergebnis
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
