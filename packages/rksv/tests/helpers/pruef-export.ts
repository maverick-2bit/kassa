/**
 * Hilfen für die externen Prüfer: Belege der Kassa als DEP7 plus cryptographicMaterialContainer.json
 * (Format des BMF-Prüftools) schreiben, BMF-Referenzdaten laden.
 *
 * Eine fast gleiche Fassung gibt es für den Burn-in in packages/backend/tests/helpers/rksvPruefExport.ts
 * (das Backend importiert keine Testhilfen aus rksv — absichtlich dupliziert, damit beide Pakete getrennt bleiben).
 */

import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSEE } from '../../src/see.js'
import { Umsatzzaehler, signiereBeleg, type SignierungsKontext } from '../../src/beleg.js'
import { erstelleDEP7Export } from '../../src/dep.js'
import type { BelegTyp, DEP7Export, RawBeleg, SEEConfig, SignedBeleg } from '../../src/types.js'

export const TESTS_ORDNER = join(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_WURZEL  = join(TESTS_ORDNER, '..', '..', '..')

// ---------------------------------------------------------------------------
// cryptographicMaterialContainer.json
// ---------------------------------------------------------------------------

export interface CryptoContainer {
  base64AESKey: string
  certificateOrPublicKeyMap: Record<string, {
    id: string
    signatureDeviceType: 'CERTIFICATE' | 'PUBLIC_KEY'
    signatureCertificateOrPublicKey: string
  }>
}

/**
 * Container für das BMF-Prüftool. Der Schlüssel ist die Seriennummer, wie sie im Beleg steht
 * (Feld „Zertifikat-Seriennummer"); als Wert das Zertifikat (Base64 DER) oder nur der öffentliche Schlüssel (SPKI).
 */
export function baueContainer(see: Pick<SEEConfig, 'aesSchluessel' | 'zertifikatDER'>, art: 'CERTIFICATE' | 'PUBLIC_KEY' = 'CERTIFICATE'): CryptoContainer {
  const zert = new X509Certificate(see.zertifikatDER)
  const id   = zert.serialNumber
  const wert = art === 'CERTIFICATE'
    ? see.zertifikatDER.toString('base64')
    : (zert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
  return {
    base64AESKey: see.aesSchluessel.toString('base64'),
    certificateOrPublicKeyMap: { [id]: { id, signatureDeviceType: art, signatureCertificateOrPublicKey: wert } },
  }
}

// ---------------------------------------------------------------------------
// Eigene Belege mit allen Fällen, die im Betrieb vorkommen
// ---------------------------------------------------------------------------

export interface EigenerExport {
  see:       SEEConfig
  belege:    SignedBeleg[]
  dep7:      DEP7Export
  container: CryptoContainer
}

/**
 * Signiert `anzahl` Belege mit der echten Signierlogik der Kassa: Startbeleg, Barumsätze mit allen Steuersätzen
 * (auch krumme Cent), Stornos (negative Beträge), Nullbelege, Belege im SEE-Ausfall.
 */
export async function baueEigenenExport(anzahl: number, kassenId = 'PRUEF-KASSE-1', zdaId = 'AT0'): Promise<EigenerExport> {
  const see = await generateSEE({ kassenId, uid: 'ATU12345678', firmenname: 'Prüfstrecke GmbH' })
  // Die Software-SEE trägt AT0 („geschlossenes Gesamtsystem"). Mit einer anderen Kennung (z. B. AT100 wie im offenen BMF-Beispiel)
  // wird derselbe Export als offenes System gelesen — so prüft das BMF-Prüftool auch Verkettung, Zähler und Signaturen,
  // statt schon am Format der Seriennummer für AT0 zu scheitern.
  see.zdaId = zdaId
  // Fester Ausgangspunkt mitten im Sommer (keine Zeitumstellung in den folgenden Minuten, egal in welcher Zeitzone der
  // Test läuft) — erstelleStartbeleg() würde „jetzt" nehmen und könnte in der Umstellungsstunde eine rückläufige Uhrzeit erzeugen.
  const kontext: SignierungsKontext = { see, umsatzzaehler: new Umsatzzaehler(0n) }
  const start = await signiereBeleg(
    { kassenId, belegNummer: 1, datumUhrzeit: new Date(Date.UTC(2026, 5, 15, 8, 0, 0)), belegTyp: 'Startbeleg', positionen: [] }, kontext)
  kontext.letzterBelegCode = start.maschinenlesbareCode
  const belege: SignedBeleg[] = [start]

  const muster: { typ: BelegTyp; ausfall?: boolean; positionen: RawBeleg['positionen'] }[] = [
    { typ: 'Barzahlungsbeleg', positionen: [{ bezeichnung: 'Kaffee', menge: 2, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }, { bezeichnung: 'Cola', menge: 1, einzelpreisBreutto: 395, mwstSatz: 'normal' }] },
    { typ: 'Barzahlungsbeleg', positionen: [{ bezeichnung: 'Zeitung', menge: 1, einzelpreisBreutto: 260, mwstSatz: 'ermaessigt2' }, { bezeichnung: 'Pfand', menge: 3, einzelpreisBreutto: 1, mwstSatz: 'null' }] },
    { typ: 'Stornobeleg',      positionen: [{ bezeichnung: 'Kaffee', menge: 2, einzelpreisBreutto: -350, mwstSatz: 'ermaessigt1' }] },
    { typ: 'Nullbeleg',        positionen: [] },
    { typ: 'Barzahlungsbeleg', ausfall: true, positionen: [{ bezeichnung: 'Schnitzel', menge: 1, einzelpreisBreutto: 1690, mwstSatz: 'ermaessigt1' }] },
    { typ: 'Barzahlungsbeleg', ausfall: true, positionen: [{ bezeichnung: 'Krummer Preis', menge: 3.333, einzelpreisBreutto: 999, mwstSatz: 'besonders' }] },
    // Nach dem Ausfall folgt der Sammelbeleg = signierter Nullbeleg (RKSV; das BMF-Prüftool verlangt ihn als ersten oder zweiten Beleg danach)
    { typ: 'Nullbeleg',        positionen: [] },
    { typ: 'Barzahlungsbeleg', positionen: [{ bezeichnung: 'Teurer Posten', menge: 1, einzelpreisBreutto: 123456, mwstSatz: 'normal' }] },
  ]
  let tag = start.datumUhrzeit.getTime()           // jede Minute ein Beleg, beginnend beim Startbeleg
  for (let i = 2; belege.length < anzahl; i++) {
    const m = muster[(i - 2) % muster.length]!
    tag += 60_000
    const beleg = await signiereBeleg(
      { kassenId, belegNummer: i, datumUhrzeit: new Date(tag), belegTyp: m.typ, positionen: m.positionen },
      kontext,
      m.ausfall ? { ausfallModus: true } : {},
    )
    kontext.letzterBelegCode = beleg.maschinenlesbareCode
    belege.push(beleg)
  }
  return { see, belege, dep7: erstelleDEP7Export(belege, see), container: baueContainer(see) }
}

// ---------------------------------------------------------------------------
// BMF-Referenzdaten
// ---------------------------------------------------------------------------

export interface BmfSzenario {
  name:      string
  dep7:      DEP7Export
  container: CryptoContainer
  /** QR-Codes (Signatur in Standard-Base64), gleiche Reihenfolge wie die JWS im DEP */
  qr:        string[]
  jws:       string[]
}

export function ladeBmfSzenario(name: 'closed-system-1' | 'open-system-1'): BmfSzenario {
  const ordner = join(TESTS_ORDNER, 'fixtures', 'bmf-mustercode', name)
  const lies = (datei: string): unknown => JSON.parse(readFileSync(join(ordner, datei), 'utf8'))
  const dep7 = lies('dep-export.json') as DEP7Export
  return {
    name,
    dep7,
    container: lies('cryptographicMaterialContainer.json') as CryptoContainer,
    qr:        lies('qr-code-rep.json') as string[],
    jws:       dep7['Belege-Gruppe'].flatMap(g => g['Belege-kompakt']),
  }
}

/** Felder eines QR-Codes (14 Teile: leer, Suite, Kassen-ID, Belegnummer, Datum, 5 Beträge, Zähler, Seriennummer, Vorbeleg, Signatur) */
export function zerlegeQr(code: string) {
  const t = code.split('_')
  if (t.length !== 14) throw new Error(`QR-Code mit ${t.length} statt 14 Teilen: ${code.slice(0, 60)}`)
  return {
    suite: t[1]!, kassenId: t[2]!, belegNummer: t[3]!, datum: t[4]!,
    betraege: t.slice(5, 10), zaehler: t[10]!, seriennummer: t[11]!, vorbeleg: t[12]!, signatur: t[13]!,
  }
}
