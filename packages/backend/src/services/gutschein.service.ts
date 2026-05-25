import { and, desc, eq, sql } from 'drizzle-orm'
import type {
  GutscheinBuchungResponse,
  GutscheinEinloesen,
  GutscheinEinloesungResult,
  GutscheinInput,
  GutscheinResponse,
  GutscheinStatus,
  KundeSnapshot,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { gutscheine, gutscheinBuchungen, kunden } from '../db/schema.js'

export class GutscheinError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Code-Generator — "GS-XXXX-XXXX" ohne leicht verwechselbare Zeichen
// ---------------------------------------------------------------------------

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

function generiereCode(): string {
  const rand = (n: number) => Array.from({ length: n }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
  return `GS-${rand(4)}-${rand(4)}`
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

type GsRow  = typeof gutscheine.$inferSelect
type BuRow  = typeof gutscheinBuchungen.$inferSelect

function toDto(row: GsRow): GutscheinResponse {
  return {
    id:          row.id,
    code:        row.code,
    nummer:      row.nummer,
    datum:       row.datum.toISOString(),
    status:      row.status as GutscheinStatus,
    betragCent:  row.betragCent,
    bezahltCent: row.bezahltCent,
    restCent:    Math.max(0, row.betragCent - row.bezahltCent),
    ...(row.gueltigBis    && { gueltigBis:   row.gueltigBis }),
    ...(row.kundeId       && { kundeId:      row.kundeId }),
    ...(row.kundeSnapshot != null ? { kunde: row.kundeSnapshot as KundeSnapshot } : {}),
    ...(row.notiz         && { notiz:        row.notiz }),
    createdAt:   row.createdAt.toISOString(),
    updatedAt:   row.updatedAt.toISOString(),
  }
}

function toBuchungDto(row: BuRow): GutscheinBuchungResponse {
  return {
    id:           row.id,
    gutscheinId:  row.gutscheinId,
    typ:          row.typ as GutscheinBuchungResponse['typ'],
    betragCent:   row.betragCent,
    restCentNach: row.restCentNach,
    ...(row.belegId                 && { belegId:                 row.belegId }),
    ...(row.verknuepfterGutscheinId && { verknuepfterGutscheinId: row.verknuepfterGutscheinId }),
    ...(row.notiz                   && { notiz:                   row.notiz }),
    createdAt: row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

async function erfasseBuchung(
  db: Db,
  entry: {
    gutscheinId:              string
    mandantId:                string
    typ:                      GutscheinBuchungResponse['typ']
    betragCent:               number
    restCentNach:             number
    belegId?:                 string
    verknuepfterGutscheinId?: string
    notiz?:                   string
  },
): Promise<void> {
  await db.insert(gutscheinBuchungen).values(entry)
}

async function holeKundeSnapshot(db: Db, kundeId: string, mandantId: string): Promise<KundeSnapshot> {
  const [k] = await db
    .select()
    .from(kunden)
    .where(and(eq(kunden.id, kundeId), eq(kunden.mandantId, mandantId)))
    .limit(1)
  if (!k) throw new GutscheinError(404, 'Kunde nicht gefunden')
  const bezeichnung = [k.firma, k.vorname, k.nachname].filter(Boolean).join(' ').trim()
  return {
    id: k.id, nummer: k.nummer,
    bezeichnung: bezeichnung || `Kunde ${k.nummer}`,
    ...(k.firma    && { firma:    k.firma    }),
    ...(k.vorname  && { vorname:  k.vorname  }),
    ...(k.nachname && { nachname: k.nachname }),
    ...(k.email    && { email:    k.email    }),
    ...(k.telefon  && { telefon:  k.telefon  }),
    ...(k.strasse  && { strasse:  k.strasse  }),
    ...(k.plz      && { plz:      k.plz      }),
    ...(k.ort      && { ort:      k.ort      }),
    land: k.land,
    ...(k.uid      && { uid:      k.uid      }),
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listeGutscheine(
  db:        Db,
  mandantId: string,
  opts: { status?: GutscheinStatus; kundeId?: string; limit?: number } = {},
): Promise<GutscheinResponse[]> {
  const conditions = [eq(gutscheine.mandantId, mandantId)]
  if (opts.status)  conditions.push(eq(gutscheine.status,  opts.status))
  if (opts.kundeId) conditions.push(eq(gutscheine.kundeId, opts.kundeId))

  const rows = await db
    .select()
    .from(gutscheine)
    .where(and(...conditions))
    .orderBy(desc(gutscheine.createdAt))
    .limit(opts.limit ?? 500)

  return rows.map(toDto)
}

export async function holeGutscheinById(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<GutscheinResponse> {
  const [row] = await db
    .select()
    .from(gutscheine)
    .where(and(eq(gutscheine.id, id), eq(gutscheine.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new GutscheinError(404, 'Gutschein nicht gefunden')
  return toDto(row)
}

export async function holeGutscheinByCode(
  db:        Db,
  code:      string,
  mandantId: string,
): Promise<GutscheinResponse> {
  const [row] = await db
    .select()
    .from(gutscheine)
    .where(and(eq(gutscheine.code, code.toUpperCase()), eq(gutscheine.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new GutscheinError(404, 'Gutschein nicht gefunden')
  return toDto(row)
}

export async function listeGutscheinBuchungen(
  db:          Db,
  gutscheinId: string,
  mandantId:   string,
): Promise<GutscheinBuchungResponse[]> {
  // Sicherstellen, dass der Gutschein zum Mandanten gehört
  const [gs] = await db
    .select({ id: gutscheine.id })
    .from(gutscheine)
    .where(and(eq(gutscheine.id, gutscheinId), eq(gutscheine.mandantId, mandantId)))
    .limit(1)
  if (!gs) throw new GutscheinError(404, 'Gutschein nicht gefunden')

  const rows = await db
    .select()
    .from(gutscheinBuchungen)
    .where(eq(gutscheinBuchungen.gutscheinId, gutscheinId))
    .orderBy(desc(gutscheinBuchungen.createdAt))

  return rows.map(toBuchungDto)
}

export async function erstelleGutschein(
  db:        Db,
  mandantId: string,
  input:     GutscheinInput,
): Promise<GutscheinResponse> {
  // Kunden-Snapshot aufbauen wenn Kunde angegeben
  let kundeSnapshot: KundeSnapshot | undefined
  if (input.kundeId) {
    kundeSnapshot = await holeKundeSnapshot(db, input.kundeId, mandantId)
  }

  // Code bestimmen: benutzerdefiniert oder auto-generiert
  let code: string
  if (input.code) {
    const normalizedCode = input.code.toUpperCase()
    const existing = await db
      .select({ id: gutscheine.id })
      .from(gutscheine)
      .where(and(eq(gutscheine.code, normalizedCode), eq(gutscheine.mandantId, mandantId)))
      .limit(1)
    if (existing.length > 0) throw new GutscheinError(409, `Code „${normalizedCode}" ist bereits vergeben`)
    code = normalizedCode
  } else {
    // Auto-Generierung (max. 5 Versuche)
    code = ''
    for (let i = 0; i < 5; i++) {
      const kandidat = generiereCode()
      const existing = await db
        .select({ id: gutscheine.id })
        .from(gutscheine)
        .where(and(eq(gutscheine.code, kandidat), eq(gutscheine.mandantId, mandantId)))
        .limit(1)
      if (existing.length === 0) { code = kandidat; break }
    }
    if (!code) throw new GutscheinError(500, 'Code konnte nicht generiert werden')
  }

  // Nächste Nummer
  const numRows = await db
    .select({ n: sql<number>`COALESCE(MAX(${gutscheine.nummer}), 0) + 1` })
    .from(gutscheine)
    .where(eq(gutscheine.mandantId, mandantId))
  const nummer = numRows[0]?.n ?? 1

  const [row] = await db
    .insert(gutscheine)
    .values({
      mandantId,
      code,
      nummer,
      betragCent:  input.betragCent,
      ...(input.gueltigBis && { gueltigBis:    input.gueltigBis }),
      ...(input.kundeId    && { kundeId:        input.kundeId }),
      ...(kundeSnapshot    && { kundeSnapshot }),
      ...(input.notiz      && { notiz:          input.notiz }),
    })
    .returning()

  if (!row) throw new GutscheinError(500, 'Gutschein konnte nicht erstellt werden')

  // Ausstellungs-Buchung
  await erfasseBuchung(db, {
    gutscheinId:  row.id,
    mandantId,
    typ:          'ausstellung',
    betragCent:   input.betragCent,
    restCentNach: input.betragCent,
    ...(input.notiz && { notiz: input.notiz }),
  })

  return toDto(row)
}

export async function loesGutscheinEin(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     GutscheinEinloesen,
): Promise<GutscheinEinloesungResult> {
  const [current] = await db
    .select()
    .from(gutscheine)
    .where(and(eq(gutscheine.id, id), eq(gutscheine.mandantId, mandantId)))
    .limit(1)

  if (!current) throw new GutscheinError(404, 'Gutschein nicht gefunden')
  if (current.status === 'storniert')  throw new GutscheinError(400, 'Dieser Gutschein ist storniert')
  if (current.status === 'eingeloest') throw new GutscheinError(400, 'Dieser Gutschein ist bereits vollständig eingelöst')

  // Ablaufdatum prüfen
  if (current.gueltigBis) {
    const today = new Date().toISOString().slice(0, 10)
    if (today > current.gueltigBis) {
      throw new GutscheinError(400, `Gutschein ist abgelaufen (gültig bis ${current.gueltigBis})`)
    }
  }

  const restCentVorher = Math.max(0, current.betragCent - current.bezahltCent)
  if (input.einloesungCent > restCentVorher) {
    throw new GutscheinError(400,
      `Einlösungsbetrag (${(input.einloesungCent / 100).toFixed(2)} €) übersteigt den Restwert (${(restCentVorher / 100).toFixed(2)} €)`)
  }

  const restCentNach   = restCentVorher - input.einloesungCent
  const wirdRestGS     = input.erstelleRestgutschein && restCentNach > 0

  if (wirdRestGS) {
    // ----------------------------------------------------------------
    // Restgutschein-Szenario: Original vollständig abschreiben,
    // neuen Gutschein über den Restbetrag ausstellen.
    // ----------------------------------------------------------------

    // 1) Neuen Restgutschein erstellen (rekursiv, ohne code → auto)
    const restGsInput: GutscheinInput = {
      betragCent: restCentNach,
      ...(current.kundeId && { kundeId: current.kundeId }),
      notiz: `Restgutschein von ${current.code}`,
    }
    const restGutschein = await erstelleGutschein(db, mandantId, restGsInput)

    // 2) Original vollständig auf eingelöst setzen (bezahltCent = betragCent)
    const [updated] = await db
      .update(gutscheine)
      .set({ bezahltCent: current.betragCent, status: 'eingeloest', updatedAt: new Date() })
      .where(and(eq(gutscheine.id, id), eq(gutscheine.mandantId, mandantId)))
      .returning()
    if (!updated) throw new GutscheinError(500, 'Einlösung fehlgeschlagen')

    // 3) Buchungen auf Original
    await erfasseBuchung(db, {
      gutscheinId:  id,
      mandantId,
      typ:          'einloesung',
      betragCent:   -input.einloesungCent,
      restCentNach,
      ...(input.belegId && { belegId: input.belegId }),
    })
    await erfasseBuchung(db, {
      gutscheinId:             id,
      mandantId,
      typ:                     'restgutschein',
      betragCent:              -restCentNach,
      restCentNach:            0,
      verknuepfterGutscheinId: restGutschein.id,
      notiz:                   `Restgutschein ${restGutschein.code} ausgestellt`,
    })

    return { gutschein: toDto(updated), restGutschein }
  } else {
    // ----------------------------------------------------------------
    // Normaler Einlösungsvorgang (ganz oder teilweise)
    // ----------------------------------------------------------------
    const neuBezahlt     = current.bezahltCent + input.einloesungCent
    const neuerStatus: GutscheinStatus = neuBezahlt >= current.betragCent ? 'eingeloest' : 'teileingeloest'

    const [updated] = await db
      .update(gutscheine)
      .set({ bezahltCent: neuBezahlt, status: neuerStatus, updatedAt: new Date() })
      .where(and(eq(gutscheine.id, id), eq(gutscheine.mandantId, mandantId)))
      .returning()
    if (!updated) throw new GutscheinError(500, 'Einlösung fehlgeschlagen')

    await erfasseBuchung(db, {
      gutscheinId:  id,
      mandantId,
      typ:          'einloesung',
      betragCent:   -input.einloesungCent,
      restCentNach,
      ...(input.belegId && { belegId: input.belegId }),
    })

    return { gutschein: toDto(updated) }
  }
}

export async function storniereGutschein(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<GutscheinResponse> {
  const [current] = await db
    .select()
    .from(gutscheine)
    .where(and(eq(gutscheine.id, id), eq(gutscheine.mandantId, mandantId)))
    .limit(1)

  if (!current) throw new GutscheinError(404, 'Gutschein nicht gefunden')
  if (current.status === 'eingeloest') throw new GutscheinError(400, 'Vollständig eingelöste Gutscheine können nicht storniert werden')
  if (current.status === 'storniert')  throw new GutscheinError(400, 'Gutschein ist bereits storniert')

  const [updated] = await db
    .update(gutscheine)
    .set({ status: 'storniert', updatedAt: new Date() })
    .where(and(eq(gutscheine.id, id), eq(gutscheine.mandantId, mandantId)))
    .returning()
  if (!updated) throw new GutscheinError(500, 'Stornierung fehlgeschlagen')

  const restCentVorher = Math.max(0, current.betragCent - current.bezahltCent)
  await erfasseBuchung(db, {
    gutscheinId:  id,
    mandantId,
    typ:          'storno',
    betragCent:   -restCentVorher,
    restCentNach: 0,
  })

  return toDto(updated)
}
