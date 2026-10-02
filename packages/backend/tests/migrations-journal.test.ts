/**
 * scripts/check-migrations.mjs — Migrations-Integritäts-Check (CI-Gate).
 *
 * Besonders die Regel „`when` STRENG aufsteigend": Drizzle wendet nur Migrationen an, deren `when` größer
 * ist als das der zuletzt angewendeten — eine Migration mit kleinerem `when` wird auf bestehenden Datenbanken
 * STILL übersprungen (typisch bei parallelen Branches, die beide hinten anhängen). Das echte Journal muss
 * bestehen; Negativproben laufen gegen eine Kopie in einem Temp-Ordner (das Skript liest `../drizzle`
 * relativ zu sich selbst).
 */

import { describe, it, expect } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Eintrag { idx: number; tag: string; when: number }
interface Journal { entries: Eintrag[] }

/** Führt den Check gegen eine Kopie der Migrationen aus; `aendere` verändert Journal bzw. Ordner der Kopie. */
function pruefe(aendere?: (journal: Journal, ordner: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-journal-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    cpSync(join(BACKEND, 'scripts', 'check-migrations.mjs'), join(dir, 'scripts', 'check-migrations.mjs'))
    cpSync(join(BACKEND, 'drizzle'), join(dir, 'drizzle'), { recursive: true })
    if (aendere) {
      const pfad = join(dir, 'drizzle', 'meta', '_journal.json')
      const journal = JSON.parse(readFileSync(pfad, 'utf8')) as Journal
      aendere(journal, join(dir, 'drizzle'))
      writeFileSync(pfad, JSON.stringify(journal, null, 2))
    }
    const res = spawnSync(process.execPath, [join(dir, 'scripts', 'check-migrations.mjs')], { encoding: 'utf8' })
    return { status: res.status, ausgabe: `${res.stdout}${res.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('check-migrations.mjs', () => {
  it('das echte Journal besteht (Dateien 1:1, idx lückenlos, when streng aufsteigend)', () => {
    const { status, ausgabe } = pruefe()
    expect(ausgabe).toContain('Migrations-Integritaet ok')
    expect(status).toBe(0)
  })

  it('das echte Journal ist tatsächlich streng aufsteigend (unabhängig vom Skript gerechnet)', () => {
    const journal = JSON.parse(readFileSync(join(BACKEND, 'drizzle', 'meta', '_journal.json'), 'utf8')) as Journal
    journal.entries.forEach((e, i) => {
      if (i > 0) expect(e.when, `${e.tag} nach ${journal.entries[i - 1]!.tag}`).toBeGreaterThan(journal.entries[i - 1]!.when)
    })
  })

  it('gleiches when wie der Vorgänger: Exit 1 mit Hinweis auf die stille Übersprung-Gefahr', () => {
    const { status, ausgabe } = pruefe(j => { j.entries[j.entries.length - 1]!.when = j.entries[j.entries.length - 2]!.when })
    expect(status).toBe(1)
    expect(ausgabe).toContain('Journal-when nicht streng aufsteigend')
    expect(ausgabe).toContain('STILL uebersprungen')
  })

  it('kleineres when als der Vorgänger (parallel entwickelte Migration hinten angehängt): Exit 1', () => {
    const { status, ausgabe } = pruefe(j => { j.entries[j.entries.length - 1]!.when = j.entries[j.entries.length - 2]!.when - 1 })
    expect(status).toBe(1)
    expect(ausgabe).toContain('Journal-when nicht streng aufsteigend')
  })

  it('SQL-Datei ohne Journal-Eintrag und Journal-Lücke im idx werden weiterhin gemeldet', () => {
    const ohneEintrag = pruefe((j, ordner) => {
      writeFileSync(join(ordner, '9999_ohne_eintrag.sql'), 'SELECT 1;')
      void j
    })
    expect(ohneEintrag.status).toBe(1)
    expect(ohneEintrag.ausgabe).toContain('SQL-Datei ohne Journal-Eintrag')

    const luecke = pruefe(j => { j.entries[j.entries.length - 1]!.idx += 1 })
    expect(luecke.status).toBe(1)
    expect(luecke.ausgabe).toContain('Journal-idx nicht lueckenlos')
  })
})
