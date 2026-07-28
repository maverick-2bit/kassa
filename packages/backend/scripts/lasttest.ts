/**
 * Lasttest für Berichte und Listen.
 *
 * Legt eine eigene Datenbank an (Standard: kassa_lasttest), füllt sie mit einem
 * Jahr realistischer Belege und misst Laufzeit + Heap der Berichts-Aufrufe.
 * Die Entwicklungs-Datenbank wird dabei NICHT angefasst.
 *
 * Aufruf:
 *   pnpm --filter @kassa/backend lasttest              # neu aufbauen + messen
 *   pnpm --filter @kassa/backend lasttest -- --reuse   # vorhandene Daten messen
 *   pnpm --filter @kassa/backend lasttest -- --tage=730 --pro-tag=200
 *
 * Die erzeugten Belege tragen Platzhalter-Signaturen. Für Berichte, die nur
 * aggregieren, ist das egal — RKSV-Prüfungen gehören in die Integrationstests.
 */

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { schema, type Db } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { holeUmsatzbericht, holeArtikelBericht, holeKassenVergleich } from '../src/services/bericht.service.js'
import type { BerichtGruppierung } from '@kassa/shared'

const BASIS_URL = process.env.DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'
const DB_NAME   = process.env.LASTTEST_DB ?? 'kassa_lasttest'

const arg = (name: string, standard: number): number => {
  const treffer = process.argv.find(a => a.startsWith(`--${name}=`))
  return treffer ? Number(treffer.split('=')[1]) : standard
}
const REUSE   = process.argv.includes('--reuse')
const TAGE    = arg('tage', 365)
const PRO_TAG = arg('pro-tag', 150)

// ---------------------------------------------------------------------------

async function datenbankVorbereiten(): Promise<string> {
  const admin = postgres(BASIS_URL, { max: 1, fetch_types: false })
  try {
    if (!REUSE) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
    }
  } finally {
    await admin.end()
  }
  const url = new URL(BASIS_URL)
  url.pathname = `/${DB_NAME}`
  return url.toString()
}

/**
 * Erzeugt Belege serverseitig per generate_series — deutlich schneller als
 * zeilenweise Inserts aus Node und näher an einem echt gewachsenen Bestand:
 * Tagesverlauf mit Mittags- und Abendspitze, Wochenenden stärker, ~2 % Stornos.
 */
async function belegeErzeugen(sql: postgres.Sql, mandantId: string, kasseId: string): Promise<void> {
  await sql.unsafe(`
    INSERT INTO belege (
      mandant_id, kasse_id, beleg_nummer, beleg_datum, beleg_typ,
      betrag_normal_cent, betrag_ermaessigt1_cent,
      summe_bar_cent, summe_karte_cent, summe_sonstige_cent,
      umsatzzaehler_verschluesselt, zertifikat_sn, sig_vorbeleg,
      signaturwert, maschinenlesbare_code, positionen
    )
    SELECT
      '${mandantId}'::uuid,
      '${kasseId}'::uuid,
      row_number() over (),
      -- Wiener Mitternacht als Basis (nicht now(), sonst wandert das Zeitfenster
      -- mit der Uhrzeit des Laufs), dann Tagesoffset + Uhrzeit 11:00–23:00
      ((date_trunc('day', now() AT TIME ZONE 'Europe/Vienna')
        - interval '${TAGE} days'
        + (t.tag * interval '1 day')
        + interval '11 hours'
        + random() * interval '12 hours') AT TIME ZONE 'Europe/Vienna'),
      CASE WHEN random() < 0.02 THEN 'Stornobeleg' ELSE 'Barzahlungsbeleg' END,
      normal.cent,
      ermaessigt.cent,
      CASE WHEN zahlart.w < 0.55 THEN normal.cent + ermaessigt.cent ELSE 0 END,
      CASE WHEN zahlart.w >= 0.55 AND zahlart.w < 0.95 THEN normal.cent + ermaessigt.cent ELSE 0 END,
      CASE WHEN zahlart.w >= 0.95 THEN normal.cent + ermaessigt.cent ELSE 0 END,
      'PLATZHALTER', 'LASTTEST-SN', 'PLATZHALTER', 'PLATZHALTER', 'PLATZHALTER',
      jsonb_build_array(jsonb_build_object(
        'bezeichnung',      'Artikel ' || (1 + (random() * 39)::int),
        'menge',            1,
        'preisBruttoCent',  normal.cent + ermaessigt.cent,
        'mwstSatz',         'normal'
      ))
    FROM generate_series(0, ${TAGE - 1}) AS t(tag)
    CROSS JOIN LATERAL generate_series(1, ${PRO_TAG}) AS b(nr)
    CROSS JOIN LATERAL (SELECT (300 + (random() * 4000))::int AS cent) AS normal
    CROSS JOIN LATERAL (SELECT (200 + (random() * 1500))::int AS cent) AS ermaessigt
    CROSS JOIN LATERAL (SELECT random() AS w) AS zahlart
  `)
  await sql.unsafe('ANALYZE belege')
}

// ---------------------------------------------------------------------------

interface Messung { name: string; ms: number; heapMb: number; zeilen: number }

async function miss(name: string, fn: () => Promise<{ zeilen: number }>): Promise<Messung> {
  global.gc?.()
  const heapVor = process.memoryUsage().heapUsed
  const start   = process.hrtime.bigint()
  const { zeilen } = await fn()
  const ms      = Number(process.hrtime.bigint() - start) / 1e6
  const heapMb  = (process.memoryUsage().heapUsed - heapVor) / 1024 / 1024
  return { name, ms, heapMb, zeilen }
}

function tagOffset(tage: number): string {
  const d = new Date(Date.now() - tage * 86_400_000)
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

async function main(): Promise<void> {
  const url = await datenbankVorbereiten()
  const sql = postgres(url, { max: 4, fetch_types: false })
  const db  = drizzle(sql, { schema }) as unknown as Db

  if (!REUSE) {
    console.log(`Migrationen einspielen (${DB_NAME}) …`)
    await runMigrations(url)

    const [mandant] = await sql`
      INSERT INTO mandanten (firmenname, uid) VALUES ('Lasttest GmbH', 'ATU99999999') RETURNING id`
    const [kasse] = await sql`
      INSERT INTO kassen (mandant_id, kassen_id, see_zertifikat_der, see_private_key_enc,
                          see_zertifikat_sn, see_gueltig_bis, webhook_secret)
      VALUES (${mandant!.id}, 'LAST-001', 'x', 'x', 'LASTTEST-SN', now() + interval '5 years', 'lasttest')
      RETURNING id`

    const gesamt = TAGE * PRO_TAG
    console.log(`${gesamt.toLocaleString('de-AT')} Belege über ${TAGE} Tage erzeugen …`)
    const t0 = Date.now()
    await belegeErzeugen(sql, mandant!.id, kasse!.id)
    console.log(`  fertig in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }

  const [{ id: kasseId }] = await sql<{ id: string }[]>`SELECT id FROM kassen LIMIT 1`
  const [{ mandant_id: mandantId }] = await sql<{ mandant_id: string }[]>`SELECT mandant_id FROM kassen LIMIT 1`
  const [{ anzahl }] = await sql<{ anzahl: string }[]>`SELECT count(*)::text AS anzahl FROM belege`
  console.log(`\nBestand: ${Number(anzahl).toLocaleString('de-AT')} Belege\n`)

  const faelle: Array<[string, string, string, BerichtGruppierung]> = [
    ['Umsatz heute (Tag)',       tagOffset(0),   tagOffset(0),   'tag'],
    ['Umsatz 30 Tage (Tag)',     tagOffset(30),  tagOffset(0),   'tag'],
    ['Umsatz 1 Jahr (Monat)',    tagOffset(365), tagOffset(0),   'monat'],
    ['Umsatz 1 Jahr (Tag)',      tagOffset(365), tagOffset(0),   'tag'],
  ]

  const messungen: Messung[] = []
  for (const [name, von, bis, gruppierung] of faelle) {
    messungen.push(await miss(name, async () => {
      const r = await holeUmsatzbericht(
        { kasseIds: [kasseId!], von, bis, gruppierung, nurZielrechnungen: false },
        mandantId!, { db },
      )
      return { zeilen: r.zeilen.length }
    }))
  }

  messungen.push(await miss('Umsatz 1 Jahr + Uhrzeitfenster', async () => {
    const r = await holeUmsatzbericht(
      { kasseIds: [kasseId!], von: tagOffset(365), bis: tagOffset(0), gruppierung: 'monat',
        nurZielrechnungen: false, zeitVon: '18:00', zeitBis: '23:00' },
      mandantId!, { db },
    )
    return { zeilen: r.zeilen.length }
  }))

  messungen.push(await miss('Artikel-Top 1 Jahr', async () => {
    const r = await holeArtikelBericht(
      { kasseIds: [kasseId!], von: tagOffset(365), bis: tagOffset(0), limit: 20 },
      mandantId!, { db },
    )
    return { zeilen: r.zeilen.length }
  }))

  messungen.push(await miss('Kassen-Vergleich 1 Jahr', async () => {
    const r = await holeKassenVergleich(
      { kasseIds: [kasseId!], von: tagOffset(365), bis: tagOffset(0) },
      mandantId!, { db },
    )
    return { zeilen: r.zeilen.length }
  }))

  console.log('Fall                              |      ms |  Heap MB | Zeilen')
  console.log('----------------------------------+---------+----------+-------')
  for (const m of messungen) {
    console.log(
      `${m.name.padEnd(33)} | ${m.ms.toFixed(0).padStart(7)} | ${m.heapMb.toFixed(1).padStart(8)} | ${String(m.zeilen).padStart(6)}`,
    )
  }

  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
