/**
 * Gegenprobe zur SQL-Aggregation: rechnet den Umsatzbericht unabhängig noch
 * einmal in JavaScript nach — genau so, wie es der Service vor v0.7.141 tat —
 * und vergleicht Zeile für Zeile.
 *
 * Läuft gegen die Lasttest-Datenbank (54 750 Belege), damit auch die
 * Kalenderwochen über einen Jahreswechsel abgedeckt sind.
 *
 *   pnpm --filter @kassa/backend vergleiche-bericht
 */

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { schema, type Db } from '../src/db/client.js'
import { holeUmsatzbericht } from '../src/services/bericht.service.js'
import type { BerichtGruppierung } from '@kassa/shared'

const BASIS_URL = process.env.DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'
const DB_NAME   = process.env.LASTTEST_DB ?? 'kassa_lasttest'

/** Die ALTE Perioden-Berechnung, unverändert übernommen. */
function getPeriodeKeyAlt(datum: Date, gruppierung: BerichtGruppierung): string {
  const lokal = datum.toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
  if (gruppierung === 'tag')   return lokal
  if (gruppierung === 'monat') return lokal.slice(0, 7)
  const d = new Date(lokal)
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7)
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const kw   = 1 + Math.round(
    ((d.valueOf() - jan4.valueOf()) / 86_400_000 - 3 + (jan4.getDay() + 6) % 7) / 7,
  )
  return `${d.getFullYear()}-KW${kw.toString().padStart(2, '0')}`
}

async function main(): Promise<void> {
  const url = new URL(BASIS_URL)
  url.pathname = `/${DB_NAME}`
  const sql = postgres(url.toString(), { max: 4, fetch_types: false })
  const db  = drizzle(sql, { schema }) as unknown as Db

  const [kasse] = await sql<{ id: string; mandant_id: string }[]>`
    SELECT id, mandant_id FROM kassen LIMIT 1`
  if (!kasse) throw new Error(`Keine Kasse in ${DB_NAME} — erst "pnpm lasttest" laufen lassen.`)

  const [{ von, bis }] = await sql<{ von: string; bis: string }[]>`
    SELECT to_char(min(beleg_datum) AT TIME ZONE 'Europe/Vienna', 'YYYY-MM-DD') AS von,
           to_char(max(beleg_datum) AT TIME ZONE 'Europe/Vienna', 'YYYY-MM-DD') AS bis
      FROM belege`

  // Rohdaten einmal laden und in JS aggregieren (der alte Weg)
  const roh = await sql<{
    beleg_datum: Date; beleg_typ: string
    summe_bar_cent: number; summe_karte_cent: number; summe_sonstige_cent: number
  }[]>`
    SELECT beleg_datum, beleg_typ, summe_bar_cent, summe_karte_cent, summe_sonstige_cent
      FROM belege
     WHERE kasse_id = ${kasse.id}::uuid
       AND beleg_typ IN ('Barzahlungsbeleg','Stornobeleg')
       AND (beleg_datum AT TIME ZONE 'Europe/Vienna')::date
           BETWEEN ${von}::date AND ${bis}::date`

  let fehler = 0
  for (const gruppierung of ['tag', 'woche', 'monat'] as BerichtGruppierung[]) {
    const erwartet = new Map<string, { belege: number; stornos: number; umsatz: number; bar: number }>()
    for (const r of roh) {
      const k = getPeriodeKeyAlt(new Date(r.beleg_datum), gruppierung)
      const e = erwartet.get(k) ?? { belege: 0, stornos: 0, umsatz: 0, bar: 0 }
      if (r.beleg_typ === 'Barzahlungsbeleg') e.belege++
      if (r.beleg_typ === 'Stornobeleg')      e.stornos++
      e.umsatz += r.summe_bar_cent + r.summe_karte_cent + r.summe_sonstige_cent
      e.bar    += r.summe_bar_cent
      erwartet.set(k, e)
    }

    const neu = await holeUmsatzbericht(
      { kasseIds: [kasse.id], von, bis, gruppierung, nurZielrechnungen: false },
      kasse.mandant_id, { db },
    )

    const abweichungen: string[] = []
    if (neu.zeilen.length !== erwartet.size) {
      abweichungen.push(`Zeilenzahl ${neu.zeilen.length} statt ${erwartet.size}`)
    }
    for (const z of neu.zeilen) {
      const e = erwartet.get(z.periode)
      if (!e) { abweichungen.push(`Periode ${z.periode} gibt es alt nicht`); continue }
      if (z.anzahlBelege  !== e.belege)  abweichungen.push(`${z.periode}: Belege ${z.anzahlBelege} statt ${e.belege}`)
      if (z.anzahlStornos !== e.stornos) abweichungen.push(`${z.periode}: Stornos ${z.anzahlStornos} statt ${e.stornos}`)
      if (z.umsatzCent    !== e.umsatz)  abweichungen.push(`${z.periode}: Umsatz ${z.umsatzCent} statt ${e.umsatz}`)
      if (z.barCent       !== e.bar)     abweichungen.push(`${z.periode}: Bar ${z.barCent} statt ${e.bar}`)
    }

    if (abweichungen.length === 0) {
      console.log(`✓ ${gruppierung.padEnd(6)} ${neu.zeilen.length} Perioden, Gesamtumsatz ${neu.gesamt.umsatzCent} — identisch`)
    } else {
      fehler++
      console.log(`✗ ${gruppierung}: ${abweichungen.length} Abweichung(en)`)
      abweichungen.slice(0, 8).forEach(a => console.log(`    ${a}`))
    }
  }

  await sql.end()
  if (fehler > 0) process.exit(1)
  console.log('\nSQL-Aggregation liefert dieselben Zahlen wie die alte JS-Berechnung.')
}

main().catch((err) => { console.error(err); process.exit(1) })
