/**
 * Setup-Service: Verbindet die RKSV-Einrichtungs-Orchestrierung mit der Datenbank.
 *
 * Ablauf:
 *   1. kasseAutomatischEinrichten() aufrufen (führt SEE-Gen + FO-Registrierung + Startbeleg durch)
 *   2. Bei Erfolg: Mandant + Kasse + Startbeleg in einer Transaktion in die DB schreiben
 *   3. SEE-Private-Key wird vor dem Speichern mit Master-Key verschlüsselt
 */

import { eq, and } from 'drizzle-orm'
import {
  kasseAutomatischEinrichten,
  type KasseEinrichtenOptionen,
  type SignedBeleg,
} from '@kassa/rksv'
import type { SetupInput, SetupResponse, EinrichtungsSchrittDto } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { mandanten, kassen, belege, users } from '../db/schema.js'
import { encryptPrivateKey } from '../crypto/master-key.js'
import { hashPassword } from './auth.service.js'
import { X509Certificate } from 'node:crypto'

export interface SetupServiceDeps {
  db:               Db
  masterPassphrase: string
  /** Für Tests: vorkonfigurierter Mock-Client */
  rksvOptionen?: Pick<KasseEinrichtenOptionen, 'finanzOnlineClient'>
}

export async function fuehreSetupDurch(
  input: SetupInput,
  deps:  SetupServiceDeps,
  onSchritt?: (s: EinrichtungsSchrittDto) => void,
): Promise<SetupResponse> {

  // Prüfen ob UID bereits aktiv registriert ist
  const existing = await deps.db
    .select({ id: mandanten.id })
    .from(mandanten)
    .where(and(eq(mandanten.uid, input.uid), eq(mandanten.status, 'aktiv')))
    .limit(1)

  if (existing.length > 0) {
    return {
      erfolgreich: false,
      schritte: [{
        schritt:     'eingabe-validierung',
        status:      'fehler',
        meldung:     `Mandant mit UID ${input.uid} ist bereits aktiv registriert`,
        zeitstempel: new Date().toISOString(),
      }],
      fehler: `Mandant mit UID ${input.uid} ist bereits aktiv registriert`,
    }
  }

  // E-Mail-Konflikt prüfen
  const emailExisting = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.admin.email.toLowerCase()))
    .limit(1)
  if (emailExisting.length > 0) {
    return {
      erfolgreich: false,
      schritte: [{
        schritt:     'eingabe-validierung',
        status:      'fehler',
        meldung:     `E-Mail ${input.admin.email} ist bereits vergeben`,
        zeitstempel: new Date().toISOString(),
      }],
      fehler: `E-Mail ${input.admin.email} ist bereits vergeben`,
    }
  }

  // RKSV-Einrichtung durchführen
  const rksvInput = {
    firmenname:   input.firmenname,
    uid:          input.uid,
    kassenId:     input.kassenId,
    ...(input.finanzOnline && { finanzOnline: input.finanzOnline }),
    umgebung:     input.umgebung,
    ...(input.zertifikatGueltigkeitTage !== undefined && {
      zertifikatGueltigkeitTage: input.zertifikatGueltigkeitTage,
    }),
  }
  const ergebnis = await kasseAutomatischEinrichten(rksvInput, {
    ...deps.rksvOptionen,
    onSchritt: (s) => onSchritt?.({
      schritt:     s.schritt,
      status:      s.status,
      meldung:     s.meldung,
      zeitstempel: s.zeitstempel.toISOString(),
    }),
  })

  // Schritte als DTO konvertieren (Date → ISO-String)
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

  // In DB persistieren — alles in einer Transaktion
  const { see, startbeleg } = ergebnis
  const cert         = new X509Certificate(see.zertifikatDER)
  const encryptedKey = encryptPrivateKey(see.privateKeyDER, deps.masterPassphrase)
  const passwordHash = await hashPassword(input.admin.passwort)

  const result = await deps.db.transaction(async (tx) => {
    // 1. Mandant
    const [mandant] = await tx.insert(mandanten).values({
      firmenname:          input.firmenname,
      uid:                 input.uid,
      modulGastroAktiv:         input.module?.gastro         ?? true,
      modulAngeboteAktiv:       input.module?.angebote       ?? false,
      modulMergeportAktiv:      input.module?.mergeport      ?? false,
      modulReservierungenAktiv: input.module?.reservierungen ?? false,
      modulZeiterfassungAktiv:  input.module?.zeiterfassung  ?? false,
      modulSbTerminalAktiv:     input.module?.sbTerminal     ?? false,
    }).returning({ id: mandanten.id })

    if (!mandant) throw new Error('Mandant konnte nicht angelegt werden')

    // 2. Kasse
    const [kasse] = await tx.insert(kassen).values({
      mandantId:           mandant.id,
      kassenId:            input.kassenId,
      umgebung:            input.umgebung,
      seeZertifikatDer:    see.zertifikatDER.toString('base64'),
      seePrivateKeyEnc:    encryptedKey,
      seeZertifikatSn:     cert.serialNumber,
      seeGueltigBis:       new Date(cert.validTo),
      aesSchluesselEnc:    encryptPrivateKey(see.aesSchluessel, deps.masterPassphrase),
      umsatzzaehlerCent:   0n,
      letzteBelegNummer:   startbeleg.belegNummer,
      letzterBelegCode:    startbeleg.maschinenlesbareCode,
      bei_fo_registriert:  ergebnis.fonRegistriert,
      ...(ergebnis.pruefwert && { fo_pruefwert: ergebnis.pruefwert }),
      ...(ergebnis.fonRegistriert && { registriert_am: new Date() }),
    }).returning({ id: kassen.id })

    if (!kasse) throw new Error('Kasse konnte nicht angelegt werden')

    // 3. Admin-User
    await tx.insert(users).values({
      mandantId:      mandant.id,
      email:          input.admin.email.toLowerCase(),
      passwordHash,
      name:           input.admin.name,
      rolle:          'admin',
      berechtigungen: [],
      aktiv:          true,
    })

    // 4. Startbeleg
    await tx.insert(belege).values(belegToInsert(mandant.id, kasse.id, startbeleg))

    return { mandantId: mandant.id, kasseId: kasse.id }
  })

  return {
    erfolgreich:                     true,
    mandantId:                       result.mandantId,
    kasseId:                         result.kasseId,
    startbelegNummer:                startbeleg.belegNummer,
    startbelegMaschinenlesbareCode:  startbeleg.maschinenlesbareCode,
    ...(ergebnis.pruefwert && { pruefwert: ergebnis.pruefwert }),
    schritte:                        schritteDto,
  }
}

// ---------------------------------------------------------------------------
// Helper: SignedBeleg → DB-INSERT
// ---------------------------------------------------------------------------

export function belegToInsert(mandantId: string, kasseId: string, b: SignedBeleg) {
  return {
    mandantId,
    kasseId,
    belegNummer:                 b.belegNummer,
    belegDatum:                  b.datumUhrzeit,
    belegTyp:                    b.belegTyp,
    betragNormalCent:            b.betraege.normal,
    betragErmaessigt1Cent:       b.betraege.ermaessigt1,
    betragErmaessigt2Cent:       b.betraege.ermaessigt2,
    betragNullCent:              b.betraege.null,
    betragBesondersCent:         b.betraege.besonders,
    umsatzzaehlerVerschluesselt: b.umsatzzaehlerVerschluesselt,
    zertifikatSn:                b.zertifikatSN,
    sigVorbeleg:                 b.sigVorbeleg,
    signaturwert:                b.signaturwert,
    maschinenlesbareCode:        b.maschinenlesbareCode,
    positionen:                  b.positionen,
  }
}
