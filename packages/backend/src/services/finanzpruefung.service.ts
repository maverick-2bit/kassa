import { and, desc, eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/client.js'
import { belege, kassen, pruefungsTokens } from '../db/schema.js'

export class PruefungError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export async function erstellePruefungsToken(
  db:               Db,
  kasseId:          string,
  mandantId:        string,
  userId:           string,
  gueltigkeitsTage: number,
  beschreibung?:    string,
): Promise<typeof pruefungsTokens.$inferSelect> {
  const token     = randomBytes(32).toString('hex')
  const gueltigBis = new Date(Date.now() + gueltigkeitsTage * 24 * 60 * 60 * 1000)

  const rows = await db.insert(pruefungsTokens).values({
    mandantId,
    kasseId,
    token,
    gueltigBis,
    erstelltVonUserId: userId,
    beschreibung:      beschreibung ?? null,
  }).returning()

  return rows[0]!
}

export async function listePruefungsTokens(
  db:        Db,
  kasseId:   string,
  mandantId: string,
): Promise<typeof pruefungsTokens.$inferSelect[]> {
  return db.select().from(pruefungsTokens)
    .where(and(
      eq(pruefungsTokens.kasseId,   kasseId),
      eq(pruefungsTokens.mandantId, mandantId),
    ))
    .orderBy(desc(pruefungsTokens.erstelltAm))
}

export async function widerrufePruefungsToken(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<boolean> {
  const result = await db.update(pruefungsTokens)
    .set({ widerrufen: true })
    .where(and(eq(pruefungsTokens.id, id), eq(pruefungsTokens.mandantId, mandantId)))
    .returning()
  return result.length > 0
}

export interface PruefungsDaten {
  kassenId:         string
  kasseBezeichnung: string | null
  token:            typeof pruefungsTokens.$inferSelect
  belege:           typeof belege.$inferSelect[]
}

export async function ladePruefungsDaten(
  db:    Db,
  token: string,
): Promise<PruefungsDaten> {
  const tokenRows = await db.select().from(pruefungsTokens)
    .where(eq(pruefungsTokens.token, token))
    .limit(1)

  const tokenRow = tokenRows[0]
  if (!tokenRow)           throw new PruefungError(404, 'Prüfungstoken nicht gefunden')
  if (tokenRow.widerrufen) throw new PruefungError(403, 'Prüfungstoken wurde widerrufen')
  if (tokenRow.gueltigBis < new Date()) throw new PruefungError(403, 'Prüfungstoken ist abgelaufen')

  await db.update(pruefungsTokens)
    .set({ letzteVerwendung: new Date() })
    .where(eq(pruefungsTokens.id, tokenRow.id))

  const kasseRows = await db
    .select({ kassenId: kassen.kassenId, bezeichnung: kassen.bezeichnung })
    .from(kassen)
    .where(eq(kassen.id, tokenRow.kasseId))
    .limit(1)

  const kasse = kasseRows[0]
  if (!kasse) throw new PruefungError(404, 'Kasse nicht gefunden')

  const belegeRows = await db.select().from(belege)
    .where(eq(belege.kasseId, tokenRow.kasseId))
    .orderBy(desc(belege.belegNummer))

  return {
    kassenId:         kasse.kassenId,
    kasseBezeichnung: kasse.bezeichnung,
    token:            tokenRow,
    belege:           belegeRows,
  }
}
