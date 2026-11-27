/**
 * Kassen-Service: Legt *weitere* Registrierkassen für einen bereits
 * eingerichteten Mandanten an.
 *
 * Anders als `fuehreSetupDurch` (Onboarding: Mandant + Kasse + Admin) erzeugt
 * dies nur eine zusätzliche Kasse: eigene SEE-Einheit (Zertifikat + privater
 * Schlüssel) samt eigenem Startbeleg, unter dem bestehenden Mandanten. Firmenname
 * und UID kommen vom Mandanten; es wird kein neuer Admin/keine Module angelegt.
 */

import { and, asc, eq } from 'drizzle-orm'
import { X509Certificate } from 'node:crypto'
import {
  kasseAutomatischEinrichten,
  type ApduTransport,
  type KasseEinrichtenOptionen,
} from '@kassa/rksv'
import type {
  SignaturWahl,
  WeitereKasseInput,
  WeitereKasseResponse,
  EinrichtungsSchrittDto,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { mandanten, kassen, belege } from '../db/schema.js'
import { decryptPrivateKey, encryptPrivateKey } from '../crypto/master-key.js'
import { belegToInsert } from './setup.service.js'
import { bereiteSignaturVor } from './signatur-einrichtung.service.js'

export interface WeitereKasseServiceDeps {
  db:               Db
  masterPassphrase: string
  /**
   * Für Tests: vorkonfigurierter Mock-Client (FO_STUB); `herstellerId` = Einstellung FON_HERSTELLER_ID
   * (UID des Softwareherstellers) für den Login des echten Clients
   */
  rksvOptionen?: Pick<KasseEinrichtenOptionen, 'finanzOnlineClient' | 'herstellerId'>
  kartenTransport?: ApduTransport
  lokaleAtrustUrlErlaubt?: boolean
}

/**
 * Variante der bestehenden Kassen des Betriebs übernehmen: Signaturkarte → dieselbe Karte mit der gespeicherten
 * PIN; A-Trust online → derselbe Zugang; sonst Software (Test/Demo). Maßgeblich ist die älteste aktive Kasse.
 */
async function signaturWieBestehende(db: Db, mandantId: string, masterPassphrase: string): Promise<SignaturWahl> {
  const [k] = await db.select().from(kassen)
    .where(and(eq(kassen.mandantId, mandantId), eq(kassen.status, 'aktiv')))
    .orderBy(asc(kassen.createdAt)).limit(1)
  if (k?.seeTyp === 'atrust_chip' && k.kartePinEnc && !k.kartePinGesperrt) {
    return { art: 'atrust_chip', kartePin: decryptPrivateKey(k.kartePinEnc, masterPassphrase).toString('utf8') }
  }
  if (k?.seeTyp === 'atrust_hsm' && k.atrustBasisUrl && k.atrustBenutzer && k.atrustPasswortEnc) {
    return {
      art: 'atrust_hsm', atrustBasisUrl: k.atrustBasisUrl, atrustBenutzer: k.atrustBenutzer,
      atrustPasswort: decryptPrivateKey(k.atrustPasswortEnc, masterPassphrase).toString('utf8'),
    }
  }
  return { art: 'software' }
}

export async function legeWeitereKasseAn(
  mandantId: string,
  input:     WeitereKasseInput,
  deps:      WeitereKasseServiceDeps,
  onSchritt?: (s: EinrichtungsSchrittDto) => void,
): Promise<WeitereKasseResponse> {

  // 1. Mandant laden (Firmenname + UID für die SEE-Einrichtung)
  const [mandant] = await deps.db
    .select({ id: mandanten.id, firmenname: mandanten.firmenname, uid: mandanten.uid })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)

  if (!mandant) {
    return {
      erfolgreich: false,
      schritte: [{
        schritt:     'eingabe-validierung',
        status:      'fehler',
        meldung:     'Mandant nicht gefunden',
        zeitstempel: new Date().toISOString(),
      }],
      fehler: 'Mandant nicht gefunden',
    }
  }

  // 2. Duplikat-Check: kassenId muss innerhalb des Mandanten eindeutig sein
  const [dup] = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(and(eq(kassen.mandantId, mandantId), eq(kassen.kassenId, input.kassenId)))
    .limit(1)

  if (dup) {
    const meldung = `Kassen-ID „${input.kassenId}" ist für diesen Mandanten bereits vergeben`
    return {
      erfolgreich: false,
      schritte: [{
        schritt:     'eingabe-validierung',
        status:      'fehler',
        meldung,
        zeitstempel: new Date().toISOString(),
      }],
      fehler: meldung,
    }
  }

  // 3. Signatur: angegeben oder wie die bestehenden Kassen — schon der Startbeleg wird damit signiert
  const wahl = input.signatur ?? await signaturWieBestehende(deps.db, mandantId, deps.masterPassphrase)
  const signatur = bereiteSignaturVor(wahl, {
    uid: mandant.uid, kassenId: input.kassenId, masterPassphrase: deps.masterPassphrase,
    kartenTransport: deps.kartenTransport, lokaleAtrustUrlErlaubt: deps.lokaleAtrustUrlErlaubt,
  })
  if ('fehler' in signatur) {
    return {
      erfolgreich: false,
      schritte: [{ schritt: 'see-generierung', status: 'fehler', meldung: signatur.fehler, zeitstempel: new Date().toISOString() }],
      fehler: signatur.fehler,
    }
  }

  // 4. RKSV-Einrichtung (SEE + optional FON + Startbeleg)
  const ergebnis = await kasseAutomatischEinrichten({
    firmenname: mandant.firmenname,
    uid:        mandant.uid,
    kassenId:   input.kassenId,
    umgebung:   input.umgebung,
    ...(input.finanzOnline && { finanzOnline: input.finanzOnline }),
    ...(input.zertifikatGueltigkeitTage !== undefined && {
      zertifikatGueltigkeitTage: input.zertifikatGueltigkeitTage,
    }),
  }, {
    ...deps.rksvOptionen,
    ...(signatur.einheit && { signaturEinheit: signatur.einheit }),
    ...(signatur.pruefen && { signaturEinheitPruefen: signatur.pruefen }),
    onSchritt: (s) => onSchritt?.({
      schritt:     s.schritt,
      status:      s.status,
      meldung:     s.meldung,
      zeitstempel: s.zeitstempel.toISOString(),
    }),
  })

  const schritteDto: EinrichtungsSchrittDto[] = ergebnis.schritte.map(s => ({
    schritt:     s.schritt,
    status:      s.status,
    meldung:     s.meldung,
    zeitstempel: s.zeitstempel.toISOString(),
  }))

  if (!ergebnis.erfolgreich || !ergebnis.see || !ergebnis.startbeleg) {
    return {
      erfolgreich: false,
      schritte:    schritteDto,
      ...(ergebnis.fehler && { fehler: ergebnis.fehler }),
    }
  }

  // 4. Kasse + Startbeleg persistieren (eine Transaktion)
  const { see, startbeleg } = ergebnis
  const cert         = new X509Certificate(see.zertifikatDER)
  const encryptedKey = encryptPrivateKey(see.privateKeyDER, deps.masterPassphrase)

  const kasseId = await deps.db.transaction(async (tx) => {
    const [kasse] = await tx.insert(kassen).values({
      mandantId,
      kassenId:            input.kassenId,
      ...(input.bezeichnung && { bezeichnung: input.bezeichnung }),
      umgebung:            input.umgebung,
      seeZertifikatDer:    see.zertifikatDER.toString('base64'),
      seePrivateKeyEnc:    encryptedKey,
      seeZertifikatSn:     cert.serialNumber,
      seeGueltigBis:       new Date(cert.validTo),
      seeZdaId:            see.zdaId,
      ...signatur.kassenFelder,
      aesSchluesselEnc:    encryptPrivateKey(see.aesSchluessel, deps.masterPassphrase),
      umsatzzaehlerCent:   0n,
      letzteBelegNummer:   startbeleg.belegNummer,
      letzterBelegCode:    startbeleg.maschinenlesbareCode,
      bei_fo_registriert:  ergebnis.fonRegistriert,
      ...(ergebnis.pruefwert && { fo_pruefwert: ergebnis.pruefwert }),
      ...(ergebnis.fonRegistriert && { registriert_am: new Date() }),
    }).returning({ id: kassen.id })

    if (!kasse) throw new Error('Kasse konnte nicht angelegt werden')

    await tx.insert(belege).values(belegToInsert(mandantId, kasse.id, startbeleg))
    return kasse.id
  })

  return {
    erfolgreich:      true,
    kasseId,
    startbelegNummer: startbeleg.belegNummer,
    schritte:         schritteDto,
  }
}
