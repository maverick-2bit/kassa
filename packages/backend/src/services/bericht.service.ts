/**
 * Umsatzbericht-Service
 *
 * Lädt Barzahlungs- und Stornobelege eines flexiblen Zeitraums und
 * aggregiert sie nach Tag, Kalenderwoche oder Monat (Wiener Ortszeit).
 *
 * Datum-Filter: AT TIME ZONE 'Europe/Vienna' direkt in PostgreSQL.
 */

import { eq, sql, type SQL } from 'drizzle-orm'
import {
  MWST_LABELS,
  type ArtikelBerichtFilter,
  type ArtikelBerichtResponse,
  type BerichtFilter,
  type BerichtGesamt,
  type BerichtResponse,
  type BerichtZeile,
  type BuchungsjournalFilter,
  type KassenVergleichFilter,
  type KassenVergleichResponse,
  type KuechenBerichtFilter,
  type KuechenBerichtResponse,
  type KellnerBerichtFilter,
  type KellnerBerichtResponse,
  type MwStSatz,
  type StundenBerichtFilter,
  type StundenBerichtResponse,
  type StundenBerichtZeile,
  type WarengruppeBerichtResponse,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen } from '../db/schema.js'

const MWST_SAETZE: Record<MwStSatz, number> = {
  normal:      20,
  ermaessigt1: 10,
  ermaessigt2: 13,
  null:         0,
  besonders:   19,
}

export class BerichtError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface BerichtServiceDeps { db: Db }

/**
 * Index-nutzbarer Datumsfilter auf eine timestamptz-Spalte.
 *
 * NICHT `(spalte AT TIME ZONE 'Europe/Vienna')::date BETWEEN …` verwenden: ein
 * Ausdruck AUF der Spalte macht den Index unbrauchbar, Postgres fällt auf einen
 * Seq Scan über die ganze Belegtabelle zurück. Nachgemessen an 54 750 Belegen:
 * Seq Scan ~40 ms gegen Index Only Scan ~3 ms — und das wächst linear mit.
 *
 * Stattdessen die Wiener Tagesgrenzen einmal als Konstanten berechnen und
 * direkt gegen die Spalte vergleichen. `bis` ist inklusiv, deshalb +1 Tag als
 * offene Obergrenze. Sommer-/Winterzeit rechnet Postgres dabei korrekt um.
 *
 * Die äußeren Klammern sind Pflicht — siehe die Merkregel bei zeitFenster().
 */
function datumsBereich(spalte: SQL, von: string, bis: string): SQL {
  return sql`(${spalte} >= (${von}::date)::timestamp at time zone 'Europe/Vienna'
          AND ${spalte} <  (${bis}::date + 1)::timestamp at time zone 'Europe/Vienna')`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function holeUmsatzbericht(
  filter:    BerichtFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<BerichtResponse> {
  // Alle dem Mandanten zugehörigen Kassen-IDs ermitteln
  const alleKassenDesMandanten = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(eq(kassen.mandantId, mandantId))
  const erlaubteIds = new Set(alleKassenDesMandanten.map(k => k.id))

  // Angefragte kasseIds validieren; leere Liste = alle des Mandanten
  const angefragte = filter.kasseIds.length > 0 ? filter.kasseIds : [...erlaubteIds]
  const ungueltige = angefragte.filter(id => !erlaubteIds.has(id))
  if (ungueltige.length > 0) {
    throw new BerichtError(404, `Kasse(n) nicht gefunden: ${ungueltige.join(', ')}`)
  }
  const kasseIds = angefragte

  if (filter.von > filter.bis) {
    throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')
  }

  // Aggregation bewusst in SQL, nicht in JavaScript.
  //
  // Früher lud der Bericht JEDEN Beleg des Zeitraums als Zeile nach Node und
  // summierte dort. Bei einem Jahr Gastro-Betrieb sind das zehntausende Zeilen
  // pro Klick — an 54 750 Belegen gemessen: 3 465 ms und 64 MB Heap, und beides
  // wächst linear mit dem Datenbestand. Die Datenbank liefert jetzt fertige
  // Perioden-Zeilen (ein Dutzend bis wenige hundert).
  const kasseIdArr = sql.join(kasseIds.map(id => sql`${id}::uuid`), sql`, `)

  // Zielrechnung = Verkauf auf offenen Posten. Bewusst NICHT über
  // summeSonstigeCent, denn dort landen auch Gutschein-Einlösungen.
  // EXISTS statt JOIN: mehrere offene Posten je Beleg dürfen den Beleg nicht
  // mehrfach zählen.
  const istZiel = sql`EXISTS (
    SELECT 1 FROM offene_posten op
     WHERE op.beleg_id = b.id AND op.mandant_id = ${mandantId}::uuid
  )`

  const wienerZeit = sql`(b.beleg_datum at time zone 'Europe/Vienna')`
  const periodeAusdruck =
    filter.gruppierung === 'tag'   ? sql`to_char(${wienerZeit}, 'YYYY-MM-DD')`
    : filter.gruppierung === 'monat' ? sql`to_char(${wienerZeit}, 'YYYY-MM')`
    // ISO-Kalenderwoche: IYYY ist das ISO-Jahr (kann am Jahreswechsel vom
    // Kalenderjahr abweichen) — genau wie die frühere JS-Berechnung über den
    // Donnerstag der Woche.
    : sql`to_char(${wienerZeit}, 'IYYY-"KW"IW')`

  const bedingungen = [
    sql`b.kasse_id = ANY(ARRAY[${kasseIdArr}])`,
    sql`b.beleg_typ IN ('Barzahlungsbeleg','Stornobeleg')`,
    datumsBereich(sql`b.beleg_datum`, filter.von, filter.bis),
  ]
  if (filter.nurZielrechnungen) bedingungen.push(istZiel)

  // Uhrzeit-Filter (Wiener Ortszeit). von <= bis: normales Fenster;
  // von > bis: über Mitternacht (z. B. 22:00–02:00 Nachtbetrieb).
  if (filter.zeitVon && filter.zeitBis) {
    const uhrzeit = sql`${wienerZeit}::time`
    // Die äußeren Klammern sind Pflicht: die Bedingungen werden nur mit " AND "
    // verkettet, ohne einzeln geklammert zu werden. Ohne Klammern bräche das OR
    // aus der Verknüpfung aus und höbe Mandanten- wie Datumsfilter auf.
    bedingungen.push(filter.zeitVon <= filter.zeitBis
      ? sql`(${uhrzeit} >= ${filter.zeitVon}::time AND ${uhrzeit} < ${filter.zeitBis}::time)`
      : sql`(${uhrzeit} >= ${filter.zeitVon}::time OR  ${uhrzeit} < ${filter.zeitBis}::time)`)
  }

  const umsatzAusdruck = sql`(b.summe_bar_cent + b.summe_karte_cent + b.summe_sonstige_cent)`

  interface AggZeile extends Record<string, unknown> {
    periode:      string
    belege:       string
    stornos:      string
    umsatz:       string
    bar:          string
    karte:        string
    sonstig:      string
    ziel:         string
    ziel_anzahl:  string
    normal:       string
    ermaessigt1:  string
    ermaessigt2:  string
    null_cent:    string
    besonders:    string
  }

  const rows = await deps.db.execute<AggZeile>(sql`
    SELECT
      ${periodeAusdruck}                                                    AS periode,
      count(*) FILTER (WHERE b.beleg_typ = 'Barzahlungsbeleg')              AS belege,
      count(*) FILTER (WHERE b.beleg_typ = 'Stornobeleg')                   AS stornos,
      COALESCE(SUM(${umsatzAusdruck}), 0)                                   AS umsatz,
      COALESCE(SUM(b.summe_bar_cent), 0)                                    AS bar,
      COALESCE(SUM(b.summe_karte_cent), 0)                                  AS karte,
      COALESCE(SUM(b.summe_sonstige_cent), 0)                               AS sonstig,
      COALESCE(SUM(${umsatzAusdruck}) FILTER (WHERE ${istZiel}), 0)         AS ziel,
      count(*) FILTER (WHERE ${istZiel})                                    AS ziel_anzahl,
      COALESCE(SUM(b.betrag_normal_cent), 0)                                AS normal,
      COALESCE(SUM(b.betrag_ermaessigt1_cent), 0)                           AS ermaessigt1,
      COALESCE(SUM(b.betrag_ermaessigt2_cent), 0)                           AS ermaessigt2,
      COALESCE(SUM(b.betrag_null_cent), 0)                                  AS null_cent,
      COALESCE(SUM(b.betrag_besonders_cent), 0)                             AS besonders
    FROM belege b
    WHERE ${sql.join(bedingungen, sql` AND `)}
    GROUP BY 1
    ORDER BY 1
  `)

  const zahl = (v: string | null) => parseInt(v ?? '0', 10)

  const zeilen: BerichtZeile[] = rows.map(r => ({
    periode:              r.periode,
    anzahlBelege:         zahl(r.belege),
    anzahlStornos:        zahl(r.stornos),
    umsatzCent:           zahl(r.umsatz),
    barCent:              zahl(r.bar),
    karteCent:            zahl(r.karte),
    sonstigCent:          zahl(r.sonstig),
    zielCent:             zahl(r.ziel),
    anzahlZielrechnungen: zahl(r.ziel_anzahl),
  }))

  // MwSt-Summen über alle Perioden — bei höchstens ein paar hundert Zeilen
  // billiger als eine zweite Abfrage.
  const mwstGesamt: Record<MwStSatz, number> = {
    normal:      rows.reduce((s, r) => s + zahl(r.normal),      0),
    ermaessigt1: rows.reduce((s, r) => s + zahl(r.ermaessigt1), 0),
    ermaessigt2: rows.reduce((s, r) => s + zahl(r.ermaessigt2), 0),
    null:        rows.reduce((s, r) => s + zahl(r.null_cent),   0),
    besonders:   rows.reduce((s, r) => s + zahl(r.besonders),   0),
  }

  // Gesamt berechnen
  const gesamt: BerichtGesamt = {
    anzahlBelege:  zeilen.reduce((s, z) => s + z.anzahlBelege, 0),
    anzahlStornos: zeilen.reduce((s, z) => s + z.anzahlStornos, 0),
    umsatzCent:    zeilen.reduce((s, z) => s + z.umsatzCent, 0),
    barCent:       zeilen.reduce((s, z) => s + z.barCent, 0),
    karteCent:     zeilen.reduce((s, z) => s + z.karteCent, 0),
    sonstigCent:   zeilen.reduce((s, z) => s + z.sonstigCent, 0),
    zielCent:              zeilen.reduce((s, z) => s + z.zielCent, 0),
    anzahlZielrechnungen:  zeilen.reduce((s, z) => s + z.anzahlZielrechnungen, 0),
    mwst: (Object.keys(mwstGesamt) as MwStSatz[])
      .filter(k => mwstGesamt[k] !== 0)
      .map(k => {
        const bruttoCent = mwstGesamt[k]
        const prozent    = MWST_SAETZE[k]
        const nettoCent  = prozent === 0 ? bruttoCent : Math.round(bruttoCent / (1 + prozent / 100))
        return { satzKey: k, label: MWST_LABELS[k], bruttoCent, nettoCent, ustCent: bruttoCent - nettoCent }
      }),
  }

  return { von: filter.von, bis: filter.bis, kasseIds, zeilen, gesamt }
}

// ---------------------------------------------------------------------------
// Artikel-Umsatzbericht
// ---------------------------------------------------------------------------

export async function holeArtikelBericht(
  filter:    ArtikelBerichtFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<ArtikelBerichtResponse> {
  const alleKassenDesMandanten = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(eq(kassen.mandantId, mandantId))
  const erlaubteIds = new Set(alleKassenDesMandanten.map(k => k.id))

  const angefragte = filter.kasseIds.length > 0 ? filter.kasseIds : [...erlaubteIds]
  const ungueltige = angefragte.filter(id => !erlaubteIds.has(id))
  if (ungueltige.length > 0) throw new BerichtError(404, `Kasse(n) nicht gefunden: ${ungueltige.join(', ')}`)

  if (filter.von > filter.bis) throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')

  // Positionen per jsonb_array_elements auffalten und nach Bezeichnung aggregieren.
  // Stornobelege haben negative Einzelpreise → werden automatisch korrekt subtrahiert.
  const kasseIdArr = sql.join(angefragte.map(id => sql`${id}::uuid`), sql`, `)
  const rows = await deps.db.execute<{ bezeichnung: string; menge_summe: string; umsatz_cent: string }>(sql`
    SELECT
      pos->>'bezeichnung'                                           AS bezeichnung,
      SUM((pos->>'menge')::int)                                     AS menge_summe,
      SUM((pos->>'menge')::int * (pos->>'einzelpreisBreutto')::int) AS umsatz_cent
    FROM belege,
         jsonb_array_elements(positionen) AS pos
    WHERE kasse_id = ANY(ARRAY[${kasseIdArr}])
      AND beleg_typ IN ('Barzahlungsbeleg','Stornobeleg')
      AND ${datumsBereich(sql`beleg_datum`, filter.von, filter.bis)}
    GROUP BY pos->>'bezeichnung'
    ORDER BY umsatz_cent DESC
    LIMIT ${filter.limit}
  `)

  const zeilen = rows.map(r => ({
    bezeichnung: r.bezeichnung,
    mengeSumme:  parseInt(r.menge_summe, 10),
    umsatzCent:  parseInt(r.umsatz_cent, 10),
  }))

  return { von: filter.von, bis: filter.bis, kasseIds: angefragte, zeilen }
}

// ---------------------------------------------------------------------------
// Warengruppen-Bericht
// ---------------------------------------------------------------------------

export async function holeWarengruppeBericht(
  filter:    ArtikelBerichtFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<WarengruppeBerichtResponse> {
  const alleKassenDesMandanten = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(eq(kassen.mandantId, mandantId))
  const erlaubteIds = new Set(alleKassenDesMandanten.map(k => k.id))

  const angefragte = filter.kasseIds.length > 0 ? filter.kasseIds : [...erlaubteIds]
  const ungueltige = angefragte.filter(id => !erlaubteIds.has(id))
  if (ungueltige.length > 0) throw new BerichtError(404, `Kasse(n) nicht gefunden: ${ungueltige.join(', ')}`)

  if (filter.von > filter.bis) throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')

  const kasseIdArr = sql.join(angefragte.map(id => sql`${id}::uuid`), sql`, `)
  const rows = await deps.db.execute<{ kategorie_name: string; menge_summe: string; umsatz_cent: string }>(sql`
    SELECT
      COALESCE(pos->>'kategorieName', 'Ohne Kategorie')                AS kategorie_name,
      SUM((pos->>'menge')::int)                                         AS menge_summe,
      SUM((pos->>'menge')::int * (pos->>'einzelpreisBreutto')::int)     AS umsatz_cent
    FROM belege,
         jsonb_array_elements(positionen) AS pos
    WHERE kasse_id = ANY(ARRAY[${kasseIdArr}])
      AND beleg_typ IN ('Barzahlungsbeleg','Stornobeleg')
      AND ${datumsBereich(sql`beleg_datum`, filter.von, filter.bis)}
    GROUP BY COALESCE(pos->>'kategorieName', 'Ohne Kategorie')
    ORDER BY umsatz_cent DESC
    LIMIT ${filter.limit}
  `)

  const zeilen = rows.map(r => ({
    kategorieName: r.kategorie_name,
    mengeSumme:    parseInt(r.menge_summe, 10),
    umsatzCent:    parseInt(r.umsatz_cent, 10),
  }))

  return { von: filter.von, bis: filter.bis, kasseIds: angefragte, zeilen }
}

// ---------------------------------------------------------------------------
// Kellner-Bericht
// ---------------------------------------------------------------------------

export async function holeKellnerBericht(
  filter:    KellnerBerichtFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<KellnerBerichtResponse> {
  const alleKassen = await deps.db.select({ id: kassen.id }).from(kassen).where(eq(kassen.mandantId, mandantId))
  const erlaubteIds = new Set(alleKassen.map(k => k.id))
  const angefragte  = filter.kasseIds.length > 0 ? filter.kasseIds : [...erlaubteIds]
  const ungueltige  = angefragte.filter(id => !erlaubteIds.has(id))
  if (ungueltige.length > 0) throw new BerichtError(404, `Kasse(n) nicht gefunden: ${ungueltige.join(', ')}`)
  if (filter.von > filter.bis) throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')

  const kasseIdArr = sql.join(angefragte.map(id => sql`${id}::uuid`), sql`, `)

  type KellnerRow = {
    kellner:        string
    anzahl_belege:  string
    anzahl_stornos: string
    umsatz_cent:    string
    bar_cent:       string
    karte_cent:     string
    sonstige_cent:  string
  }

  const rows = await deps.db.execute<KellnerRow>(sql`
    SELECT
      COALESCE(tt.kellner, 'Direktverkauf')                               AS kellner,
      SUM(CASE WHEN b.beleg_typ = 'Barzahlungsbeleg' THEN 1 ELSE 0 END) AS anzahl_belege,
      SUM(CASE WHEN b.beleg_typ = 'Stornobeleg'      THEN 1 ELSE 0 END) AS anzahl_stornos,
      SUM(b.summe_bar_cent + b.summe_karte_cent + b.summe_sonstige_cent) AS umsatz_cent,
      SUM(b.summe_bar_cent)                                               AS bar_cent,
      SUM(b.summe_karte_cent)                                             AS karte_cent,
      SUM(b.summe_sonstige_cent)                                          AS sonstige_cent
    FROM belege b
    LEFT JOIN tisch_tabs tt ON tt.beleg_id = b.id
    WHERE b.kasse_id = ANY(ARRAY[${kasseIdArr}])
      AND b.beleg_typ IN ('Barzahlungsbeleg', 'Stornobeleg')
      AND ${datumsBereich(sql`b.beleg_datum`, filter.von, filter.bis)}
    GROUP BY COALESCE(tt.kellner, 'Direktverkauf')
    ORDER BY umsatz_cent DESC
  `)

  const zeilen = rows.map(r => ({
    kellner:       r.kellner,
    anzahlBelege:  parseInt(r.anzahl_belege,  10),
    anzahlStornos: parseInt(r.anzahl_stornos, 10),
    umsatzCent:    parseInt(r.umsatz_cent,    10),
    barCent:       parseInt(r.bar_cent,       10),
    karteCent:     parseInt(r.karte_cent,     10),
    sonstigCent:   parseInt(r.sonstige_cent,  10),
  }))

  const gesamt: BerichtGesamt = {
    anzahlBelege:  zeilen.reduce((s, z) => s + z.anzahlBelege,  0),
    anzahlStornos: zeilen.reduce((s, z) => s + z.anzahlStornos, 0),
    umsatzCent:    zeilen.reduce((s, z) => s + z.umsatzCent,    0),
    barCent:       zeilen.reduce((s, z) => s + z.barCent,       0),
    karteCent:     zeilen.reduce((s, z) => s + z.karteCent,     0),
    sonstigCent:   zeilen.reduce((s, z) => s + z.sonstigCent,   0),
    zielCent:              0,
    anzahlZielrechnungen:  0,
    mwst:          [],
  }

  return { von: filter.von, bis: filter.bis, kasseIds: angefragte, zeilen, gesamt }
}

// ---------------------------------------------------------------------------
// Buchungsjournal-Export (DATEV / BMD-kompatibel)
// ---------------------------------------------------------------------------

export async function erstelleBuchungsjournalCsv(
  filter:    BuchungsjournalFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<{ csv: string; dateiname: string; anzahl: number }> {
  const alleKassen = await deps.db.select({ id: kassen.id }).from(kassen).where(eq(kassen.mandantId, mandantId))
  const erlaubteIds = new Set(alleKassen.map(k => k.id))
  const angefragte  = filter.kasseIds.length > 0 ? filter.kasseIds : [...erlaubteIds]
  const ungueltige  = angefragte.filter(id => !erlaubteIds.has(id))
  if (ungueltige.length > 0) throw new BerichtError(404, `Kasse(n) nicht gefunden: ${ungueltige.join(', ')}`)
  if (filter.von > filter.bis) throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')

  const kasseIdArr = sql.join(angefragte.map(id => sql`${id}::uuid`), sql`, `)

  type JournalRow = {
    beleg_nummer:           number
    beleg_datum:            Date
    beleg_typ:              string
    kassen_id:              string
    summe_bar_cent:         number
    summe_karte_cent:       number
    summe_sonstige_cent:    number
    betrag_normal_cent:     number
    betrag_ermaessigt1_cent: number
    betrag_ermaessigt2_cent: number
    betrag_null_cent:       number
    betrag_besonders_cent:  number
  }

  const rows = await deps.db.execute<JournalRow>(sql`
    SELECT
      b.beleg_nummer,
      b.beleg_datum,
      b.beleg_typ,
      k.kassen_id,
      b.summe_bar_cent,
      b.summe_karte_cent,
      b.summe_sonstige_cent,
      b.betrag_normal_cent,
      b.betrag_ermaessigt1_cent,
      b.betrag_ermaessigt2_cent,
      b.betrag_null_cent,
      b.betrag_besonders_cent
    FROM belege b
    JOIN kassen k ON k.id = b.kasse_id
    WHERE b.kasse_id = ANY(ARRAY[${kasseIdArr}])
      AND b.beleg_typ IN ('Barzahlungsbeleg', 'Stornobeleg')
      AND ${datumsBereich(sql`b.beleg_datum`, filter.von, filter.bis)}
    ORDER BY b.beleg_datum, b.beleg_nummer
  `)

  const sep = ';'
  const header = [
    'Datum', 'Belegnummer', 'Belegtyp', 'KassenID',
    'Brutto', 'USt20%_Basis', 'USt20%', 'USt10%_Basis', 'USt10%',
    'USt13%_Basis', 'USt13%', 'Steuerfrei', 'Bar', 'Karte', 'Sonstige',
  ].join(sep)

  const zeilen = rows.map(r => {
    const datum   = new Date(r.beleg_datum).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })
    const brutto  = (r.summe_bar_cent + r.summe_karte_cent + r.summe_sonstige_cent) / 100

    const n20basis  = r.betrag_normal_cent / 100
    const n20ust    = Math.round(r.betrag_normal_cent - r.betrag_normal_cent / 1.20) / 100
    const n10basis  = r.betrag_ermaessigt1_cent / 100
    const n10ust    = Math.round(r.betrag_ermaessigt1_cent - r.betrag_ermaessigt1_cent / 1.10) / 100
    const n13basis  = r.betrag_ermaessigt2_cent / 100
    const n13ust    = Math.round(r.betrag_ermaessigt2_cent - r.betrag_ermaessigt2_cent / 1.13) / 100
    const stfrei    = r.betrag_null_cent / 100

    const fmt = (n: number) => n.toFixed(2).replace('.', ',')

    return [
      datum,
      r.beleg_nummer,
      r.beleg_typ,
      r.kassen_id,
      fmt(brutto),
      fmt(n20basis), fmt(n20ust),
      fmt(n10basis), fmt(n10ust),
      fmt(n13basis), fmt(n13ust),
      fmt(stfrei),
      fmt(r.summe_bar_cent / 100),
      fmt(r.summe_karte_cent / 100),
      fmt(r.summe_sonstige_cent / 100),
    ].join(sep)
  })

  // UTF-8 BOM für Excel-Kompatibilität
  const csv = '﻿' + [header, ...zeilen].join('\r\n')
  const dateiname = `Buchungsjournal-${filter.von}-${filter.bis}.csv`

  return { csv, dateiname, anzahl: rows.length }
}

// ---------------------------------------------------------------------------
// Stunden-Bericht
// ---------------------------------------------------------------------------

export async function holeStundenbericht(
  filter:    StundenBerichtFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<StundenBerichtResponse> {
  const alleKassen = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(eq(kassen.mandantId, mandantId))
  const erlaubteIds = new Set(alleKassen.map(k => k.id))

  const angefragte  = filter.kasseIds.length > 0 ? filter.kasseIds : [...erlaubteIds]
  const ungueltige  = angefragte.filter((id: string) => !erlaubteIds.has(id))
  if (ungueltige.length > 0) {
    throw new BerichtError(404, `Kasse(n) nicht gefunden: ${ungueltige.join(', ')}`)
  }
  if (filter.von > filter.bis) {
    throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')
  }

  const kasseIdArr = sql.join(angefragte.map(id => sql`${id}::uuid`), sql`, `)

  type StundenRow = {
    stunde:         string
    anzahl_belege:  string
    anzahl_stornos: string
    umsatz_cent:    string
    bar_cent:       string
    karte_cent:     string
    sonstige_cent:  string
  }

  const rows = await deps.db.execute<StundenRow>(sql`
    SELECT
      EXTRACT(HOUR FROM (beleg_datum AT TIME ZONE 'Europe/Vienna'))::int    AS stunde,
      SUM(CASE WHEN beleg_typ = 'Barzahlungsbeleg' THEN 1 ELSE 0 END)::int AS anzahl_belege,
      SUM(CASE WHEN beleg_typ = 'Stornobeleg'      THEN 1 ELSE 0 END)::int AS anzahl_stornos,
      SUM(summe_bar_cent + summe_karte_cent + summe_sonstige_cent)::int     AS umsatz_cent,
      SUM(summe_bar_cent)::int                                              AS bar_cent,
      SUM(summe_karte_cent)::int                                            AS karte_cent,
      SUM(summe_sonstige_cent)::int                                         AS sonstige_cent
    FROM belege
    WHERE kasse_id = ANY(ARRAY[${kasseIdArr}])
      AND beleg_typ IN ('Barzahlungsbeleg', 'Stornobeleg')
      AND ${datumsBereich(sql`beleg_datum`, filter.von, filter.bis)}
    GROUP BY stunde
    ORDER BY stunde
  `)

  const stundenMap = new Map<number, StundenBerichtZeile>()
  for (const row of rows) {
    const stunde = parseInt(row.stunde, 10)
    stundenMap.set(stunde, {
      stunde,
      anzahlBelege:  parseInt(row.anzahl_belege,  10),
      anzahlStornos: parseInt(row.anzahl_stornos, 10),
      umsatzCent:    parseInt(row.umsatz_cent,    10),
      barCent:       parseInt(row.bar_cent,       10),
      karteCent:     parseInt(row.karte_cent,     10),
      sonstigCent:   parseInt(row.sonstige_cent,  10),
    })
  }

  const leer: Omit<StundenBerichtZeile, 'stunde'> = {
    anzahlBelege: 0, anzahlStornos: 0,
    umsatzCent: 0, barCent: 0, karteCent: 0, sonstigCent: 0,
  }
  const zeilen: StundenBerichtZeile[] = Array.from({ length: 24 }, (_, i) =>
    stundenMap.get(i) ?? { stunde: i, ...leer }
  )

  const gesamt: BerichtGesamt = {
    anzahlBelege:  zeilen.reduce((s, z) => s + z.anzahlBelege,  0),
    anzahlStornos: zeilen.reduce((s, z) => s + z.anzahlStornos, 0),
    umsatzCent:    zeilen.reduce((s, z) => s + z.umsatzCent,    0),
    barCent:       zeilen.reduce((s, z) => s + z.barCent,       0),
    karteCent:     zeilen.reduce((s, z) => s + z.karteCent,     0),
    sonstigCent:   zeilen.reduce((s, z) => s + z.sonstigCent,   0),
    zielCent:              0,
    anzahlZielrechnungen:  0,
    mwst:          [],   // Stunden-Bericht ohne USt-Aufteilung
  }

  return { von: filter.von, bis: filter.bis, kasseIds: angefragte, zeilen, gesamt }
}

// ---------------------------------------------------------------------------
// Kassen-Vergleich — alle Kassen des Mandanten in einer Abfrage
// ---------------------------------------------------------------------------

export async function holeKassenVergleich(
  filter:    KassenVergleichFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<KassenVergleichResponse> {
  if (filter.von > filter.bis) {
    throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')
  }

  type VergleichRow = {
    kasse_id:       string
    kassen_id:      string
    bezeichnung:    string | null
    anzahl_belege:  string
    anzahl_stornos: string
    umsatz_cent:    string
    bar_cent:       string
    karte_cent:     string
    sonstige_cent:  string
  }

  const rows = await deps.db.execute<VergleichRow>(sql`
    SELECT
      k.id                                                                        AS kasse_id,
      k.kassen_id                                                                 AS kassen_id,
      k.bezeichnung                                                               AS bezeichnung,
      COALESCE(SUM(CASE WHEN b.beleg_typ = 'Barzahlungsbeleg' THEN 1 ELSE 0 END), 0)::int AS anzahl_belege,
      COALESCE(SUM(CASE WHEN b.beleg_typ = 'Stornobeleg'      THEN 1 ELSE 0 END), 0)::int AS anzahl_stornos,
      COALESCE(SUM(b.summe_bar_cent + b.summe_karte_cent + b.summe_sonstige_cent), 0)::int AS umsatz_cent,
      COALESCE(SUM(b.summe_bar_cent),       0)::int                              AS bar_cent,
      COALESCE(SUM(b.summe_karte_cent),     0)::int                              AS karte_cent,
      COALESCE(SUM(b.summe_sonstige_cent),  0)::int                              AS sonstige_cent
    FROM kassen k
    LEFT JOIN belege b
      ON b.kasse_id = k.id
     AND b.beleg_typ IN ('Barzahlungsbeleg', 'Stornobeleg')
     AND ${datumsBereich(sql`b.beleg_datum`, filter.von, filter.bis)}
    WHERE k.mandant_id = ${mandantId}::uuid
    GROUP BY k.id, k.kassen_id, k.bezeichnung
    ORDER BY k.kassen_id
  `)

  const zeilen = rows.map(r => {
    const anzahlBelege = parseInt(r.anzahl_belege, 10)
    const umsatzCent   = parseInt(r.umsatz_cent,   10)
    return {
      kasseId:       r.kasse_id,
      kassenId:      r.kassen_id,
      bezeichnung:   r.bezeichnung,
      anzahlBelege,
      anzahlStornos: parseInt(r.anzahl_stornos, 10),
      umsatzCent,
      barCent:       parseInt(r.bar_cent,       10),
      karteCent:     parseInt(r.karte_cent,     10),
      sonstigCent:   parseInt(r.sonstige_cent,  10),
      avgBonCent:    anzahlBelege > 0 ? Math.round(umsatzCent / anzahlBelege) : 0,
    }
  })

  const gesamt: BerichtGesamt = {
    anzahlBelege:  zeilen.reduce((s, z) => s + z.anzahlBelege,  0),
    anzahlStornos: zeilen.reduce((s, z) => s + z.anzahlStornos, 0),
    umsatzCent:    zeilen.reduce((s, z) => s + z.umsatzCent,    0),
    barCent:       zeilen.reduce((s, z) => s + z.barCent,       0),
    karteCent:     zeilen.reduce((s, z) => s + z.karteCent,     0),
    sonstigCent:   zeilen.reduce((s, z) => s + z.sonstigCent,   0),
    zielCent:              0,
    anzahlZielrechnungen:  0,
    mwst:          [],
  }

  return { von: filter.von, bis: filter.bis, zeilen, gesamt }
}

// ---------------------------------------------------------------------------
// Küchen-Bericht: KDS-Durchlaufzeiten (erstellt → erledigt) je Station/Artikel
// ---------------------------------------------------------------------------

export async function holeKuechenBericht(
  filter:    KuechenBerichtFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<KuechenBerichtResponse> {
  if (filter.von > filter.bis) {
    throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')
  }

  // Gemeinsamer Zeitraum-Filter: Bon-Erstellung am Wiener Kalendertag
  const zeitraum = datumsBereich(sql`erstellt_at`, filter.von, filter.bis)

  type StationRow = {
    station: string; anzahl: string; avg_min: string; median_min: string; max_min: string
  }
  const stationRows = await deps.db.execute<StationRow>(sql`
    SELECT
      station,
      COUNT(*)::int                                                                          AS anzahl,
      (AVG(EXTRACT(EPOCH FROM (erledigt_at - erstellt_at))) / 60)::numeric(10,1)             AS avg_min,
      (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (erledigt_at - erstellt_at))) / 60)::numeric(10,1) AS median_min,
      (MAX(EXTRACT(EPOCH FROM (erledigt_at - erstellt_at))) / 60)::numeric(10,1)             AS max_min
    FROM kds_bons
    WHERE mandant_id = ${mandantId}
      AND status = 'erledigt' AND erledigt_at IS NOT NULL
      AND ${zeitraum}
    GROUP BY station
    ORDER BY anzahl DESC
  `)

  type ArtikelRow = { bezeichnung: string; anzahl: string; avg_min: string }
  const artikelRows = await deps.db.execute<ArtikelRow>(sql`
    SELECT
      pos->>'bezeichnung'                                                        AS bezeichnung,
      SUM(COALESCE((pos->>'menge')::int, 1))::int                                AS anzahl,
      (AVG(EXTRACT(EPOCH FROM (erledigt_at - erstellt_at))) / 60)::numeric(10,1) AS avg_min
    FROM kds_bons, jsonb_array_elements(positionen) AS pos
    WHERE mandant_id = ${mandantId}
      AND status = 'erledigt' AND erledigt_at IS NOT NULL
      AND ${zeitraum}
    GROUP BY pos->>'bezeichnung'
    ORDER BY anzahl DESC, bezeichnung
    LIMIT 15
  `)

  type StundenRow = { stunde: string; anzahl: string }
  const stundenRows = await deps.db.execute<StundenRow>(sql`
    SELECT
      EXTRACT(HOUR FROM (erstellt_at AT TIME ZONE 'Europe/Vienna'))::int AS stunde,
      COUNT(*)::int                                                      AS anzahl
    FROM kds_bons
    WHERE mandant_id = ${mandantId}
      AND ${zeitraum}
    GROUP BY stunde
    ORDER BY stunde
  `)

  type OffenRow = { anzahl: string }
  const offenRows = await deps.db.execute<OffenRow>(sql`
    SELECT COUNT(*)::int AS anzahl
    FROM kds_bons
    WHERE mandant_id = ${mandantId} AND status = 'offen' AND ${zeitraum}
  `)

  const stationen = [...stationRows].map(r => ({
    station:       r.station,
    anzahlBons:    parseInt(r.anzahl, 10),
    avgMinuten:    parseFloat(r.avg_min),
    medianMinuten: parseFloat(r.median_min),
    maxMinuten:    parseFloat(r.max_min),
  }))

  const gesamtBons = stationen.reduce((s, z) => s + z.anzahlBons, 0)
  const avgMinutenGesamt = gesamtBons > 0
    ? Math.round(stationen.reduce((s, z) => s + z.avgMinuten * z.anzahlBons, 0) / gesamtBons * 10) / 10
    : 0

  return {
    von: filter.von,
    bis: filter.bis,
    gesamtBons,
    avgMinutenGesamt,
    offeneBons: parseInt([...offenRows][0]?.anzahl ?? '0', 10),
    stationen,
    topArtikel: [...artikelRows].map(r => ({
      bezeichnung: r.bezeichnung,
      anzahl:      parseInt(r.anzahl, 10),
      avgMinuten:  parseFloat(r.avg_min),
    })),
    stunden: [...stundenRows].map(r => ({
      stunde:     parseInt(r.stunde, 10),
      anzahlBons: parseInt(r.anzahl, 10),
    })),
  }
}
