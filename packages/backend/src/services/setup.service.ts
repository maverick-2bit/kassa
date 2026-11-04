/**
 * Setup-Service: Verbindet die RKSV-Einrichtungs-Orchestrierung mit der Datenbank.
 *
 * Ablauf:
 *   1. kasseAutomatischEinrichten() aufrufen (führt SEE-Gen + FO-Registrierung + Startbeleg durch)
 *   2. Bei Erfolg: Mandant + Kasse + Startbeleg in einer Transaktion in die DB schreiben
 *   3. SEE-Private-Key wird vor dem Speichern mit Master-Key verschlüsselt
 */

import { eq, and, sql } from 'drizzle-orm'
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

/**
 * Womit der Aufrufer einrichten darf (entscheidet die Route, setzt der Service durch):
 *  - 'offen'      : niemand hat sich ausgewiesen — erlaubt NUR, solange es noch keinen Benutzer gibt
 *  - 'betreiber'  : als Betreiber angemeldet — weiterer Mandant
 *  - 'schluessel' : Einrichtungs-Schlüssel (SETUP_TOKEN) — weiterer Mandant
 */
export type SetupErlaubnis = 'offen' | 'betreiber' | 'schluessel'

/** Die Installation hat inzwischen Benutzer, der Aufrufer war aber nur für die leere Installation berechtigt. */
export class SetupGesperrtError extends Error {
  constructor() { super('Diese Kassa ist bereits eingerichtet') }
}

/** Advisory-Lock-Schlüssel: Einrichtungen laufen nacheinander (siehe Transaktion in fuehreSetupDurch). */
const SETUP_SPERRE = 'kassa:setup'

export async function fuehreSetupDurch(
  input: SetupInput,
  deps:  SetupServiceDeps,
  onSchritt?: (s: EinrichtungsSchrittDto) => void,
  /** Standard ist die schwächste Erlaubnis: ein Aufrufer, der nichts angibt, richtet nur eine leere Installation ein */
  erlaubnis: SetupErlaubnis = 'offen',
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

  // E-Mail: eine Adresse darf in mehreren Betrieben vorkommen (eindeutig ist sie nur je Mandant) — der neue Mandant
  // ist leer, also gibt es hier keinen Konflikt. Die Anmeldung unterscheidet die Betriebe am Passwort bzw. per Auswahl.

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
    // 0. Eine Einrichtung nach der anderen — und "gibt es schon Benutzer?" erst HIER prüfen, in
    //    derselben Transaktion wie das Anlegen. Die Prüfung der Route kam vor der langen
    //    RKSV-Einrichtung: zwei gleichzeitige Erst-Einrichtungen hätten beide bestanden, und die
    //    zweite hätte einen weiteren Mandanten samt Admin an der Sperre vorbei angelegt.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_SPERRE}))`)
    const [vorhandener] = await tx.select({ id: users.id }).from(users).limit(1)
    if (erlaubnis === 'offen' && vorhandener) throw new SetupGesperrtError()
    // Der erste Benutzer der Installation ist ihr Betreiber; weitere Mandanten bekommen normale Admins
    const ersteEinrichtung = vorhandener === undefined

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
      istBetreiber:   ersteEinrichtung,
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
    betragErmaessigt3Cent:       b.betraege.ermaessigt3,
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
