/**
 * Umsatzbericht-Service
 *
 * Lädt Barzahlungs- und Stornobelege eines flexiblen Zeitraums und
 * aggregiert sie nach Tag, Kalenderwoche oder Monat (Wiener Ortszeit).
 *
 * Datum-Filter: AT TIME ZONE 'Europe/Vienna' direkt in PostgreSQL.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm'
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
  type KellnerBerichtFilter,
  type KellnerBerichtResponse,
  type MwStSatz,
  type StundenBerichtFilter,
  type StundenBerichtResponse,
  type StundenBerichtZeile,
  type WarengruppeBerichtResponse,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { belege, kassen, tischTabs } from '../db/schema.js'

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

  // Belege laden
  const whereKlauses = [
    inArray(belege.kasseId, kasseIds),
    inArray(belege.belegTyp, ['Barzahlungsbeleg', 'Stornobeleg']),
    sql`(${belege.belegDatum} at time zone 'Europe/Vienna')::date
        between ${filter.von}::date and ${filter.bis}::date`,
  ]
  if (filter.nurZielrechnungen) {
    whereKlauses.push(ne(belege.summeSonstigeCent, 0))
  }

  const rows = await deps.db
    .select({
      belegTyp:              belege.belegTyp,
      belegDatum:            belege.belegDatum,
      summeBarCent:          belege.summeBarCent,
      summeKarteCent:        belege.summeKarteCent,
      summeSonstigeCent:     belege.summeSonstigeCent,
      betragNormalCent:      belege.betragNormalCent,
      betragErmaessigt1Cent: belege.betragErmaessigt1Cent,
      betragErmaessigt2Cent: belege.betragErmaessigt2Cent,
      betragNullCent:        belege.betragNullCent,
      betragBesondersCent:   belege.betragBesondersCent,
    })
    .from(belege)
    .where(and(...whereKlauses))
    .orderBy(belege.belegDatum)

  // Perioden-Schlüssel berechnen
  const periodeMap = new Map<string, BerichtZeile>()

  // Globale MwSt-Summen
  const mwstGesamt: Record<MwStSatz, number> = {
    normal: 0, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 0,
  }

  for (const row of rows) {
    const periode = getPeriodeKey(row.belegDatum, filter.gruppierung)
    const umsatz  = row.summeBarCent + row.summeKarteCent + row.summeSonstigeCent

    let zeile = periodeMap.get(periode)
    if (!zeile) {
      zeile = {
        periode,
        anzahlBelege:  0,
        anzahlStornos: 0,
        umsatzCent:    0,
        barCent:       0,
        karteCent:     0,
        sonstigCent:   0,
      }
      periodeMap.set(periode, zeile)
    }

    if (row.belegTyp === 'Barzahlungsbeleg') zeile.anzahlBelege++
    if (row.belegTyp === 'Stornobeleg')      zeile.anzahlStornos++
    zeile.umsatzCent  += umsatz
    zeile.barCent     += row.summeBarCent
    zeile.karteCent   += row.summeKarteCent
    zeile.sonstigCent += row.summeSonstigeCent

    mwstGesamt.normal      += row.betragNormalCent
    mwstGesamt.ermaessigt1 += row.betragErmaessigt1Cent
    mwstGesamt.ermaessigt2 += row.betragErmaessigt2Cent
    mwstGesamt.null        += row.betragNullCent
    mwstGesamt.besonders   += row.betragBesondersCent
  }

  // Zeilen sortiert (Schlüssel sind lexikographisch sortierbar)
  const zeilen = [...periodeMap.values()].sort((a, b) => a.periode.localeCompare(b.periode))

  // Gesamt berechnen
  const gesamt: BerichtGesamt = {
    anzahlBelege:  zeilen.reduce((s, z) => s + z.anzahlBelege, 0),
    anzahlStornos: zeilen.reduce((s, z) => s + z.anzahlStornos, 0),
    umsatzCent:    zeilen.reduce((s, z) => s + z.umsatzCent, 0),
    barCent:       zeilen.reduce((s, z) => s + z.barCent, 0),
    karteCent:     zeilen.reduce((s, z) => s + z.karteCent, 0),
    sonstigCent:   zeilen.reduce((s, z) => s + z.sonstigCent, 0),
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
      AND (beleg_datum AT TIME ZONE 'Europe/Vienna')::date
          BETWEEN ${filter.von}::date AND ${filter.bis}::date
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
      AND (beleg_datum AT TIME ZONE 'Europe/Vienna')::date
          BETWEEN ${filter.von}::date AND ${filter.bis}::date
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
      AND (b.beleg_datum AT TIME ZONE 'Europe/Vienna')::date
          BETWEEN ${filter.von}::date AND ${filter.bis}::date
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
      AND (b.beleg_datum AT TIME ZONE 'Europe/Vienna')::date
          BETWEEN ${filter.von}::date AND ${filter.bis}::date
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
// Perioden-Schlüssel (Wiener Ortszeit)
// ---------------------------------------------------------------------------

function getPeriodeKey(
  datum:        Date,
  gruppierung:  'tag' | 'woche' | 'monat',
): string {
  // Datum in Wiener Ortszeit als YYYY-MM-DD
  const lokal = datum.toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
  if (gruppierung === 'tag')   return lokal
  if (gruppierung === 'monat') return lokal.slice(0, 7) // YYYY-MM
  // Kalenderwoche (ISO 8601)
  const d = new Date(lokal)
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7) // Donnerstag dieser Woche
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const kw   = 1 + Math.round(
    ((d.valueOf() - jan4.valueOf()) / 86_400_000 - 3 + (jan4.getDay() + 6) % 7) / 7
  )
  return `${d.getFullYear()}-KW${kw.toString().padStart(2, '0')}`
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
      AND (beleg_datum AT TIME ZONE 'Europe/Vienna')::date
          BETWEEN ${filter.von}::date AND ${filter.bis}::date
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
     AND (b.beleg_datum AT TIME ZONE 'Europe/Vienna')::date
         BETWEEN ${filter.von}::date AND ${filter.bis}::date
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
    mwst:          [],
  }

  return { von: filter.von, bis: filter.bis, zeilen, gesamt }
}
