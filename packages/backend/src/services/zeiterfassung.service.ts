import bcrypt from 'bcryptjs'
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { arbeitszeiten, kassen, mandanten, users } from '../db/schema.js'
import type {
  ArbeitszeitInput,
  ArbeitszeitResponse,
  ArbeitszeitUpdate,
  StempelResponse,
} from '@kassa/shared'

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function dauerMinuten(beginn: Date, ende: Date): number {
  return Math.floor((ende.getTime() - beginn.getTime()) / 60_000)
}

function toDto(row: typeof arbeitszeiten.$inferSelect): ArbeitszeitResponse {
  const dauer = row.ende ? dauerMinuten(row.beginn, row.ende) : null
  const netto  = dauer !== null ? Math.max(0, dauer - row.pauseMinuten) : null
  return {
    id:           row.id,
    kasseId:      row.kasseId,
    userId:       row.userId,
    userName:     row.userName,
    beginn:       row.beginn.toISOString(),
    ende:         row.ende ? row.ende.toISOString() : null,
    dauerMinuten: dauer,
    pauseMinuten: row.pauseMinuten,
    nettoMinuten: netto,
    quelle:       row.quelle as 'pin' | 'admin',
    ...(row.notiz && { notiz: row.notiz }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// PIN-Stempel (kein JWT nötig)
// ---------------------------------------------------------------------------

export async function stempeln(
  db:      Db,
  kasseId: string,
  pin:     string,
): Promise<StempelResponse> {
  // Kasse + Mandant laden
  const [kasse] = await db
    .select({ mandantId: kassen.mandantId, modulZeiterfassungAktiv: mandanten.modulZeiterfassungAktiv })
    .from(kassen)
    .innerJoin(mandanten, eq(kassen.mandantId, mandanten.id))
    .where(eq(kassen.id, kasseId))
    .limit(1)

  if (!kasse) throw new Error('Kasse nicht gefunden')
  if (!kasse.modulZeiterfassungAktiv) throw new Error('Zeiterfassungs-Modul nicht aktiviert')

  // Alle aktiven User des Mandanten mit pinHash laden
  const alleUser = await db
    .select({ id: users.id, name: users.name, pinHash: users.pinHash })
    .from(users)
    .where(and(eq(users.mandantId, kasse.mandantId), eq(users.aktiv, true)))

  // PIN vergleichen
  let gefundenerUser: { id: string; name: string } | null = null
  for (const u of alleUser) {
    if (u.pinHash && await bcrypt.compare(pin, u.pinHash)) {
      gefundenerUser = { id: u.id, name: u.name }
      break
    }
  }
  if (!gefundenerUser) throw new Error('PIN ungültig')

  // Offene Schicht prüfen
  const [offene] = await db
    .select()
    .from(arbeitszeiten)
    .where(and(
      eq(arbeitszeiten.mandantId, kasse.mandantId),
      eq(arbeitszeiten.userId,    gefundenerUser.id),
      isNull(arbeitszeiten.ende),
    ))
    .limit(1)

  const jetzt = new Date()

  if (offene) {
    // Ausstempeln
    const dauer = dauerMinuten(offene.beginn, jetzt)
    await db
      .update(arbeitszeiten)
      .set({ ende: jetzt, updatedAt: jetzt })
      .where(eq(arbeitszeiten.id, offene.id))

    return {
      aktion:       'ausgestempelt',
      userId:       gefundenerUser.id,
      userName:     gefundenerUser.name,
      zeitpunkt:    jetzt.toISOString(),
      beginn:       offene.beginn.toISOString(),
      ende:         jetzt.toISOString(),
      dauerMinuten: dauer,
    }
  } else {
    // Einstempeln
    await db.insert(arbeitszeiten).values({
      mandantId: kasse.mandantId,
      kasseId,
      userId:    gefundenerUser.id,
      userName:  gefundenerUser.name,
      beginn:    jetzt,
      quelle:    'pin',
    })

    return {
      aktion:    'eingestempelt',
      userId:    gefundenerUser.id,
      userName:  gefundenerUser.name,
      zeitpunkt: jetzt.toISOString(),
      beginn:    jetzt.toISOString(),
    }
  }
}

// ---------------------------------------------------------------------------
// Admin-CRUD
// ---------------------------------------------------------------------------

export async function listeArbeitszeiten(
  db:        Db,
  mandantId: string,
  opts: {
    userId?:    string
    kasseId?:   string
    datumVon?:  string  // YYYY-MM-DD
    datumBis?:  string
    nurOffen?:  boolean
    limit?:     number
  } = {},
): Promise<ArbeitszeitResponse[]> {
  const conditions = [eq(arbeitszeiten.mandantId, mandantId)]

  if (opts.userId)   conditions.push(eq(arbeitszeiten.userId,   opts.userId))
  if (opts.kasseId)  conditions.push(eq(arbeitszeiten.kasseId,  opts.kasseId))
  if (opts.datumVon) conditions.push(gte(arbeitszeiten.beginn, new Date(opts.datumVon + 'T00:00:00Z')))
  if (opts.datumBis) conditions.push(lte(arbeitszeiten.beginn, new Date(opts.datumBis + 'T23:59:59Z')))
  if (opts.nurOffen) conditions.push(isNull(arbeitszeiten.ende))

  const rows = await db
    .select()
    .from(arbeitszeiten)
    .where(and(...conditions))
    .orderBy(desc(arbeitszeiten.beginn))
    .limit(opts.limit ?? 500)

  return rows.map(toDto)
}

export async function erstelleArbeitszeit(
  db:        Db,
  mandantId: string,
  input:     ArbeitszeitInput,
): Promise<ArbeitszeitResponse> {
  // Username auflösen
  const [user] = await db
    .select({ name: users.name })
    .from(users)
    .where(and(eq(users.id, input.userId), eq(users.mandantId, mandantId)))
    .limit(1)
  if (!user) throw new Error('Benutzer nicht gefunden')

  const [row] = await db.insert(arbeitszeiten).values({
    mandantId,
    kasseId:      input.kasseId,
    userId:       input.userId,
    userName:     user.name,
    beginn:       new Date(input.beginn),
    quelle:       'admin',
    ...(input.ende         && { ende:         new Date(input.ende)   }),
    ...(input.pauseMinuten !== undefined && { pauseMinuten: input.pauseMinuten }),
    ...(input.notiz        && { notiz:        input.notiz            }),
  }).returning()

  if (!row) throw new Error('Eintrag konnte nicht gespeichert werden')
  return toDto(row)
}

export async function aktualisiereArbeitszeit(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     ArbeitszeitUpdate,
): Promise<ArbeitszeitResponse> {
  const [row] = await db
    .update(arbeitszeiten)
    .set({
      ...(input.beginn       !== undefined && { beginn:       new Date(input.beginn)  }),
      ...(input.ende         !== undefined && { ende:         input.ende ? new Date(input.ende) : null }),
      ...(input.pauseMinuten !== undefined && { pauseMinuten: input.pauseMinuten }),
      ...(input.notiz        !== undefined && { notiz:        input.notiz || null }),
      updatedAt: new Date(),
    })
    .where(and(eq(arbeitszeiten.id, id), eq(arbeitszeiten.mandantId, mandantId)))
    .returning()

  if (!row) throw new Error('Eintrag nicht gefunden')
  return toDto(row)
}

export async function loescheArbeitszeit(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<void> {
  const result = await db
    .delete(arbeitszeiten)
    .where(and(eq(arbeitszeiten.id, id), eq(arbeitszeiten.mandantId, mandantId)))
    .returning({ id: arbeitszeiten.id })

  if (result.length === 0) throw new Error('Eintrag nicht gefunden')
}

// Wer ist aktuell eingestempelt?
export async function ladeAktuelleSchichten(
  db:        Db,
  mandantId: string,
): Promise<ArbeitszeitResponse[]> {
  const rows = await db
    .select()
    .from(arbeitszeiten)
    .where(and(eq(arbeitszeiten.mandantId, mandantId), isNull(arbeitszeiten.ende)))
    .orderBy(arbeitszeiten.beginn)

  return rows.map(toDto)
}
