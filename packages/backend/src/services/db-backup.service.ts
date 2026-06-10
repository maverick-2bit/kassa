import { spawn }      from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

  await new Promise<void>((res, rej) => {
    const dump = spawn('pg_dump', ['--no-password', databaseUrl], {
      env: { ...process.env },
    })
    const gzip = spawn('gzip', ['-c'])
    const out  = createWriteStream(dateipfad)

    dump.stdout.pipe(gzip.stdin)
    gzip.stdout.pipe(out)

    let stderrBuf = ''
    dump.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString() })
    gzip.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString() })

    dump.on('error', rej)
    gzip.on('error', rej)
    out.on('error', rej)
    out.on('finish', () => {
      if (stderrBuf.trim()) fehler = stderrBuf.trim().slice(0, 500)
      res()
    })
  })

  const fileInfo = await stat(dateipfad).catch(() => ({ size: 0 }))

  const rows = await db.insert(dbSicherungen).values({
    dateiname,
    dateipfad,
    dateigroesse: fileInfo.size,
    automatisch,
    erfolgreich:  !fehler,
    ...(fehler !== undefined ? { fehler } : {}),
  }).returning()

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
