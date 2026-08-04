/**
 * Datumsfilter auf timestamptz-Spalten (Wiener Ortszeit).
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
 */

import { sql, type SQL } from 'drizzle-orm'

/**
 * Zeitraum von Tagesbeginn `von` bis Tagesende `bis`, beide Tage inklusive.
 *
 * `bis` ist inklusiv, deshalb +1 Tag als offene Obergrenze — so gehört
 * 23:59:59 noch dazu, der Folgetag um 00:00:00 aber nicht mehr.
 *
 * Die äußeren Klammern sind Pflicht: drizzles `and(...)` verkettet Fragmente
 * nur mit " and ", ohne sie einzeln zu klammern. Ohne Klammern bräche ein
 * späteres OR aus der Verknüpfung aus (siehe v0.7.139).
 *
 * @param spalte timestamptz-Spalte, als sql-Fragment
 * @param von    Wiener Kalendertag YYYY-MM-DD, inklusive
 * @param bis    Wiener Kalendertag YYYY-MM-DD, inklusive
 */
export function datumsBereich(spalte: SQL, von: string, bis: string): SQL {
  return sql`(${spalte} >= (${von}::date)::timestamp at time zone 'Europe/Vienna'
          AND ${spalte} <  (${bis}::date + 1)::timestamp at time zone 'Europe/Vienna')`
}

/** Ein einzelner Wiener Kalendertag — Kurzform von {@link datumsBereich}. */
export function tagesBereich(spalte: SQL, datum: string): SQL {
  return datumsBereich(spalte, datum, datum)
}
