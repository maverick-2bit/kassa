/**
 * Beleg-Service: RKSV-konforme Erstellung aller Belegtypen.
 *
 * Architektur:
 *   - `signiereImTx()` ist der gemeinsame Inner-Loop:
 *     Kasse FOR UPDATE → SEE entschlüsseln → signieren → persistieren → Kasse updaten
 *   - Pro Belegtyp gibt es eine Public-API-Funktion, die die Positionen aufbaut
 *     und dann signiereImTx() innerhalb einer Transaktion aufruft.
 */

import { and, desc, eq, inArray } from 'drizzle-orm'
import { Buffer } from 'node:buffer'
import {
  Umsatzzaehler,
  signiereBeleg,
  gesamtBetragCent,
  type BelegPosition,
  type BelegTyp,
  type MwStSatz,
  type RawBeleg,
  type SEEConfig,
  type SignedBeleg,
  type SignierungsKontext,
} from '@kassa/rksv'
import type {
  BarzahlungsbelegInput,
  BelegResponse,
  JahresbelegInput,
  MonatsbelegInput,
  NullbelegInput,
  StornobelegInput,
} from '@kassa/shared'
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

interface ZahlungAufteilung {
  barCent:      number
  karteCent:    number
  sonstigeCent: number
}

const NULL_ZAHLUNG: ZahlungAufteilung = { barCent: 0, karteCent: 0, sonstigeCent: 0 }

// ---------------------------------------------------------------------------
// Gemeinsamer Inner-Loop: Signierung + Persistierung in einer Transaktion
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

interface BelegDaten {
  positionen: BelegPosition[]
  zahlung:    ZahlungAufteilung
}

interface SigniereInput {
  kasseId:  string
  belegTyp: BelegTyp
  /** Statisch (für Spezialbelege ohne Daten-Lookup) oder Callback (für Storno/Barzahlung) */
  belegDaten: BelegDaten | ((tx: Tx) => Promise<BelegDaten>)
  /** Wenn true: validiert Zahlungssumme == Belegtotal (Pflicht bei Barzahlung & Storno) */
  validatePayment: boolean
}

async function signiereImTx(
  input: SigniereInput,
  deps:  BelegServiceDeps,
): Promise<{ signed: SignedBeleg; persisted: typeof belege.$inferSelect }> {
  return deps.db.transaction(async (tx) => {
    // Kasse FOR UPDATE laden + validieren
    const kasseRows = await tx
      .select()
      .from(kassen)
      .where(eq(kassen.id, input.kasseId))
      .for('update')

    const kasse = kasseRows[0]
    if (!kasse)                    throw new BelegError(404, 'Kasse nicht gefunden')
    if (kasse.status !== 'aktiv')  throw new BelegError(409, `Kasse ist ${kasse.status}, keine neuen Belege möglich`)
    if (!kasse.bei_fo_registriert) throw new BelegError(409, 'Kasse ist nicht bei FinanzOnline registriert')

    // BelegDaten ggf. erst jetzt aufbauen (Artikel- oder Verweis-Lookup)
    const { positionen, zahlung } = typeof input.belegDaten === 'function'
      ? await input.belegDaten(tx)
      : input.belegDaten

    // SEE wiederherstellen
    const privateKeyDER = decryptPrivateKey(kasse.seePrivateKeyEnc, deps.masterPassphrase)
    const see: SEEConfig = {
      kassenId:      kasse.kassenId,
      zertifikatDER: Buffer.from(kasse.seeZertifikatDer, 'base64'),
      privateKeyDER,
    }

    // Signierungs-Kontext aus letztem DB-Zustand
    const umsatzzaehler = new Umsatzzaehler(kasse.umsatzzaehlerCent)
    const kontext: SignierungsKontext = {
      see,
      umsatzzaehler,
      ...(kasse.letzterSignaturwert && { letzterSignaturwert: kasse.letzterSignaturwert }),
    }

    // Signieren
    const raw: RawBeleg = {
      kassenId:     kasse.kassenId,
      belegNummer:  kasse.letzteBelegNummer + 1,
      datumUhrzeit: new Date(),
      belegTyp:     input.belegTyp,
      positionen,
    }
    const signed = signiereBeleg(raw, kontext)

    // Optional: Zahlungssumme prüfen
    if (input.validatePayment) {
      const total = gesamtBetragCent(signed.betraege)
      const zSum  = BigInt(zahlung.barCent + zahlung.karteCent + zahlung.sonstigeCent)
      if (total !== zSum) {
        throw new BelegError(
          400,
          `Zahlungssumme passt nicht zum Beleg: Beleg=${total} Cent, Zahlung=${zSum} Cent`,
        )
      }
    }

    // Persistieren
    const [persisted] = await tx.insert(belege).values({
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
      summeBarCent:                zahlung.barCent,
      summeKarteCent:              zahlung.karteCent,
      summeSonstigeCent:           zahlung.sonstigeCent,
      umsatzzaehlerVerschluesselt: signed.umsatzzaehlerVerschluesselt,
      zertifikatSn:                signed.zertifikatSN,
      sigVorbeleg:                 signed.sigVorbeleg,
      signaturwert:                signed.signaturwert,
      maschinenlesbareCode:        signed.maschinenlesbareCode,
      positionen,
    }).returning()
    if (!persisted) throw new BelegError(500, 'Beleg konnte nicht gespeichert werden')

    // Kasse aktualisieren
    await tx.update(kassen)
      .set({
        umsatzzaehlerCent:   umsatzzaehler.aktuell,
        letzteBelegNummer:   signed.belegNummer,
        letzterSignaturwert: signed.signaturwert,
        updatedAt:           new Date(),
      })
      .where(eq(kassen.id, kasse.id))

    return { signed, persisted }
  })
}

// ---------------------------------------------------------------------------
// Barzahlungsbeleg
// ---------------------------------------------------------------------------

export async function erstelleBarzahlungsbeleg(
  input: BarzahlungsbelegInput,
  deps:  BelegServiceDeps,
): Promise<BelegResponse> {
  const { signed, persisted } = await signiereImTx({
    kasseId:         input.kasseId,
    belegTyp:        'Barzahlungsbeleg',
    validatePayment: true,
    belegDaten: async (tx) => {
      const artikelIds  = [...new Set(input.positionen.map(p => p.artikelId))]
      const artikelRows = await tx
        .select()
        .from(artikel)
        .where(and(inArray(artikel.id, artikelIds), eq(artikel.aktiv, true)))
      if (artikelRows.length !== artikelIds.length) {
        throw new BelegError(404, 'Mindestens ein Artikel ist nicht (mehr) verfügbar')
      }
      const artikelById = new Map(artikelRows.map(a => [a.id, a]))

      const positionen: BelegPosition[] = input.positionen.map((p) => {
        const a = artikelById.get(p.artikelId)
        if (!a) throw new BelegError(404, `Artikel ${p.artikelId} nicht gefunden`)
        return {
          bezeichnung:        a.bezeichnung,
          menge:              p.menge,
          einzelpreisBreutto: a.preisBruttoCent,
          mwstSatz:           a.mwstSatz as MwStSatz,
        }
      })

      return { positionen, zahlung: input.zahlung }
    },
  }, deps)

  return toDto(persisted, signed.positionen)
}

// ---------------------------------------------------------------------------
// Stornobeleg — Komplett-Storno eines Vorgängers
// ---------------------------------------------------------------------------

export async function erstelleStornobeleg(
  input: StornobelegInput,
  deps:  BelegServiceDeps,
): Promise<BelegResponse> {
  const { signed, persisted } = await signiereImTx({
    kasseId:         input.kasseId,
    belegTyp:        'Stornobeleg',
    validatePayment: true,
    belegDaten: async (tx) => {
      const [verweisBeleg] = await tx
        .select()
        .from(belege)
        .where(and(eq(belege.id, input.verweisBelegId), eq(belege.kasseId, input.kasseId)))
        .limit(1)
      if (!verweisBeleg) {
        throw new BelegError(404, 'Zu stornierender Beleg nicht gefunden')
      }
      if (verweisBeleg.belegTyp === 'Stornobeleg') {
        throw new BelegError(400, 'Ein Stornobeleg kann nicht selbst storniert werden')
      }
      if (verweisBeleg.belegTyp !== 'Barzahlungsbeleg') {
        throw new BelegError(400, `Belegtyp ${verweisBeleg.belegTyp} kann nicht storniert werden`)
      }

      // Positionen mit negiertem Einzelpreis
      const originalPositionen = verweisBeleg.positionen as BelegPosition[]
      const positionen: BelegPosition[] = originalPositionen.map(p => ({
        bezeichnung:        `Storno: ${p.bezeichnung}`,
        menge:              p.menge,
        einzelpreisBreutto: -p.einzelpreisBreutto,
        mwstSatz:           p.mwstSatz,
      }))

      // Zahlungsaufteilung 1:1 negieren
      const zahlung: ZahlungAufteilung = {
        barCent:      -verweisBeleg.summeBarCent,
        karteCent:    -verweisBeleg.summeKarteCent,
        sonstigeCent: -verweisBeleg.summeSonstigeCent,
      }

      return { positionen, zahlung }
    },
  }, deps)

  return toDto(persisted, signed.positionen)
}

// ---------------------------------------------------------------------------
// Nullbeleg / Monatsbeleg / Jahresbeleg — strukturell identisch (kein Umsatz)
// ---------------------------------------------------------------------------

async function erstelleNullartigenBeleg(
  belegTyp: 'Nullbeleg' | 'Monatsbeleg' | 'Jahresbeleg',
  kasseId:  string,
  deps:     BelegServiceDeps,
): Promise<BelegResponse> {
  const { signed, persisted } = await signiereImTx({
    kasseId,
    belegTyp,
    belegDaten:      { positionen: [], zahlung: NULL_ZAHLUNG },
    validatePayment: false,
  }, deps)
  return toDto(persisted, signed.positionen)
}

export async function erstelleNullbeleg(input: NullbelegInput, deps: BelegServiceDeps): Promise<BelegResponse> {
  return erstelleNullartigenBeleg('Nullbeleg', input.kasseId, deps)
}

export async function erstelleMonatsbeleg(input: MonatsbelegInput, deps: BelegServiceDeps): Promise<BelegResponse> {
  return erstelleNullartigenBeleg('Monatsbeleg', input.kasseId, deps)
}

export async function erstelleJahresbeleg(input: JahresbelegInput, deps: BelegServiceDeps): Promise<BelegResponse> {
  // TODO: Bei input.finanzOnline → FinanzOnlineClient.startbelegPruefen(beleg) aufrufen
  //       und pruefwert in Kasse-Tabelle speichern. Aktuell wird der Jahresbeleg
  //       nur lokal erstellt — manuelle Prüfung über FinanzOnline-Portal nötig.
  return erstelleNullartigenBeleg('Jahresbeleg', input.kasseId, deps)
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
