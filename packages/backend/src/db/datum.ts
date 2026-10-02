/**
 * Datumsfilter auf timestamptz-Spalten (Wiener Ortszeit, Geschäftstag).
 *
 * NICHT `(spalte AT TIME ZONE 'Europe/Vienna')::date BETWEEN …` verwenden: ein
 * Ausdruck AUF der Spalte macht den Index unbrauchbar, Postgres fällt auf einen
 * Seq Scan über die ganze Tabelle zurück. An 54 750 Belegen nachgemessen —
 * Tagesabschluss-Abfrage für einen einzelnen Tag:
 *
 *   alt  Seq Scan, 54 600 Zeilen verworfen, 2 282 Blöcke → 27,5 ms
 *   neu  Index Scan,                             2 Blöcke →  0,38 ms
 *
 * Und das wächst linear mit dem Datenbestand: der Seq Scan liest immer die
 * ganze Tabelle, der Index Scan nur den gesuchten Tag.
 *
 * Stattdessen die Wiener Tagesgrenzen einmal als Zeitpunkte berechnen und
 * direkt gegen die Spalte vergleichen. Sommer-/Winterzeit rechnet Postgres
 * dabei korrekt um — auch an den 23- und 25-Stunden-Tagen.
 *
 * GESCHÄFTSTAG: Der „Tag" eines Mandanten kann statt um 00:00 z. B. um 06:00
 * beginnen (siehe @kassa/shared, geschaeftstag.ts). Mit einer `regel` (der
 * Tagesbeginn-Historie des Mandanten) verschieben sich die Grenzen — als
 * Konstanten gegen die Spalte, also weiterhin index-tauglich. Ohne `regel`
 * (oder bei Tagesbeginn 00:00) entsteht exakt derselbe SQL-Text wie früher.
 */

import { sql, type SQL } from 'drizzle-orm'
import {
  STANDARD_TAGESBEGINN,
  addTage,
  beginnFuer,
  istStandardRegel,
  type TagesRegel,
} from '@kassa/shared'

/**
 * Zeitraum von Tagesbeginn `von` bis Tagesende `bis`, beide Tage inklusive.
 *
 * `bis` ist inklusiv, deshalb +1 Tag als offene Obergrenze — so gehört
 * 23:59:59 noch dazu, der Folgetag um 00:00:00 aber nicht mehr. Mit
 * verschobenem Tagesbeginn: von = `von` um den dort geltenden Beginn, bis =
 * Beginn des Tags NACH `bis` (um dessen Beginn) — lückenlos, auch über einen
 * Wechsel des Tagesbeginns hinweg.
 *
 * Die äußeren Klammern sind Pflicht: drizzles `and(...)` verkettet Fragmente
 * nur mit " and ", ohne sie einzeln zu klammern. Ohne Klammern bräche ein
 * späteres OR aus der Verknüpfung aus (siehe v0.7.139).
 *
 * @param spalte timestamptz-Spalte, als sql-Fragment
 * @param von    Geschäftstag YYYY-MM-DD, inklusive
 * @param bis    Geschäftstag YYYY-MM-DD, inklusive
 * @param regel  Tagesbeginn-Historie des Mandanten (leer/weggelassen = 00:00)
 */
export function datumsBereich(spalte: SQL, von: string, bis: string, regel: TagesRegel = []): SQL {
  const beginnVon  = beginnFuer(regel, von)
  const beginnEnde = beginnFuer(regel, addTage(bis, 1))

  if (beginnVon === STANDARD_TAGESBEGINN && beginnEnde === STANDARD_TAGESBEGINN) {
    // Kalendertage — unverändert der bisherige Ausdruck
    return sql`(${spalte} >= (${von}::date)::timestamp at time zone 'Europe/Vienna'
          AND ${spalte} <  (${bis}::date + 1)::timestamp at time zone 'Europe/Vienna')`
  }

  // date + time → timestamp (Wiener Wanduhr), at time zone → timestamptz
  return sql`(${spalte} >= (${von}::date + ${beginnVon}::time) at time zone 'Europe/Vienna'
          AND ${spalte} <  ((${bis}::date + 1) + ${beginnEnde}::time) at time zone 'Europe/Vienna')`
}

/** Ein einzelner Geschäftstag — Kurzform von {@link datumsBereich}. */
export function tagesBereich(spalte: SQL, datum: string, regel: TagesRegel = []): SQL {
  return datumsBereich(spalte, datum, datum, regel)
}

/**
 * Wiener Kalendertag eines timestamptz-Ausdrucks als date — der Geschäftstag
 * bei Tagesbeginn 00:00.
 */
function kalendertagAusdruck(spalte: SQL): SQL {
  return sql`((${spalte}) at time zone 'Europe/Vienna')::date`
}

/**
 * Tagesbeginn (Typ time), der am Kalendertag `kalendertag` gilt — verschachteltes
 * CASE über die Historie, neuester Stichtag zuerst. Spiegelbild von
 * `beginnFuer` aus @kassa/shared.
 */
function beginnAusdruck(kalendertag: SQL, regel: TagesRegel): SQL {
  const absteigend = [...regel].sort((a, b) => (a.gueltigAb < b.gueltigAb ? 1 : a.gueltigAb > b.gueltigAb ? -1 : 0))
  const zweige = absteigend.map(e => sql`WHEN ${kalendertag} >= ${e.gueltigAb}::date THEN ${e.beginn}::time`)
  return sql`(CASE ${sql.join(zweige, sql` `)} ELSE ${STANDARD_TAGESBEGINN}::time END)`
}

/**
 * Geschäftstag (Typ date) eines timestamptz-Ausdrucks — für Gruppierungen
 * (Tag/Woche/Monat des GESCHÄFTSTAGS, damit Tages- und Monatssummen zusammenpassen).
 *
 * Wie `geschaeftstagVon` aus @kassa/shared: ein Zeitpunkt am Wiener Kalendertag
 * W gehört zu W, wenn er ab dem Beginn von W liegt, sonst noch zum Vortag. Der
 * Vergleich läuft über Zeitpunkte (timestamptz), nicht über Uhrzeiten — nur so
 * stimmt er mit den Grenzen aus {@link datumsBereich} überein, auch in der
 * Stunde der Zeitumstellung.
 *
 * Ohne verschobenen Tagesbeginn ist das schlicht der Wiener Kalendertag.
 */
export function geschaeftstagAusdruck(spalte: SQL, regel: TagesRegel = []): SQL {
  const kalendertag = kalendertagAusdruck(spalte)
  if (istStandardRegel(regel)) return kalendertag

  const beginn = beginnAusdruck(kalendertag, regel)
  return sql`(CASE WHEN ${spalte} >= ((${kalendertag} + ${beginn}) at time zone 'Europe/Vienna')
                   THEN ${kalendertag} ELSE ${kalendertag} - 1 END)`
}
