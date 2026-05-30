import { and, desc, eq } from 'drizzle-orm'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Db } from '../db/client.js'
import { depSicherungen, kassen } from '../db/schema.js'
import { erstelleDep7Json } from './beleg.service.js'

export async function erstelleDepSicherung(
  db:               Db,
  kasseId:          string,
  mandantId:        string,
  backupDir:        string,
  automatisch:      boolean,
): Promise<typeof depSicherungen.$inferSelect> {
  const { json, kassenId, anzahl } = await erstelleDep7Json(db, { kasseId })

  const dir = resolve(backupDir)
  await mkdir(dir, { recursive: true })

  const jetzt    = new Date()
  const datum    = jetzt.toISOString().slice(0, 10)
  const zeit     = jetzt.toISOString().slice(11, 19).replace(/:/g, '-')
  const dateiname = `DEP7-${kassenId}-${datum}-${zeit}.json`
  const dateipfad = join(dir, dateiname)

  await writeFile(dateipfad, json, 'utf8')

  const rows = await db.insert(depSicherungen).values({
    mandantId,
    kasseId,
    format:       'dep7',
    anzahlBelege: anzahl,
    dateipfad,
    dateiname,
    automatisch,
  }).returning()

  return rows[0]!
}

export async function listeSicherungen(
  db:        Db,
  kasseId:   string,
  mandantId: string,
  limit = 50,
): Promise<typeof depSicherungen.$inferSelect[]> {
  return db.select().from(depSicherungen)
    .where(and(
      eq(depSicherungen.kasseId,   kasseId),
      eq(depSicherungen.mandantId, mandantId),
    ))
    .orderBy(desc(depSicherungen.erstelltAm))
    .limit(limit)
}

export async function ladeSicherungDatei(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<{ buffer: Buffer; dateiname: string } | null> {
  const rows = await db.select().from(depSicherungen)
    .where(and(eq(depSicherungen.id, id), eq(depSicherungen.mandantId, mandantId)))
    .limit(1)
  const row = rows[0]
  if (!row) return null

  try {
    const buffer = Buffer.from(await readFile(row.dateipfad))
    return { buffer, dateiname: row.dateiname }
  } catch {
    return null
  }
}

/** Gibt alle aktiven Kassen zurück, deren letzte DEP-Sicherung älter als 30 Tage ist. */
export async function findeKassenOhneSicherung(
  db: Db,
): Promise<Array<{ kasseId: string; mandantId: string }>> {
  const alleKassen = await db
    .select({ id: kassen.id, mandantId: kassen.mandantId })
    .from(kassen)
    .where(eq(kassen.status, 'aktiv'))

  const dreissigTageAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const ergebnis: Array<{ kasseId: string; mandantId: string }> = []

  for (const kasse of alleKassen) {
    const letzte = await db.select({ erstelltAm: depSicherungen.erstelltAm })
      .from(depSicherungen)
      .where(eq(depSicherungen.kasseId, kasse.id))
      .orderBy(desc(depSicherungen.erstelltAm))
      .limit(1)

    if (letzte.length === 0 || letzte[0]!.erstelltAm < dreissigTageAgo) {
      ergebnis.push({ kasseId: kasse.id, mandantId: kasse.mandantId })
    }
  }

  return ergebnis
}
