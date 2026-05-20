/**
 * Beleg-Service: RKSV-konforme Erstellung von Barzahlungsbelegen.
 *
 * Kernablauf (transaktional, mit Row-Lock auf der Kasse):
 *   1. Kasse FOR UPDATE selektieren (verhindert race conditions bei BelegNummer)
 *   2. Artikel laden und Preise/MwSt aus Stammdaten übernehmen (server-authoritativ)
 *   3. SEE-Privatschlüssel mit Master-Passphrase entschlüsseln
 *   4. SignierungsKontext aus letztem DB-Zustand wiederherstellen
 *   5. Beleg signieren (RKSV: AES-ICM + SHA-256 + ECDSA)
 *   6. Beleg in DB einfügen, Kasse aktualisieren (Umsatzzähler, letzter Sigwert, letzte Nr.)
 */

import { and, desc, eq, inArray } from 'drizzle-orm'
import { Buffer } from 'node:buffer'
import {
  Umsatzzaehler,
  signiereBeleg,
  gesamtBetragCent,
  type BelegPosition,
  type MwStSatz,
  type RawBeleg,
  type SEEConfig,
  type SignierungsKontext,
} from '@kassa/rksv'
import type { BarzahlungsbelegInput, BelegResponse } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, belege, kassen } from '../db/schema.js'
import { decryptPrivateKey } from '../crypto/master-key.js'

export interface BelegServiceDeps {
  db:               Db
  masterPassphrase: string
}

export class BelegError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Barzahlungsbeleg erstellen
// ---------------------------------------------------------------------------

export async function erstelleBarzahlungsbeleg(
  input: BarzahlungsbelegInput,
  deps:  BelegServiceDeps,
): Promise<BelegResponse> {
  return deps.db.transaction(async (tx) => {
    // 1. Kasse laden + sperren
    const kasseRows = await tx
      .select()
      .from(kassen)
      .where(eq(kassen.id, input.kasseId))
      .for('update')

    const kasse = kasseRows[0]
    if (!kasse)                        throw new BelegError(404, 'Kasse nicht gefunden')
    if (kasse.status !== 'aktiv')      throw new BelegError(409, `Kasse ist ${kasse.status}, keine neuen Belege möglich`)
    if (!kasse.bei_fo_registriert)     throw new BelegError(409, 'Kasse ist nicht bei FinanzOnline registriert')

    // 2. Artikel laden (server-authoritative Preise)
    const artikelIds = [...new Set(input.positionen.map(p => p.artikelId))]
    const artikelRows = await tx
      .select()
      .from(artikel)
      .where(and(
        inArray(artikel.id, artikelIds),
        eq(artikel.mandantId, kasse.mandantId),
        eq(artikel.aktiv, true),
      ))

    if (artikelRows.length !== artikelIds.length) {
      throw new BelegError(404, 'Mindestens ein Artikel ist nicht (mehr) verfügbar')
    }
    const artikelById = new Map(artikelRows.map(a => [a.id, a]))

    const belegPositionen: BelegPosition[] = input.positionen.map((p) => {
      const a = artikelById.get(p.artikelId)
      if (!a) throw new BelegError(404, `Artikel ${p.artikelId} nicht gefunden`)
      return {
        bezeichnung:        a.bezeichnung,
        menge:              p.menge,
        einzelpreisBreutto: a.preisBruttoCent,
        mwstSatz:           a.mwstSatz as MwStSatz,
      }
    })

    // 3. SEE wiederherstellen
    const privateKeyDER = decryptPrivateKey(kasse.seePrivateKeyEnc, deps.masterPassphrase)
    const see: SEEConfig = {
      kassenId:      kasse.kassenId,
      zertifikatDER: Buffer.from(kasse.seeZertifikatDer, 'base64'),
      privateKeyDER,
    }

    // 4. Signierungs-Kontext
    const umsatzzaehler = new Umsatzzaehler(kasse.umsatzzaehlerCent)
    const kontext: SignierungsKontext = {
      see,
      umsatzzaehler,
      ...(kasse.letzterSignaturwert && { letzterSignaturwert: kasse.letzterSignaturwert }),
    }

    // 5. Rohbeleg + Signierung
    const raw: RawBeleg = {
      kassenId:     kasse.kassenId,
      belegNummer:  kasse.letzteBelegNummer + 1,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen:   belegPositionen,
    }
    const signed = signiereBeleg(raw, kontext)

    // 6. Zahlungssumme prüfen — muss exakt dem Belegtotal entsprechen
    const total       = gesamtBetragCent(signed.betraege)
    const zahlungSumme = BigInt(input.zahlung.barCent + input.zahlung.karteCent + input.zahlung.sonstigeCent)
    if (total !== zahlungSumme) {
      throw new BelegError(
        400,
        `Zahlungssumme passt nicht zum Beleg: Beleg=${total} Cent, Zahlung=${zahlungSumme} Cent`,
      )
    }

    // 7. Persistieren
    const [inserted] = await tx.insert(belege).values({
      mandantId:                   kasse.mandantId,
      kasseId:                     kasse.id,
      belegNummer:                 signed.belegNummer,
      belegDatum:                  signed.datumUhrzeit,
      belegTyp:                    signed.belegTyp,
      betragNormalCent:            signed.betraege.normal,
      betragErmaessigt1Cent:       signed.betraege.ermaessigt1,
      betragErmaessigt2Cent:       signed.betraege.ermaessigt2,
      betragNullCent:              signed.betraege.null,
      betragBesondersCent:         signed.betraege.besonders,
      summeBarCent:                input.zahlung.barCent,
      summeKarteCent:              input.zahlung.karteCent,
      summeSonstigeCent:           input.zahlung.sonstigeCent,
      umsatzzaehlerVerschluesselt: signed.umsatzzaehlerVerschluesselt,
      zertifikatSn:                signed.zertifikatSN,
      sigVorbeleg:                 signed.sigVorbeleg,
      signaturwert:                signed.signaturwert,
      maschinenlesbareCode:        signed.maschinenlesbareCode,
      positionen:                  belegPositionen,
    }).returning()
    if (!inserted) throw new BelegError(500, 'Beleg konnte nicht gespeichert werden')

    // 8. Kasse aktualisieren
    await tx.update(kassen)
      .set({
        umsatzzaehlerCent:   umsatzzaehler.aktuell,
        letzteBelegNummer:   signed.belegNummer,
        letzterSignaturwert: signed.signaturwert,
        updatedAt:           new Date(),
      })
      .where(eq(kassen.id, kasse.id))

    return toDto(inserted, belegPositionen)
  })
}

// ---------------------------------------------------------------------------
// Belege auflisten
// ---------------------------------------------------------------------------

export async function listeBelege(
  db: Db,
  kasseId: string,
  opts: { limit?: number } = {},
): Promise<BelegResponse[]> {
  const rows = await db
    .select()
    .from(belege)
    .where(eq(belege.kasseId, kasseId))
    .orderBy(desc(belege.belegNummer))
    .limit(opts.limit ?? 50)

  return rows.map(r => toDto(r, r.positionen as BelegPosition[]))
}

// ---------------------------------------------------------------------------
// DB-Row → DTO
// ---------------------------------------------------------------------------

function toDto(row: typeof belege.$inferSelect, positionen: BelegPosition[]): BelegResponse {
  const betraege = {
    normal:      row.betragNormalCent,
    ermaessigt1: row.betragErmaessigt1Cent,
    ermaessigt2: row.betragErmaessigt2Cent,
    null:        row.betragNullCent,
    besonders:   row.betragBesondersCent,
  }
  const gesamtbetragCent =
    betraege.normal + betraege.ermaessigt1 + betraege.ermaessigt2 + betraege.null + betraege.besonders

  return {
    id:                          row.id,
    belegNummer:                 row.belegNummer,
    belegDatum:                  row.belegDatum.toISOString(),
    belegTyp:                    row.belegTyp,
    betraege,
    summeBarCent:                row.summeBarCent,
    summeKarteCent:              row.summeKarteCent,
    summeSonstigeCent:           row.summeSonstigeCent,
    gesamtbetragCent,
    positionen,
    zertifikatSn:                row.zertifikatSn,
    sigVorbeleg:                 row.sigVorbeleg,
    signaturwert:                row.signaturwert,
    umsatzzaehlerVerschluesselt: row.umsatzzaehlerVerschluesselt,
    maschinenlesbareCode:        row.maschinenlesbareCode,
    createdAt:                   row.createdAt.toISOString(),
  }
}
