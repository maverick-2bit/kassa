/**
 * Datumsfilter + Geschäftstag-SQL (db/datum.ts) und Abschlusstag-Regel.
 *
 * Die SQL-Texte werden hier OHNE Datenbank gerendert (PgDialect): der Standardfall
 * (Tagesbeginn 00:00) muss exakt derselbe Text bleiben wie vor der Einführung des
 * Geschäftstags — das ist die Regressions-Absicherung „alles Bestehende verhält
 * sich unverändert". Das Verhalten gegen echtes PostgreSQL deckt
 * tests/integration/geschaeftstag.test.ts ab.
 */

import { describe, it, expect } from 'vitest'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { TagesRegel } from '@kassa/shared'
import { datumsBereich, geschaeftstagAusdruck, tagesBereich } from '../src/db/datum.js'
import { bestimmeAbschlussTag } from '../src/services/auto-abschluss.service.js'

const dialekt = new PgDialect()
const render = (q: SQL) => dialekt.sqlToQuery(q)

/** Der Ausdruck VOR der Einführung des Geschäftstags, wörtlich (git: v0.8.34, db/datum.ts) */
const ALTER_TEXT =
`(b.beleg_datum >= ($1::date)::timestamp at time zone 'Europe/Vienna'
          AND b.beleg_datum <  ($2::date + 1)::timestamp at time zone 'Europe/Vienna')`

const SECHS_UHR: TagesRegel = [{ gueltigAb: '2026-01-01', beginn: '06:00' }]

describe('datumsBereich — Standard (Tagesbeginn 00:00) bleibt wörtlich wie früher', () => {
  it('ohne Regel: exakt der alte SQL-Text mit denselben Parametern', () => {
    const q = render(datumsBereich(sql`b.beleg_datum`, '2026-10-01', '2026-10-31'))
    expect(q.sql).toBe(ALTER_TEXT)
    expect(q.params).toEqual(['2026-10-01', '2026-10-31'])
  })

  it('leere Regel und Regel nur mit 00:00 → ebenfalls der alte Text', () => {
    expect(render(datumsBereich(sql`b.beleg_datum`, '2026-10-01', '2026-10-31', [])).sql).toBe(ALTER_TEXT)
    const nurMitternacht: TagesRegel = [{ gueltigAb: '2026-01-01', beginn: '00:00' }]
    expect(render(datumsBereich(sql`b.beleg_datum`, '2026-10-01', '2026-10-31', nurMitternacht)).sql).toBe(ALTER_TEXT)
  })

  it('tagesBereich ist von = bis', () => {
    const q = render(tagesBereich(sql`b.beleg_datum`, '2026-10-02'))
    expect(q.sql).toBe(ALTER_TEXT)
    expect(q.params).toEqual(['2026-10-02', '2026-10-02'])
  })

  it('Regel erst NACH dem Zeitraum (Stichtag liegt dahinter): immer noch der alte Text', () => {
    const spaeter: TagesRegel = [{ gueltigAb: '2027-01-01', beginn: '06:00' }]
    // bis + 1 = 2026-12-01 < Stichtag → beide Grenzen bei 00:00
    expect(render(datumsBereich(sql`b.beleg_datum`, '2026-11-01', '2026-11-30', spaeter)).sql).toBe(ALTER_TEXT)
  })
})

describe('datumsBereich — verschobener Tagesbeginn', () => {
  it('Grenzen sind Konstanten gegen die nackte Spalte (index-tauglich)', () => {
    const q = render(datumsBereich(sql`b.beleg_datum`, '2026-10-01', '2026-10-31', SECHS_UHR))
    // Die Spalte steht genau zweimal da, jeweils unmittelbar vor dem Vergleichsoperator —
    // kein Funktionsausdruck AUF der Spalte (sonst Seq Scan statt Index Scan)
    expect(q.sql.match(/b\.beleg_datum/g)).toHaveLength(2)
    expect(q.sql).toMatch(/\(b\.beleg_datum >= /)
    expect(q.sql).toMatch(/AND b\.beleg_datum <  /)
    expect(q.sql).not.toMatch(/\(b\.beleg_datum at time zone/i)
    expect(q.sql).not.toMatch(/\(b\.beleg_datum\)/)
    // Beginn als time-Parameter: von-Tag 06:00, Tag NACH bis um 06:00
    expect(q.params).toEqual(['2026-10-01', '06:00', '2026-10-31', '06:00'])
    expect(q.sql).toContain('$2::time')
    expect(q.sql).toContain('$4::time')
  })

  it('über einen Wechsel hinweg: untere und obere Grenze nutzen den Beginn des jeweiligen Tages', () => {
    const wechsel: TagesRegel = [
      { gueltigAb: '2026-01-01', beginn: '06:00' },
      { gueltigAb: '2026-11-03', beginn: '00:00' },
    ]
    // Zeitraum 01.11.–02.11.: von = 01.11. um 06:00, bis+1 = 03.11. → ab da 00:00
    expect(render(datumsBereich(sql`x`, '2026-11-01', '2026-11-02', wechsel)).params)
      .toEqual(['2026-11-01', '06:00', '2026-11-02', '00:00'])
  })
})

describe('geschaeftstagAusdruck', () => {
  it('Standard: der Wiener Kalendertag, ohne CASE', () => {
    const q = render(geschaeftstagAusdruck(sql`b.beleg_datum`, []))
    expect(q.sql).toBe(`((b.beleg_datum) at time zone 'Europe/Vienna')::date`)
    expect(q.params).toEqual([])
  })

  it('Tagesbeginn 06:00: Vergleich über Zeitpunkte, Vortag, wenn vor dem Beginn', () => {
    const q = render(geschaeftstagAusdruck(sql`b.beleg_datum`, SECHS_UHR))
    expect(q.sql).toContain('CASE WHEN b.beleg_datum >=')
    expect(q.sql).toContain(`at time zone 'Europe/Vienna'`)
    expect(q.sql).toContain('- 1 END')
    expect(q.params).toContain('06:00')
    expect(q.params).toContain('2026-01-01')
  })

  it('Historie: neuester Stichtag zuerst, ältester zuletzt, Rest 00:00', () => {
    const regel: TagesRegel = [
      { gueltigAb: '2026-01-01', beginn: '04:00' },
      { gueltigAb: '2026-11-03', beginn: '06:00' },
    ]
    const q = render(geschaeftstagAusdruck(sql`t`, regel))
    const iNeu = q.params.indexOf('2026-11-03')
    const iAlt = q.params.indexOf('2026-01-01')
    expect(iNeu).toBeGreaterThanOrEqual(0)
    expect(iAlt).toBeGreaterThan(iNeu)
    expect(q.params).toContain('00:00')   // ELSE-Zweig
  })
})

// ---------------------------------------------------------------------------
// Abschlusstag
// ---------------------------------------------------------------------------

/** Die Regel VOR dem Geschäftstag, wörtlich (auto-abschluss.service.ts, v0.8.34) */
function alterAbschlussTag(uhrzeit: string, wienDatum: string): string {
  const vortag = (d: string) => {
    const [j, m, t] = d.split('-').map(Number)
    return new Date(Date.UTC(j!, m! - 1, t! - 1)).toISOString().slice(0, 10)
  }
  return uhrzeit < '12:00' ? vortag(wienDatum) : wienDatum
}

describe('bestimmeAbschlussTag', () => {
  const alleUhrzeiten = Array.from({ length: 24 * 60 }, (_, i) =>
    `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`)
  const tage = ['2026-01-01', '2026-02-28', '2026-03-01', '2026-03-29', '2026-07-26', '2026-10-25', '2026-12-31', '2028-02-29']

  it('mit Tagesbeginn 00:00 identisch zum bisherigen Verhalten — für JEDE Minute des Tages (Regel leer, nur 00:00)', () => {
    const nurMitternacht: TagesRegel = [{ gueltigAb: '2000-01-01', beginn: '00:00' }]
    for (const tag of tage) {
      for (const uhrzeit of alleUhrzeiten) {
        const erwartet = alterAbschlussTag(uhrzeit, tag)
        expect(bestimmeAbschlussTag(uhrzeit, tag)).toBe(erwartet)
        expect(bestimmeAbschlussTag(uhrzeit, tag, [])).toBe(erwartet)
        expect(bestimmeAbschlussTag(uhrzeit, tag, nurMitternacht)).toBe(erwartet)
      }
    }
  })

  it('Tagesbeginn 06:00, Abschluss ab 12:00 → der laufende Geschäftstag (= aktuelles Datum)', () => {
    expect(bestimmeAbschlussTag('12:00', '2026-10-02', SECHS_UHR)).toBe('2026-10-02')
    expect(bestimmeAbschlussTag('23:30', '2026-10-02', SECHS_UHR)).toBe('2026-10-02')
  })

  it('Tagesbeginn 06:00, Abschluss vor 12:00 UND ab 06:00 → der Vortag (schon zu Ende)', () => {
    expect(bestimmeAbschlussTag('06:00', '2026-10-02', SECHS_UHR)).toBe('2026-10-01')
    expect(bestimmeAbschlussTag('08:30', '2026-10-02', SECHS_UHR)).toBe('2026-10-01')
    expect(bestimmeAbschlussTag('11:59', '2026-10-02', SECHS_UHR)).toBe('2026-10-01')
  })

  it('Tagesbeginn 06:00, Abschluss VOR 06:00 → der Geschäftstag läuft noch (= der Vortag als Datum)', () => {
    expect(bestimmeAbschlussTag('05:59', '2026-10-02', SECHS_UHR)).toBe('2026-10-01')
    expect(bestimmeAbschlussTag('04:00', '2026-10-02', SECHS_UHR)).toBe('2026-10-01')
    expect(bestimmeAbschlussTag('00:00', '2026-10-02', SECHS_UHR)).toBe('2026-10-01')
  })

  it('Monats- und Jahreswechsel', () => {
    expect(bestimmeAbschlussTag('08:00', '2027-01-01', SECHS_UHR)).toBe('2026-12-31')
    expect(bestimmeAbschlussTag('04:00', '2027-01-01', SECHS_UHR)).toBe('2026-12-31')
    expect(bestimmeAbschlussTag('23:00', '2027-01-01', SECHS_UHR)).toBe('2027-01-01')
  })

  it('am Stichtag des Wechsels (00:00 → 06:00 ab 03.11.): Abschluss um 03:00 schließt den langen Übergangstag', () => {
    const regel: TagesRegel = [{ gueltigAb: '2026-11-03', beginn: '06:00' }]
    // 03.11. 03:00 liegt noch im Geschäftstag 02.11. (der geht bis 03.11. 06:00)
    expect(bestimmeAbschlussTag('03:00', '2026-11-03', regel)).toBe('2026-11-02')
    // am Tag davor: Standard-Regel — vor 12:00 der Vortag
    expect(bestimmeAbschlussTag('03:00', '2026-11-02', regel)).toBe('2026-11-01')
    // danach: 06:00-Regel
    expect(bestimmeAbschlussTag('08:00', '2026-11-04', regel)).toBe('2026-11-03')
  })
})
