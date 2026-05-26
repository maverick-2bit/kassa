/**
 * Beleg-Service: RKSV-konforme Erstellung aller Belegtypen.
 *
 * Architektur:
 *   - `signiereImTx()` ist der gemeinsame Inner-Loop:
 *     Kasse FOR UPDATE → SEE entschlüsseln → signieren → persistieren → Kasse updaten
 *   - Pro Belegtyp gibt es eine Public-API-Funktion, die die Positionen aufbaut
 *     und dann signiereImTx() innerhalb einer Transaktion aufruft.
 */

import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { Buffer } from 'node:buffer'
import {
  Umsatzzaehler,
  signiereBeleg,
  gesamtBetragCent,
  erstelleDEP7Export,
  erstelleDEP131Export,
  dep7ZuJson,
  dep131ZuJson,
  type BelegPosition,
  type BelegTyp,
  type DEP131BelegInput,
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
  KundeSnapshot,
  MonatsbelegInput,
  NullbelegInput,
  StornobelegInput,
} from '@kassa/shared'
import { ArtikelPositionSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, belege, kassen, kategorien, modifikatoren } from '../db/schema.js'
import { erstelleKunde, ladeKundeSnapshot } from './kunde.service.js'
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
  /** Verweis auf Original-Beleg (nur für Stornobeleg) */
  verweisBelegId?: string
  /** Kunden-Zuordnung (optional, nur bei Barzahlungsbeleg) */
  kundeId?:       string | undefined
  kundeSnapshot?: KundeSnapshot | undefined
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

    // Zertifikats-Ablauf prüfen
    if (kasse.seeGueltigBis <= new Date()) {
      const ablaufDatum = kasse.seeGueltigBis.toISOString().slice(0, 10)
      throw new BelegError(
        409,
        `SEE-Zertifikat ist abgelaufen (${ablaufDatum}). Die Kasse kann keine Belege mehr ausstellen. Bitte Kasse neu einrichten.`,
      )
    }

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
      ...(input.verweisBelegId && { verweisBelegId: input.verweisBelegId }),
      ...(input.kundeId        && { kundeId:        input.kundeId }),
      ...(input.kundeSnapshot  && { kundeSnapshot:  input.kundeSnapshot }),
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
  // Kunden-Snapshot vor der Transaktion auflösen (neuer Kunde wird hier angelegt)
  let kundeId:       string | undefined
  let kundeSnapshot: KundeSnapshot | undefined

  if (input.neuerKunde || input.kundeId) {
    const kasseRows = await deps.db
      .select({ mandantId: kassen.mandantId })
      .from(kassen)
      .where(eq(kassen.id, input.kasseId))
      .limit(1)
    const mandantId = kasseRows[0]?.mandantId
    if (mandantId) {
      if (input.neuerKunde) {
        const neuer = await erstelleKunde(deps.db, mandantId, input.neuerKunde)
        kundeId       = neuer.id
        kundeSnapshot = {
          id: neuer.id, nummer: neuer.nummer, bezeichnung: neuer.bezeichnung,
          firma: neuer.firma, vorname: neuer.vorname, nachname: neuer.nachname,
          email: neuer.email, telefon: neuer.telefon, strasse: neuer.strasse,
          plz: neuer.plz, ort: neuer.ort, land: neuer.land, uid: neuer.uid,
        }
      } else if (input.kundeId) {
        kundeSnapshot = await ladeKundeSnapshot(deps.db, input.kundeId, mandantId)
        kundeId       = input.kundeId
      }
    }
  }

  const { signed, persisted } = await signiereImTx({
    kasseId:         input.kasseId,
    belegTyp:        'Barzahlungsbeleg',
    validatePayment: true,
    kundeId,
    kundeSnapshot,
    belegDaten: async (tx) => {
      // Artikel-Positionen (mit artikelId) vs. freie Positionen trennen
      const artikelPositionen = input.positionen.filter(p => ArtikelPositionSchema.safeParse(p).success)
      const freiePositionen   = input.positionen.filter(p => !ArtikelPositionSchema.safeParse(p).success)

      const artikelIds  = [...new Set(artikelPositionen.map(p => (p as { artikelId: string }).artikelId))]
      const artikelRows = artikelIds.length > 0
        ? await tx.select().from(artikel).where(and(inArray(artikel.id, artikelIds), eq(artikel.aktiv, true)))
        : []
      if (artikelRows.length !== artikelIds.length) {
        throw new BelegError(404, 'Mindestens ein Artikel ist nicht (mehr) verfügbar')
      }
      const artikelById = new Map(artikelRows.map(a => [a.id, a]))

      // Kategorie-Infos laden (für Bonierdrucker-Check UND Warengruppen-Reporting)
      const katergorieIds = [...new Set(
        artikelRows.map(a => a.kategorieId).filter((id): id is string => id !== null),
      )]
      const katBonierdruckerMap = new Map<string, string | null>()
      const katNameMap          = new Map<string, string>()
      if (katergorieIds.length > 0) {
        const katRows = await tx
          .select({ id: kategorien.id, name: kategorien.name, bonierdruckerId: kategorien.bonierdruckerId })
          .from(kategorien)
          .where(inArray(kategorien.id, katergorieIds))
        for (const k of katRows) {
          katBonierdruckerMap.set(k.id, k.bonierdruckerId)
          katNameMap.set(k.id, k.name)
        }
      }

      // Positionen aufbauen — extra Felder (kategorieId, kategorieName) werden im JSONB
      // mitgespeichert, berühren aber nicht die RKSV-Signatur (nur menge/preis/mwst relevant).
      const positionen: (BelegPosition & { kategorieId?: string | undefined; kategorieName?: string | undefined })[] =
        input.positionen.map((p) => {
          // Freie Position: direkt übernehmen, kein Artikel-Lookup
          if (!('artikelId' in p)) {
            return {
              bezeichnung:        p.bezeichnung,
              menge:              p.menge,
              einzelpreisBreutto: p.preisBruttoCent,
              mwstSatz:           p.mwstSatz,
            }
          }
          const a = artikelById.get(p.artikelId)
          if (!a) throw new BelegError(404, `Artikel ${p.artikelId} nicht gefunden`)
          const preis = p.einzelpreisBreuttoCent ?? a.preisBruttoCent
          const bezeichnung = p.bezeichnungZusatz
            ? `${a.bezeichnung} (${p.bezeichnungZusatz})`
            : a.bezeichnung
          return {
            bezeichnung,
            menge:              p.menge,
            einzelpreisBreutto: preis,
            mwstSatz:           a.mwstSatz as MwStSatz,
            ...(a.kategorieId && {
              kategorieId:   a.kategorieId,
              kategorieName: katNameMap.get(a.kategorieId),
            }),
          }
        })

      // Rabatt-Positionen einfügen (nach Artikel-Lookup, vor Lagerstand-Update)
      if (input.rabatt) {
        const rabattLabel = input.rabatt.bezeichnung
          ?? (input.rabatt.typ === 'prozent'
              ? `Rabatt (${input.rabatt.prozent}%)`
              : 'Rabatt')

        if (input.rabatt.typ === 'prozent') {
          // Anteilig auf alle MwSt-Sätze verteilen
          const satzSummen = new Map<MwStSatz, number>()
          for (const p of positionen) {
            satzSummen.set(p.mwstSatz, (satzSummen.get(p.mwstSatz) ?? 0) + p.einzelpreisBreutto * p.menge)
          }
          for (const [satz, summe] of satzSummen) {
            if (summe <= 0) continue
            const rabattCent = Math.round(summe * input.rabatt.prozent / 100)
            positionen.push({ bezeichnung: rabattLabel, menge: 1, einzelpreisBreutto: -rabattCent, mwstSatz: satz })
          }
        } else {
          const satz = input.rabatt.mwstSatz ?? 'normal'
          positionen.push({ bezeichnung: rabattLabel, menge: 1, einzelpreisBreutto: -input.rabatt.betragCent, mwstSatz: satz })
        }
      }

      // Lagerstand-Countdown: Zwei-Pfad-Logik um Doppel-Abzug zu vermeiden.
      //
      //  • Artikel MIT Bonierrouting (station oder bonierdruckerId, egal ob auf Artikel- oder
      //    Kategorieebene) → Lagerstand wurde bereits beim Bonieren dekrementiert; hier NICHT.
      //  • Artikel OHNE Bonierrouting (reines Direktkassieren, z. B. To-go) → hier dekrementieren.

      for (const p of input.positionen) {
        if (!('artikelId' in p)) continue  // freie Position: kein Lagerstand
        const a = artikelById.get(p.artikelId)
        if (!a || !a.lagerstandAktiv) continue
        // Bonierbar? → Lagerstand wurde beim Bonieren abgezogen, nicht nochmal hier.
        const hatArtikelBonierrouting  = a.station !== null || a.bonierdruckerId !== null
        const hatKategorieBonierrouting = a.kategorieId
          ? (katBonierdruckerMap.get(a.kategorieId) ?? null) !== null
          : false
        if (hatArtikelBonierrouting || hatKategorieBonierrouting) continue

        // Kein Bonierrouting → Direktkassieren, Lagerstand atomar abziehen
        await tx
          .update(artikel)
          .set({
            lagerstandMenge: sql`GREATEST(0, COALESCE(${artikel.lagerstandMenge}, 0) - ${p.menge})`,
            updatedAt:       new Date(),
          })
          .where(eq(artikel.id, a.id))
      }
      // (Modifikator-Lagerstand: nie automatisch, bleibt manuell per Wareneingang/Inventur)

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
    verweisBelegId:  input.verweisBelegId,
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

      // Prüfen ob Beleg bereits storniert wurde
      const [bereitsStorniert] = await tx
        .select({ id: belege.id })
        .from(belege)
        .where(eq(belege.verweisBelegId, input.verweisBelegId))
        .limit(1)
      if (bereitsStorniert) {
        throw new BelegError(409, 'Dieser Beleg wurde bereits storniert')
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
  // Hinweis: Die FinanzOnline SOAP-API stellt KEINE Methode zur automatisierten
  // Jahresbeleg-Prüfung bereit. Die Prüfung erfolgt manuell durch den Unternehmer
  // via BMF FinanzOnline App (Belegcheck, QR-Code scannen) — gesetzlich vorgeschrieben
  // gemäß RKSV § 8 Abs. 3. Das Frontend zeigt nach der Erstellung einen Prüfhinweis.
  return erstelleNullartigenBeleg('Jahresbeleg', input.kasseId, deps)
}

// ---------------------------------------------------------------------------
// Belege auflisten
// ---------------------------------------------------------------------------

export async function listeBelege(
  db: Db,
  kasseId: string,
  opts: { limit?: number; kundeId?: string } = {},
): Promise<BelegResponse[]> {
  const conditions = [eq(belege.kasseId, kasseId)]
  if (opts.kundeId) {
    conditions.push(eq(belege.kundeId, opts.kundeId))
  }
  const rows = await db
    .select()
    .from(belege)
    .where(and(...conditions))
    .orderBy(desc(belege.belegNummer))
    .limit(opts.limit ?? 50)

  return rows.map(r => toDto(r, r.positionen as BelegPosition[]))
}

// ---------------------------------------------------------------------------
// DEP-Export (DEP7 + DEP131)
// ---------------------------------------------------------------------------

export interface DepExportFilter {
  kasseId:   string
  vonDatum?: string | undefined  // YYYY-MM-DD
  bisDatum?: string | undefined  // YYYY-MM-DD
}

export async function erstelleDep7Json(
  db:     Db,
  filter: DepExportFilter,
): Promise<{ json: string; kassenId: string; anzahl: number }> {
  const { rows, kassenId, zertBase64 } = await ladeDepDaten(db, filter)
  const maschinenCodes = rows.map(r => r.maschinenlesbareCode)

  const dep7 = erstelleDEP7Export(
    rows.map(r => ({ maschinenlesbareCode: r.maschinenlesbareCode } as SignedBeleg)),
    { zertifikatDER: Buffer.from(zertBase64, 'base64'), kassenId, privateKeyDER: Buffer.alloc(0) },
    kassenId,
  )

  return { json: dep7ZuJson(dep7), kassenId, anzahl: maschinenCodes.length }
}

export async function erstelleDep131Json(
  db:     Db,
  filter: DepExportFilter,
): Promise<{ json: string; kassenId: string; anzahl: number }> {
  const { rows, kassenId } = await ladeDepDaten(db, filter)

  const belegInputs: DEP131BelegInput[] = rows.map(r => ({
    belegNummer:                 r.belegNummer,
    datumUhrzeit:                r.belegDatum,
    belegTyp:                    r.belegTyp as BelegTyp,
    positionen:                  r.positionen as BelegPosition[],
    betraege: {
      normal:      r.betragNormalCent,
      ermaessigt1: r.betragErmaessigt1Cent,
      ermaessigt2: r.betragErmaessigt2Cent,
      null:        r.betragNullCent,
      besonders:   r.betragBesondersCent,
    },
    zahlung: {
      barCent:      r.summeBarCent,
      karteCent:    r.summeKarteCent,
      sonstigeCent: r.summeSonstigeCent,
    },
    maschinenlesbareCode:        r.maschinenlesbareCode,
    signaturwert:                r.signaturwert,
    umsatzzaehlerVerschluesselt: r.umsatzzaehlerVerschluesselt,
    zertifikatSN:                r.zertifikatSn,
    sigVorbeleg:                 r.sigVorbeleg,
  }))

  const dep131 = erstelleDEP131Export(belegInputs, kassenId)
  return { json: dep131ZuJson(dep131), kassenId, anzahl: rows.length }
}

async function ladeDepDaten(
  db:     Db,
  filter: DepExportFilter,
): Promise<{ rows: typeof belege.$inferSelect[]; kassenId: string; zertBase64: string }> {
  const kasseRows = await db.select().from(kassen).where(eq(kassen.id, filter.kasseId)).limit(1)
  const kasse = kasseRows[0]
  if (!kasse) throw new BelegError(404, 'Kasse nicht gefunden')

  const conditions = [eq(belege.kasseId, filter.kasseId)]
  if (filter.vonDatum) {
    conditions.push(gte(belege.belegDatum, new Date(filter.vonDatum + 'T00:00:00.000Z')))
  }
  if (filter.bisDatum) {
    // Bis einschließlich des angegebenen Tages (00:00 des Folgetags)
    const bis = new Date(filter.bisDatum + 'T00:00:00.000Z')
    bis.setDate(bis.getDate() + 1)
    conditions.push(lt(belege.belegDatum, bis))
  }

  const rows = await db
    .select()
    .from(belege)
    .where(and(...conditions))
    .orderBy(asc(belege.belegNummer))

  return { rows, kassenId: kasse.kassenId, zertBase64: kasse.seeZertifikatDer }
}

// ---------------------------------------------------------------------------
// DB-Row → DTO
// ---------------------------------------------------------------------------

function toDto(
  row:        typeof belege.$inferSelect,
  positionen: BelegPosition[],
): BelegResponse {
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
    ...(row.verweisBelegId && { verweisBelegId: row.verweisBelegId }),
    ...(row.kundeSnapshot != null ? { kunde: row.kundeSnapshot as KundeSnapshot } : {}),
    zertifikatSn:                row.zertifikatSn,
    sigVorbeleg:                 row.sigVorbeleg,
    signaturwert:                row.signaturwert,
    umsatzzaehlerVerschluesselt: row.umsatzzaehlerVerschluesselt,
    maschinenlesbareCode:        row.maschinenlesbareCode,
    createdAt:                   row.createdAt.toISOString(),
  }
}
