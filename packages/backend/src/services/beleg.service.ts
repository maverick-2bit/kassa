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
  ATrustHsmEinheit,
  Umsatzzaehler,
  signiereBeleg,
  gesamtBetragCent,
  generiereAesSchluessel,
  qrCodeZuJwsCompact,
  erstelleDEP7Export,
  erstelleDEP131Export,
  dep7ZuJson,
  dep131ZuJson,
  FinanzOnlineClient,
  type FinanzOnlineCredentials,
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
import { artikel, belege, kassen, kategorien, mandanten, modifikatoren, seriennummern } from '../db/schema.js'
import { erstelleKunde, ladeKundeSnapshot } from './kunde.service.js'
import { decryptPrivateKey, encryptPrivateKey } from '../crypto/master-key.js'

export interface BelegServiceDeps {
  db:               Db
  masterPassphrase: string
  /**
   * Optionaler FinanzOnline-Client (Stub im Dev/E2E via FO_STUB). Fehlt er,
   * wird für reale Meldungen ein Client passend zur Kassen-Umgebung erzeugt.
   */
  finanzOnlineClient?: FinanzOnlineClient
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
  /**
   * SEE-Wiederinbetriebnahme: erzwingt echte Signierung (ignoriert ein
   * gesetztes seeAusgefallenSeit) und setzt das Ausfall-Flag bei Erfolg zurück.
   * Schlägt die Signierung fehl, rollt die Transaktion zurück → Ausfall bleibt.
   */
  wiederherstellung?: boolean
  /**
   * Außerbetriebnahme: setzt in derselben Transaktion status='ausser_betrieb'
   * + ausserBetriebAm — der signierte Beleg (Schlussbeleg) ist damit garantiert
   * der letzte Beleg der Kasse (kein Zustand „Schlussbeleg da, aber noch aktiv").
   */
  ausserBetrieb?: boolean
  /** Läuft NACH dem Beleg-Insert in derselben Tx (z. B. Seriennummern als verkauft markieren). */
  nachPersist?: (tx: Tx, belegId: string) => Promise<void>
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
    // Hinweis: Eine NICHT bei FinanzOnline registrierte Kasse darf provisorisch
    // Belege ausstellen (Event-Einrichtung ohne FON-Daten). Die Belege werden
    // regulär signiert; die FON-Registrierung ist zeitnah nachzutragen. Das UI
    // weist per Warnbanner darauf hin (siehe fo-Status/„FON nachtragen").

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

    // Umsatzzähler-AES-Schlüssel: entschlüsseln — für Alt-Kassen (vor Migration
    // 0025) einmalig erzeugen und in derselben Tx persistieren.
    let aesSchluessel: Buffer
    if (kasse.aesSchluesselEnc) {
      aesSchluessel = decryptPrivateKey(kasse.aesSchluesselEnc, deps.masterPassphrase)
    } else {
      aesSchluessel = generiereAesSchluessel()
      await tx
        .update(kassen)
        .set({ aesSchluesselEnc: encryptPrivateKey(aesSchluessel, deps.masterPassphrase) })
        .where(eq(kassen.id, kasse.id))
    }

    const see: SEEConfig = {
      kassenId:      kasse.kassenId,
      zertifikatDER: Buffer.from(kasse.seeZertifikatDer, 'base64'),
      privateKeyDER,
      aesSchluessel,
      zdaId:         kasse.seeZdaId,
    }

    // Externe Signatureinheit (A-Trust HSM) — scheitert sie (Timeout/HTTP),
    // greift unten automatisch der bestehende SEE-Ausfallmodus.
    const einheit = kasse.seeTyp === 'atrust_hsm' && kasse.atrustBasisUrl && kasse.atrustBenutzer && kasse.atrustPasswortEnc
      ? new ATrustHsmEinheit({
          basisUrl: kasse.atrustBasisUrl,
          benutzer: kasse.atrustBenutzer,
          passwort: decryptPrivateKey(kasse.atrustPasswortEnc, deps.masterPassphrase).toString('utf8'),
        })
      : undefined

    // Signierungs-Kontext aus letztem DB-Zustand
    const umsatzzaehler = new Umsatzzaehler(kasse.umsatzzaehlerCent)
    const kontext: SignierungsKontext = {
      see,
      umsatzzaehler,
      ...(kasse.letzterBelegCode && { letzterBelegCode: kasse.letzterBelegCode }),
      ...(einheit && { einheit }),
    }

    // Signieren
    const raw: RawBeleg = {
      kassenId:     kasse.kassenId,
      belegNummer:  kasse.letzteBelegNummer + 1,
      datumUhrzeit: new Date(),
      belegTyp:     input.belegTyp,
      positionen,
    }
    // Signieren — mit SEE-Ausfallbehandlung:
    //  - Ausfall aktiv (Flag gesetzt): Beleg trägt den Ausfallmarker statt Signatur.
    //  - Wiederherstellung: erzwingt echte Signierung; scheitert sie, propagiert
    //    der Fehler und rollt die Transaktion zurück (Ausfall bleibt bestehen).
    //  - Normalfall: scheitert die ECDSA-Signierung, wird automatisch in den
    //    Ausfallmodus gewechselt (Beleg mit Marker), Zähler vorher zurückgesetzt.
    const ausfallAktiv = kasse.seeAusgefallenSeit != null && !input.wiederherstellung
    let signed: SignedBeleg
    let ausfallNeuErkannt = false

    if (ausfallAktiv) {
      signed = await signiereBeleg(raw, kontext, { ausfallModus: true })
    } else {
      try {
        signed = await signiereBeleg(raw, kontext)
      } catch (signErr) {
        if (input.wiederherstellung) throw signErr
        umsatzzaehler.setze(kasse.umsatzzaehlerCent)
        signed = await signiereBeleg(raw, kontext, { ausfallModus: true })
        ausfallNeuErkannt = true
      }
    }

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
    const kasseUpdate: Partial<typeof kassen.$inferInsert> = {
      umsatzzaehlerCent:   umsatzzaehler.aktuell,
      letzteBelegNummer:   signed.belegNummer,
      letzterBelegCode:    signed.maschinenlesbareCode,
      updatedAt:           new Date(),
    }
    if (input.wiederherstellung) {
      kasseUpdate.seeAusgefallenSeit = null            // SEE wieder in Betrieb
    } else if (ausfallNeuErkannt && kasse.seeAusgefallenSeit == null) {
      kasseUpdate.seeAusgefallenSeit = new Date()       // Ausfall erstmals erkannt
    }
    if (input.ausserBetrieb) {
      kasseUpdate.status          = 'ausser_betrieb'   // Schlussbeleg = letzter Beleg
      kasseUpdate.ausserBetriebAm = new Date()
    }
    await tx.update(kassen).set(kasseUpdate).where(eq(kassen.id, kasse.id))

    if (input.nachPersist) await input.nachPersist(tx, persisted.id)

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

  // Serialisierte Positionen: Zuweisungen werden in belegDaten validiert und hier gesammelt,
  // nach dem Beleg-Insert (nachPersist) als verkauft markiert.
  const serialMarks: { artikelId: string; serials: string[] }[] = []

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

      // Seriennummern-Zuweisungen (serialisierte Artikel): validieren + auf Position setzen
      for (let i = 0; i < input.positionen.length; i++) {
        const p = input.positionen[i]
        if (!p || !('artikelId' in p) || !p.seriennummern || p.seriennummern.length === 0) continue
        const a = artikelById.get(p.artikelId)
        if (!a?.seriennummernAktiv) throw new BelegError(400, `Artikel „${a?.bezeichnung ?? ''}" führt keine Seriennummern`)
        if (p.seriennummern.length !== Math.round(p.menge)) {
          throw new BelegError(400, `Für „${a.bezeichnung}" müssen genau ${Math.round(p.menge)} Seriennummern gewählt werden`)
        }
        const frei = await tx
          .select({ sn: seriennummern.seriennummer })
          .from(seriennummern)
          .where(and(
            eq(seriennummern.artikelId, p.artikelId),
            inArray(seriennummern.seriennummer, p.seriennummern),
            eq(seriennummern.status, 'verfuegbar'),
          ))
        if (frei.length !== new Set(p.seriennummern).size) {
          throw new BelegError(409, `Eine gewählte Seriennummer für „${a.bezeichnung}" ist nicht mehr verfügbar`)
        }
        const zielPos = positionen[i]
        if (zielPos) zielPos.seriennummern = p.seriennummern
        serialMarks.push({ artikelId: p.artikelId, serials: p.seriennummern })
      }

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
    nachPersist: async (tx, belegId) => {
      // Verkaufte Seriennummern aus dem Pool nehmen und dem Beleg zuordnen
      for (const mark of serialMarks) {
        await tx
          .update(seriennummern)
          .set({ status: 'verkauft', belegId, verkauftAm: new Date() })
          .where(and(
            eq(seriennummern.artikelId, mark.artikelId),
            inArray(seriennummern.seriennummer, mark.serials),
          ))
      }
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
// SEE-Ausfall / Wiederinbetriebnahme
// ---------------------------------------------------------------------------

/** RKSV: Ein Ausfall ab dieser Dauer ist FinanzOnline zu melden (48 Stunden). */
const FON_MELDE_SCHWELLE_MIN = 48 * 60

/** Ergebnis einer optionalen FinanzOnline-Meldung (nur wenn Zugangsdaten übergeben). */
export interface FonMeldungErgebnis {
  /** true, wenn eine FON-Meldung überhaupt versucht wurde (Zugangsdaten vorhanden). */
  versucht:     boolean
  erfolgreich:  boolean
  fehler?:      string
}

export interface SeeStatus {
  ausgefallen:      boolean
  /** ISO-Zeitstempel des Ausfallbeginns, null wenn in Betrieb */
  seit:             string | null
  dauerMinuten:     number | null
  /** true, wenn die Ausfalldauer die FinanzOnline-Meldeschwelle (48h) erreicht */
  fonMeldungNoetig: boolean
  /** Ergebnis der FinanzOnline-Meldung, falls bei diesem Aufruf eine gesendet wurde. */
  fonMeldung?:      FonMeldungErgebnis
}

/**
 * Sendet — nur wenn Zugangsdaten übergeben wurden — die SEE-Statusmeldung an
 * FinanzOnline. Läuft NACH der DB-Transaktion (kein Lock während des SOAP-Calls)
 * und ist nicht-fatal: schlägt sie fehl, bleibt der lokale Zustand erhalten und
 * das Ergebnis wird zurückgemeldet (Meldung kann wiederholt werden).
 */
async function sendeFonSeeMeldung(
  deps:        BelegServiceDeps,
  kasse:       { kassenId: string; seeZertifikatSn: string; umgebung: string },
  operation:   'ausfall' | 'wiederinbetriebnahme',
  credentials?: FinanzOnlineCredentials,
): Promise<FonMeldungErgebnis | undefined> {
  if (!credentials) return undefined
  const client = deps.finanzOnlineClient
    ?? new FinanzOnlineClient(kasse.umgebung === 'test' ? 'test' : 'produktion')
  try {
    const res = operation === 'ausfall'
      ? await client.seeAusfallMelden(kasse.kassenId, kasse.seeZertifikatSn, credentials)
      : await client.seeWiederinbetriebnahmeMelden(kasse.kassenId, kasse.seeZertifikatSn, credentials)
    return { versucht: true, erfolgreich: res.erfolgreich, ...(res.fehler && { fehler: res.fehler }) }
  } catch (err) {
    return { versucht: true, erfolgreich: false, fehler: err instanceof Error ? err.message : String(err) }
  }
}

function baueSeeStatus(seit: Date | null, bezug: Date = new Date()): SeeStatus {
  if (!seit) return { ausgefallen: false, seit: null, dauerMinuten: null, fonMeldungNoetig: false }
  const dauerMinuten = Math.max(0, Math.floor((bezug.getTime() - seit.getTime()) / 60_000))
  return {
    ausgefallen:      true,
    seit:             seit.toISOString(),
    dauerMinuten,
    fonMeldungNoetig: dauerMinuten >= FON_MELDE_SCHWELLE_MIN,
  }
}

/** Aktuellen SEE-Status einer Kasse abfragen. */
export async function holeSeeStatus(kasseId: string, deps: BelegServiceDeps): Promise<SeeStatus> {
  const rows = await deps.db
    .select({ seit: kassen.seeAusgefallenSeit })
    .from(kassen).where(eq(kassen.id, kasseId)).limit(1)
  if (!rows[0]) throw new BelegError(404, 'Kasse nicht gefunden')
  return baueSeeStatus(rows[0].seit)
}

/**
 * SEE-Ausfall melden: ab sofort tragen neue Belege den Ausfallmarker statt einer
 * Signatur. Idempotent — ein bereits laufender Ausfall behält seinen Beginn.
 */
export async function meldeSeeAusfall(
  kasseId:      string,
  deps:         BelegServiceDeps,
  credentials?: FinanzOnlineCredentials,
): Promise<SeeStatus> {
  const kasse = await deps.db.transaction(async (tx) => {
    const rows = await tx.select().from(kassen).where(eq(kassen.id, kasseId)).for('update')
    const k = rows[0]
    if (!k) throw new BelegError(404, 'Kasse nicht gefunden')
    if (k.seeAusgefallenSeit == null) {
      const jetzt = new Date()
      await tx.update(kassen).set({ seeAusgefallenSeit: jetzt, updatedAt: jetzt }).where(eq(kassen.id, kasseId))
      return { ...k, seeAusgefallenSeit: jetzt }
    }
    return k
  })

  const status = baueSeeStatus(kasse.seeAusgefallenSeit)
  const fon = await sendeFonSeeMeldung(deps, kasse, 'ausfall', credentials)
  return { ...status, ...(fon && { fonMeldung: fon }) }
}

export interface WiederherstellungErgebnis {
  /** Status vor der Wiederherstellung (Dauer des Ausfalls). */
  behobenerAusfall: SeeStatus
  /** Signierter Nullbeleg als Nachweis der Wiederinbetriebnahme. */
  sammelbeleg:      BelegResponse
  /** Ergebnis der FinanzOnline-Meldung, falls Zugangsdaten übergeben wurden. */
  fonMeldung?:      FonMeldungErgebnis
}

/**
 * SEE-Wiederinbetriebnahme: erstellt einen signierten Nullbeleg (Sammelbeleg)
 * als Nachweis und setzt das Ausfall-Flag zurück — beides atomar. Gelingt die
 * Signierung nicht (SEE weiterhin gestört), bleibt der Ausfall bestehen.
 */
export async function meldeSeeWiederherstellung(
  kasseId:      string,
  deps:         BelegServiceDeps,
  credentials?: FinanzOnlineCredentials,
): Promise<WiederherstellungErgebnis> {
  const vorher = await deps.db
    .select({
      seit:            kassen.seeAusgefallenSeit,
      kassenId:        kassen.kassenId,
      seeZertifikatSn: kassen.seeZertifikatSn,
      umgebung:        kassen.umgebung,
    })
    .from(kassen).where(eq(kassen.id, kasseId)).limit(1)
  if (!vorher[0]) throw new BelegError(404, 'Kasse nicht gefunden')
  if (vorher[0].seit == null) throw new BelegError(409, 'Kein SEE-Ausfall aktiv')

  const behobenerAusfall = baueSeeStatus(vorher[0].seit)

  const { signed, persisted } = await signiereImTx({
    kasseId,
    belegTyp:          'Nullbeleg',
    belegDaten:        { positionen: [], zahlung: NULL_ZAHLUNG },
    validatePayment:   false,
    wiederherstellung: true,
  }, deps)

  const fon = await sendeFonSeeMeldung(deps, vorher[0], 'wiederinbetriebnahme', credentials)

  return {
    behobenerAusfall,
    sammelbeleg: toDto(persisted, signed.positionen),
    ...(fon && { fonMeldung: fon }),
  }
}

// ---------------------------------------------------------------------------
// FinanzOnline-Registrierung (Status + Nachtrag bei provisorischer Einrichtung)
// ---------------------------------------------------------------------------

export interface FoRegistrierungStatus {
  registriert:    boolean
  registriertAm:  string | null
}

/** FON-Registrierungsstatus einer Kasse (für den „ausstehend"-Warnbanner). */
export async function holeFoRegistrierungStatus(kasseId: string, deps: BelegServiceDeps): Promise<FoRegistrierungStatus> {
  const rows = await deps.db
    .select({ reg: kassen.bei_fo_registriert, am: kassen.registriert_am })
    .from(kassen).where(eq(kassen.id, kasseId)).limit(1)
  if (!rows[0]) throw new BelegError(404, 'Kasse nicht gefunden')
  return { registriert: rows[0].reg, registriertAm: rows[0].am ? rows[0].am.toISOString() : null }
}

/**
 * Trägt die FinanzOnline-Registrierung einer provisorisch eingerichteten Kasse
 * nach: registriert SEE + Kasse bei FON und lässt den bestehenden Startbeleg
 * prüfen. Erst bei Erfolg wird die Kasse als registriert markiert.
 */
export async function registriereKasseBeiFinanzOnline(
  kasseId:     string,
  credentials: FinanzOnlineCredentials,
  deps:        BelegServiceDeps,
): Promise<FoRegistrierungStatus> {
  const rows = await deps.db
    .select({
      kassenId:          kassen.kassenId,
      umgebung:          kassen.umgebung,
      seeZertifikatDer:  kassen.seeZertifikatDer,
      seeZdaId:          kassen.seeZdaId,
      seeTyp:            kassen.seeTyp,
      aesSchluesselEnc:  kassen.aesSchluesselEnc,
      registriert:       kassen.bei_fo_registriert,
      uid:               mandanten.uid,
    })
    .from(kassen)
    .innerJoin(mandanten, eq(kassen.mandantId, mandanten.id))
    .where(eq(kassen.id, kasseId)).limit(1)
  const k = rows[0]
  if (!k) throw new BelegError(404, 'Kasse nicht gefunden')
  if (k.registriert) throw new BelegError(409, 'Kasse ist bereits bei FinanzOnline registriert')
  if (!k.aesSchluesselEnc) throw new BelegError(409, 'Kasse hat noch keinen Umsatzzähler-Schlüssel — bitte zuerst einen Beleg erstellen')

  const client = deps.finanzOnlineClient
    ?? new FinanzOnlineClient(k.umgebung === 'test' ? 'test' : 'produktion')
  const zertifikatDER = Buffer.from(k.seeZertifikatDer, 'base64')
  const aesSchluessel = decryptPrivateKey(k.aesSchluesselEnc, deps.masterPassphrase)

  // 1. SEE + Kasse bei FinanzOnline registrieren (benutzerschluessel = AES-Schlüssel base64)
  const reg = await client.kasseInBetriebNehmen({
    kassenId:      k.kassenId,
    uid:           k.uid,
    zertifikatDER,
    credentials,
    benutzerschluesselBase64: aesSchluessel.toString('base64'),
    vdaId:         k.seeZdaId,
    artSe:         k.seeTyp === 'atrust_hsm' ? 'HSM_DIENSTLEISTER' : 'EIGENES_HSM',
  })
  if (!reg.erfolgreich) throw new BelegError(502, reg.fehler ?? 'FinanzOnline-Registrierung fehlgeschlagen')

  // 2. Kassen-Status abfragen (Startbeleg selbst wird mit der BMF-BelegCheck-App geprüft)
  const [sb] = await deps.db
    .select({ code: belege.maschinenlesbareCode })
    .from(belege)
    .where(and(eq(belege.kasseId, kasseId), eq(belege.belegTyp, 'Startbeleg'))).limit(1)
  let pruefwert: string | undefined
  if (sb) {
    const pruef = await client.startbelegPruefen({ maschinenlesbareCode: sb.code } as unknown as SignedBeleg, credentials, k.kassenId)
    if (!pruef.erfolgreich) throw new BelegError(502, pruef.fehler ?? 'Kassen-Statusabfrage fehlgeschlagen')
    pruefwert = pruef.pruefwert
  }

  // 3. Kasse als registriert markieren
  const jetzt = new Date()
  await deps.db.update(kassen).set({
    bei_fo_registriert: true,
    registriert_am:     jetzt,
    ...(pruefwert && { fo_pruefwert: pruefwert }),
    updatedAt:          jetzt,
  }).where(eq(kassen.id, kasseId))

  return { registriert: true, registriertAm: jetzt.toISOString() }
}

// ---------------------------------------------------------------------------
// Kasse außer Betrieb nehmen (RKSV-konforme Stilllegung)
// ---------------------------------------------------------------------------

export interface KasseAusserBetriebErgebnis {
  schlussbeleg: BelegResponse
  /** Nur gesetzt, wenn FON-Zugangsdaten übergeben wurden und die Kasse registriert war. */
  fonMeldung?:  FonMeldungErgebnis
}

/**
 * Nimmt eine Registrierkasse RKSV-konform außer Betrieb:
 *  1. Schlussbeleg (Betrag 0) signieren + status='ausser_betrieb' atomar in
 *     einer Transaktion — der Schlussbeleg ist garantiert der letzte Beleg
 *     (die bestehende Sperre in signiereImTx blockiert danach alles Weitere).
 *  2. Optional FinanzOnline-Abmeldung (Zugangsdaten pro Aufruf, nie
 *     gespeichert; nicht-fatal — der lokale Zustand bleibt auch bei
 *     FON-Fehler außer Betrieb, die Abmeldung ist dann manuell nachzuholen).
 *
 * Endgültig: keine Reaktivierung (RKSV bräuchte einen neuen Startbeleg —
 * dafür eine neue Kasse anlegen). DEP/Belege bleiben aufbewahrt und exportierbar.
 */
export async function nimmKasseAusserBetrieb(
  kasseId:     string,
  credentials: FinanzOnlineCredentials | undefined,
  deps:        BelegServiceDeps,
): Promise<KasseAusserBetriebErgebnis> {
  const rows = await deps.db
    .select({
      kassenId:    kassen.kassenId,
      mandantId:   kassen.mandantId,
      status:      kassen.status,
      umgebung:    kassen.umgebung,
      registriert: kassen.bei_fo_registriert,
    })
    .from(kassen)
    .where(eq(kassen.id, kasseId))
    .limit(1)
  const k = rows[0]
  if (!k) throw new BelegError(404, 'Kasse nicht gefunden')
  if (k.status !== 'aktiv') throw new BelegError(409, 'Kasse ist bereits außer Betrieb')

  // Letzte aktive Kasse des Mandanten darf nicht stillgelegt werden — sonst
  // bleibt keine bedienbare Kasse übrig (Login-Kassenliste wäre leer).
  //
  // Hinweis: Diese Prüfung ist NICHT streng nebenläufigkeitssicher — zwei exakt
  // gleichzeitige Stilllegungen der letzten beiden Kassen könnten beide passieren
  // (→ 0 aktive). Bewusst in Kauf genommen: Der Fall ist extrem selten (bewusste
  // Bestätigungs-Aktion), rein UX-relevant (keine fiskalische Integrität berührt —
  // Schlussbelege + Belegkette bleiben je Kasse korrekt) und reversibel (eine neue
  // Kasse lässt sich jederzeit anlegen, unabhängig von der Aktiv-Zahl). Für strenge
  // Garantie: Mandanten-Zeile per FOR UPDATE serialisieren.
  const [aktive] = await deps.db
    .select({ anzahl: sql<number>`count(*)::int` })
    .from(kassen)
    .where(and(eq(kassen.mandantId, k.mandantId), eq(kassen.status, 'aktiv')))
  if ((aktive?.anzahl ?? 0) <= 1) {
    throw new BelegError(409, 'Die letzte aktive Kasse kann nicht außer Betrieb genommen werden — es muss mindestens eine aktive Kasse bestehen bleiben')
  }

  // 1. Schlussbeleg + Statuswechsel atomar
  const { signed, persisted } = await signiereImTx({
    kasseId,
    belegTyp:        'Schlussbeleg',
    belegDaten:      { positionen: [], zahlung: NULL_ZAHLUNG },
    validatePayment: false,
    ausserBetrieb:   true,
  }, deps)

  const ergebnis: KasseAusserBetriebErgebnis = {
    schlussbeleg: toDto(persisted, signed.positionen),
  }

  // 2. Optionale FON-Abmeldung — NACH der Transaktion, nicht-fatal
  if (credentials && k.registriert) {
    const client = deps.finanzOnlineClient
      ?? new FinanzOnlineClient(k.umgebung === 'test' ? 'test' : 'produktion')
    try {
      const res = await client.kasseAusserBetriebNehmen(k.kassenId, credentials)
      ergebnis.fonMeldung = {
        versucht:    true,
        erfolgreich: res.erfolgreich,
        ...(res.fehler && { fehler: res.fehler }),
      }
    } catch (err) {
      ergebnis.fonMeldung = {
        versucht:    true,
        erfolgreich: false,
        fehler:      err instanceof Error ? err.message : String(err),
      }
    }
  }

  return ergebnis
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

/** Einzelnen Beleg laden (mandanten-scoped) — z. B. für den Rechnungsdruck am KDS. */
export async function holeBeleg(db: Db, belegId: string, mandantId: string): Promise<BelegResponse | null> {
  const [row] = await db
    .select()
    .from(belege)
    .where(and(eq(belege.id, belegId), eq(belege.mandantId, mandantId)))
    .limit(1)
  return row ? toDto(row, row.positionen as BelegPosition[]) : null
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

  // Belege-kompakt = JWS-Compact — aus dem gespeicherten QR-Code umgerechnet
  const dep7 = erstelleDEP7Export(
    rows.map(r => ({ jwsCompact: qrCodeZuJwsCompact(r.maschinenlesbareCode) } as SignedBeleg)),
    { zertifikatDER: Buffer.from(zertBase64, 'base64') },
  )

  return { json: dep7ZuJson(dep7), kassenId, anzahl: rows.length }
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
