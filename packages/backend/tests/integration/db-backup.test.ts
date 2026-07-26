/**
 * Integrationstest: DB-Sicherung (pg_dump → node:zlib-Gzip → Datei).
 *
 * Entstanden aus dem Windows-Dev-Befund "spawn gzip ENOENT": Die Kompression
 * läuft jetzt in-process über node:zlib statt über ein externes gzip-Binary.
 * Geprüft wird der Erfolgspfad (echtes Gzip-Format, entpackbarer SQL-Dump,
 * DB-Protokollzeile) und der Fehlerpfad (kaputtes Ziel → throw + Zeile mit
 * erfolgreich=false). Läuft nur mit pg_dump ≥ 17 (wie der Restore-Drill).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { desc } from 'drizzle-orm'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { dbSicherungen } from '../../src/db/schema.js'
import { erstelleDbSicherung } from '../../src/services/db-backup.service.js'

function pgDumpMajor(): number {
  const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf8', shell: false })
  if (r.error || r.status !== 0) return 0
  return parseInt(/(\d+)/.exec(r.stdout ?? '')?.[1] ?? '0', 10)
}

const CLIENT_OK = pgDumpMajor() >= 17
if (!CLIENT_OK) {
  console.warn('[db-backup] übersprungen: pg_dump ≥ 17 nicht verfügbar')
}

describe.skipIf(!CLIENT_OK)('DB-Sicherung (pg_dump + node:zlib)', () => {
  let idb: IntegrationsDb
  let backupDir: string

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    backupDir = mkdtempSync(join(tmpdir(), 'kassa-dbbackup-'))
  })

  afterAll(async () => {
    await idb?.zerstoeren()
    rmSync(backupDir, { recursive: true, force: true })
  })

  it('erzeugt eine valide .sql.gz ohne externes gzip-Binary', async () => {
    const s = await erstelleDbSicherung(idb.db, idb.url, backupDir, false)

    expect(s.erfolgreich).toBe(true)
    expect(s.fehler).toBeNull()
    expect(s.dateiname).toMatch(/^db-backup-.*\.sql\.gz$/)
    expect(s.dateigroesse).toBeGreaterThan(0)
    expect(s.automatisch).toBe(false)

    const roh = readFileSync(s.dateipfad)
    // Gzip-Magic-Bytes — beweist echtes Gzip-Format aus node:zlib
    expect(roh[0]).toBe(0x1f)
    expect(roh[1]).toBe(0x8b)

    // Entpackt ein brauchbarer PostgreSQL-Dump mit unseren Tabellen
    const sqlText = gunzipSync(roh).toString('utf8')
    expect(sqlText).toContain('PostgreSQL database dump')
    expect(sqlText).toContain('CREATE TABLE')
    expect(sqlText).toContain('belege')
  })

  it('Fehlerpfad: nicht existente Ziel-DB → throw + Protokollzeile erfolgreich=false', async () => {
    const kaputteUrl = idb.url.replace(/\/[^/]+$/, '/gibt_es_nicht_xyz')

    await expect(erstelleDbSicherung(idb.db, kaputteUrl, backupDir, true)).rejects.toThrow()

    const [letzte] = await idb.db.select().from(dbSicherungen)
      .orderBy(desc(dbSicherungen.erstelltAm)).limit(1)
    expect(letzte!.erfolgreich).toBe(false)
    expect(letzte!.fehler).toBeTruthy()
    expect(letzte!.automatisch).toBe(true)
  })
})
