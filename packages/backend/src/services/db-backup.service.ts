import { spawn }      from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { asc, desc, eq } from 'drizzle-orm'
import type { Db }       from '../db/client.js'
import { dbSicherungen } from '../db/schema.js'

export async function erstelleDbSicherung(
  db:          Db,
  databaseUrl: string,
  backupDir:   string,
  automatisch: boolean,
): Promise<typeof dbSicherungen.$inferSelect> {
  const dir = resolve(backupDir)
  await mkdir(dir, { recursive: true })

  const jetzt     = new Date()
  const datum     = jetzt.toISOString().slice(0, 10)
  const zeit      = jetzt.toISOString().slice(11, 19).replace(/:/g, '-')
  const dateiname = `db-backup-${datum}-${zeit}.sql.gz`
  const dateipfad = join(dir, dateiname)

  let fehler: string | undefined
  let spawnFehler: string | undefined

  try {
  await new Promise<void>((res, rej) => {
    // Passwort aus der URL extrahieren und via PGPASSWORD übergeben (nie als CLI-Argument)
    const urlObj   = new URL(databaseUrl)
    const password = urlObj.password ? decodeURIComponent(urlObj.password) : ''
    urlObj.password = ''
    const urlSansPw = urlObj.toString()

    const dump = spawn('pg_dump', ['--no-password', urlSansPw], {
      env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
    })
    // Kompression in-process (node:zlib) statt externem gzip-Binary — das
    // fehlte auf Windows außerhalb von Git-Bash ("spawn gzip ENOENT").
    const gzip = createGzip()
    const out  = createWriteStream(dateipfad)

    let stderrBuf = ''
    dump.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString() })

    // pg_dump selbst nicht startbar (z. B. Binary fehlt)
    dump.on('error', (e: Error) => { out.destroy(); gzip.destroy(); rej(e) })

    let dumpCode: number | null = null
    let pipeFertig = false

    function trySettle() {
      if (dumpCode === null || !pipeFertig) return
      if (stderrBuf.trim()) fehler = stderrBuf.trim().slice(0, 500)
      if (dumpCode !== 0) {
        rej(new Error(`pg_dump fehlgeschlagen (exit ${dumpCode}): ${fehler ?? ''}`.trimEnd()))
      } else {
        res()
      }
    }

    dump.on('close', (code) => { dumpCode = code ?? 1; trySettle() })
    // pipeline verwaltet Backpressure + Stream-Fehler und schließt out sauber
    pipeline(dump.stdout, gzip, out)
      .then(() => { pipeFertig = true; trySettle() })
      .catch((e: Error) => rej(e))
  })
  } catch (e) {
    // Fehler festhalten aber weiter ausführen, um den Eintrag in der DB zu schreiben
    spawnFehler = e instanceof Error ? e.message : String(e)
    if (!fehler) fehler = spawnFehler
  }

  const fileInfo = await stat(dateipfad).catch(() => ({ size: 0 }))

  const rows = await db.insert(dbSicherungen).values({
    dateiname,
    dateipfad,
    dateigroesse: fileInfo.size,
    automatisch,
    erfolgreich:  !fehler,
    ...(fehler !== undefined ? { fehler } : {}),
  }).returning()

  if (spawnFehler) throw new Error(spawnFehler)

  return rows[0]!
}

export async function listeDbSicherungen(
  db:    Db,
  limit = 50,
): Promise<typeof dbSicherungen.$inferSelect[]> {
  return db.select().from(dbSicherungen)
    .orderBy(desc(dbSicherungen.erstelltAm))
    .limit(limit)
}

export async function ladeDbSicherungDatei(
  db: Db,
  id: string,
): Promise<{ buffer: Buffer; dateiname: string } | null> {
  const rows = await db.select().from(dbSicherungen)
    .where(eq(dbSicherungen.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const buffer = await readFile(row.dateipfad).catch(() => null)
  if (!buffer) return null
  return { buffer, dateiname: row.dateiname }
}

/** Löscht älteste Einträge über dem Limit (Datei + DB-Zeile) */
export async function bereinigeSicherungen(
  db:        Db,
  maxAnzahl: number,
): Promise<void> {
  const alle = await db.select().from(dbSicherungen)
    .orderBy(asc(dbSicherungen.erstelltAm))

  if (alle.length <= maxAnzahl) return

  const zuLoeschen = alle.slice(0, alle.length - maxAnzahl)
  for (const s of zuLoeschen) {
    await unlink(s.dateipfad).catch(() => { /* Datei evtl. schon weg */ })
    await db.delete(dbSicherungen).where(eq(dbSicherungen.id, s.id))
  }
}
