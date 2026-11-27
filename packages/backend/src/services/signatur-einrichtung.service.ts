/**
 * Signatureinheit einrichten — gemeinsam für Ersteinrichtung, weitere Kasse und Einstellungen.
 *
 * Die Kasse wird KOMPLETT auf die gewählte Variante gestellt: Ihr Zertifikat und ihre ZDA-Kennung gelten,
 * FinanzOnline bekommt genau diese Einheit gemeldet und schon der Startbeleg wird mit ihr signiert.
 * Geprüft wird VOR der FinanzOnline-Meldung — eine Kasse, deren Karte nicht steckt oder deren PIN nicht
 * stimmt, soll gar nicht erst gemeldet werden.
 */

import { X509Certificate } from 'node:crypto'
import {
  ATrustHsmEinheit,
  KARTENBRUECKE_VERSION,
  KartenError,
  SignaturkartenEinheit,
  istBrueckeVeraltet,
  jwsSigningInput,
  signiereMitKarte,
  verifiziere,
  type ApduTransport,
  type SignaturEinheit,
  type ZertifikatInfo,
} from '@kassa/rksv'
import { istErlaubteAtrustBasisUrl, type KartenbrueckeStatus, type SignaturWahl } from '@kassa/shared'
import type { kassen } from '../db/schema.js'
import { encryptPrivateKey } from '../crypto/master-key.js'

export const KEINE_BRUECKE =
  'Die Kartenbrücke ist an diesem Kassa-Server nicht eingerichtet (KARTENBRUECKE_SCHLUESSEL fehlt) — siehe ops/kartenbruecke.'

export type KartenPruefung =
  | { ok: true; zertifikatDer: Buffer; seriennummer: string; gueltigBis: Date; karte: string; hinweis?: string; pinGeprueft: boolean }
  | { ok: false; fehler: string; status: number }

/**
 * Signaturkarte prüfen: Karte steckt, ist auf die UID des Betriebs ausgestellt, Zertifikat gültig — und, wenn
 * eine PIN mitkommt, EINE Probesignatur (kein Beleg). Eine falsche PIN kostet dabei genau einen Fehlversuch
 * der Karte; die Meldung nennt die Restversuche.
 */
export async function pruefeSignaturkarte(
  transport: ApduTransport | undefined,
  opts: { uid: string | null; pin?: string | undefined; probeKennung: string },
): Promise<KartenPruefung> {
  if (!transport) return { ok: false, status: 400, fehler: KEINE_BRUECKE }
  try {
    const { karte, zertifikatDer } = await new SignaturkartenEinheit({ transport }).karte()
    const zert = new X509Certificate(zertifikatDer)
    const kartenUid = /CN=UID ([A-Z0-9]+)/.exec(zert.subject)?.[1] ?? null
    const betriebsUid = opts.uid?.replace(/\s+/g, '').toUpperCase() ?? null
    if (betriebsUid && kartenUid && kartenUid !== betriebsUid) {
      return { ok: false, status: 400, fehler: `Die Signaturkarte gehört zur UID ${kartenUid}, der Betrieb hat die UID ${betriebsUid} — bitte die Karte dieses Betriebs stecken.` }
    }
    const gueltigBis = new Date(zert.validTo)
    if (gueltigBis <= new Date()) {
      return { ok: false, status: 400, fehler: `Das Zertifikat der Signaturkarte ist abgelaufen (${gueltigBis.toISOString().slice(0, 10)}).` }
    }
    if (opts.pin !== undefined) {
      const probe = jwsSigningInput(`_R1-AT1_PINPROBE_${opts.probeKennung}_${Date.now()}`)
      const sig = await signiereMitKarte(transport, karte, probe, opts.pin, zertifikatDer)
      if (!verifiziere(probe, sig, zertifikatDer)) {
        return { ok: false, status: 502, fehler: 'Die Signaturkarte liefert eine Signatur, die nicht zu ihrem Zertifikat passt.' }
      }
    }
    return {
      ok: true, zertifikatDer, seriennummer: zert.serialNumber, gueltigBis, karte: karte.typ.bezeichnung,
      pinGeprueft: opts.pin !== undefined,
      ...(karte.typ.tauschpflichtig && { hinweis: 'Diese Kartengeneration ist nicht mehr zertifiziert und muss bis spätestens Mai 2027 getauscht werden (A-Trust).' }),
    }
  } catch (err) {
    if (!(err instanceof KartenError)) throw err
    return { ok: false, status: err.vorlaeufig ? 502 : 400, fehler: err.message }
  }
}

/** Läuft die Kartenbrücke, und ist sie so neu wie diese Kassa? Fasst die Karte nicht an. */
export async function pruefeKartenbruecke(transport: ApduTransport | undefined): Promise<KartenbrueckeStatus> {
  const basis = { eingerichtet: true, erreichbar: false, version: null, erwartet: String(KARTENBRUECKE_VERSION), veraltet: false }
  if (!transport) return { ...basis, eingerichtet: false, fehler: KEINE_BRUECKE }
  if (!transport.version) return { ...basis, erreichbar: true }
  try {
    const version = await transport.version()
    return { ...basis, erreichbar: true, version, veraltet: istBrueckeVeraltet(version) }
  } catch (err) {
    if (!(err instanceof KartenError)) throw err
    return { ...basis, fehler: err.message }
  }
}

/** Was die Einrichtung (rksv `kasseAutomatischEinrichten`) und das Anlegen der Kasse brauchen */
export interface VorbereiteteSignatur {
  /** Fehlt bei der Software-SEE (Test/Demo) */
  einheit?: SignaturEinheit
  /** Prüfung vor der FinanzOnline-Meldung (wirft mit verständlicher Meldung) */
  pruefen?: () => Promise<string>
  /** Spalten der neuen Kasse (ohne Zertifikat/ZDA — die kommen aus dem Einrichtungsergebnis) */
  kassenFelder: Partial<typeof kassen.$inferInsert>
}

export interface SignaturKontext {
  uid:              string
  kassenId:         string
  masterPassphrase: string
  kartenTransport?: ApduTransport | undefined
  /** Entwicklung/Tests: A-Trust-Mock auf dem eigenen Rechner zulassen (NIE in Produktion) */
  lokaleAtrustUrlErlaubt?: boolean | undefined
}

export function bereiteSignaturVor(wahl: SignaturWahl, ctx: SignaturKontext): VorbereiteteSignatur | { fehler: string } {
  if (wahl.art === 'software') return { kassenFelder: { seeTyp: 'software' } }

  if (wahl.art === 'atrust_chip') {
    const transport = ctx.kartenTransport
    if (!transport) return { fehler: KEINE_BRUECKE }
    // Erst die Prüfung legt fest, welche Karte die richtige ist — ab dann signiert die Einheit nur mit ihr
    let geprueft: { zertifikatDer: Buffer; info: ZertifikatInfo } | null = null
    const nachPruefung = () => {
      if (!geprueft) throw new KartenError('Die Signaturkarte wurde noch nicht geprüft', 'karte_fehler')
      return geprueft
    }
    const einheit: SignaturEinheit = {
      typ:         'atrust_chip',
      zdaId:       () => Promise.resolve('AT1'),
      zertifikat:  () => Promise.resolve(nachPruefung().info),
      signiereBelegzeile: (code) => new SignaturkartenEinheit({
        transport, pin: wahl.kartePin, erwartetesZertifikat: nachPruefung().zertifikatDer,
      }).signiereBelegzeile(code),
    }
    return {
      einheit,
      pruefen: async () => {
        const k = await pruefeSignaturkarte(transport, { uid: ctx.uid, pin: wahl.kartePin, probeKennung: ctx.kassenId })
        if (!k.ok) throw new Error(k.fehler)
        geprueft = { zertifikatDer: k.zertifikatDer, info: { derBase64: k.zertifikatDer.toString('base64'), seriennummerHex: k.seriennummer } }
        return `Signaturkarte ${k.karte} geprüft, PIN bestätigt${k.hinweis ? ` (${k.hinweis})` : ''}`
      },
      kassenFelder: {
        seeTyp:           'atrust_chip',
        kartePinEnc:      encryptPrivateKey(Buffer.from(wahl.kartePin, 'utf8'), ctx.masterPassphrase),
        kartePinGesperrt: false,
        kartePinHinweis:  null,
      },
    }
  }

  // A-Trust online: Zugangsdaten gehen nur an die A-Trust-Server
  if (!istErlaubteAtrustBasisUrl(wahl.atrustBasisUrl, { lokalErlaubt: ctx.lokaleAtrustUrlErlaubt === true })) {
    return { fehler: 'Die Basis-URL muss ein A-Trust-Server sein (https://hs.a-trust.at oder https://hs-abnahme.a-trust.at).' }
  }
  const einheit = new ATrustHsmEinheit({ basisUrl: wahl.atrustBasisUrl, benutzer: wahl.atrustBenutzer, passwort: wahl.atrustPasswort })
  return {
    einheit,
    pruefen: async () => {
      try {
        const zda = await einheit.zdaId()
        await einheit.zertifikat()
        return `A-Trust online erreichbar (ZDA ${zda})`
      } catch (err) {
        throw new Error(`A-Trust online: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    kassenFelder: {
      seeTyp:            'atrust_hsm',
      atrustBasisUrl:    wahl.atrustBasisUrl,
      atrustBenutzer:    wahl.atrustBenutzer,
      atrustPasswortEnc: encryptPrivateKey(Buffer.from(wahl.atrustPasswort, 'utf8'), ctx.masterPassphrase),
    },
  }
}
