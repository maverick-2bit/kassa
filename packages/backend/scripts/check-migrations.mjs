/**
 * Migrations-Integritäts-Check.
 *
 * Das Projekt pflegt Migrationen handgeschrieben + idempotent (IF NOT EXISTS),
 * inkl. manueller Journal-Eintraege. Frueher war das Journal schon einmal
 * unvollstaendig (Schema-Drift). Dieser Check stellt 1:1 sicher:
 *   - jede drizzle/NNNN_*.sql hat einen Journal-Eintrag (sonst wird sie beim
 *     Migrieren uebersprungen)
 *   - jeder Journal-Eintrag hat eine .sql-Datei (sonst bricht der Migrator)
 *   - Journal-Eintraege sind nach idx aufsteigend und lueckenlos sortiert
 *
 * Exit 1 bei Inkonsistenz — als CI-Gate gedacht.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
const journalPath = join(drizzleDir, 'meta', '_journal.json')

const fehler = []

const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
const entries = journal.entries ?? []
const journalTags = entries.map(e => e.tag)

const sqlFiles = readdirSync(drizzleDir)
  .filter(f => f.endsWith('.sql'))
  .map(f => f.replace(/\.sql$/, ''))

// jede .sql braucht einen Journal-Eintrag
for (const sql of sqlFiles) {
  if (!journalTags.includes(sql)) {
    fehler.push(`SQL-Datei ohne Journal-Eintrag: ${sql}.sql (wird beim Migrieren uebersprungen!)`)
  }
}
// jeder Journal-Eintrag braucht eine .sql
for (const tag of journalTags) {
  if (!sqlFiles.includes(tag)) {
    fehler.push(`Journal-Eintrag ohne SQL-Datei: ${tag} (Migrator bricht ab!)`)
  }
}
// idx lueckenlos aufsteigend
entries.forEach((e, i) => {
  if (e.idx !== i) fehler.push(`Journal-idx nicht lueckenlos: Eintrag ${i} hat idx ${e.idx}`)
})

if (fehler.length > 0) {
  console.error('Migrations-Integritaet VERLETZT:')
  for (const f of fehler) console.error('  - ' + f)
  process.exit(1)
}

console.info(`Migrations-Integritaet ok: ${sqlFiles.length} SQL-Dateien, ${entries.length} Journal-Eintraege, 1:1 konsistent.`)
