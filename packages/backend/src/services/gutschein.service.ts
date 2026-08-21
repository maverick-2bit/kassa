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

// ---------------------------------------------------------------------------
// Gutschein-Journal (Finanz-Anforderung): alle Bewegungen chronologisch,
// Codewechsel bei Restgutscheinen nachvollziehbar, plus tagesaktuelle Summe
// der offenen Gutscheine (= ausstehende Verbindlichkeit).
// ---------------------------------------------------------------------------

export interface GutscheinJournalEintrag {
  datum:            string
  typ:              string
  code:             string
  nummer:           number
  betragCent:       number
  restCentNach:     number
  /** Bei Codewechsel (Restgutschein): der NEUE Code */
  verknuepfterCode: string | null
  belegNummer:      number | null
  notiz:            string | null
}

export interface GutscheinJournal {
  von:       string
  bis:       string
  eintraege: GutscheinJournalEintrag[]
  /** Aktueller Bestand offener Gutscheine (aktiv + teileingelöst) — Stichtag JETZT */
  offen: {
    anzahl:               number
    summeCent:            number
    davonAbgelaufenCent:  number
  }
}

export async function holeGutscheinJournal(
  db:        Db,
  mandantId: string,
  von:       string,
  bis:       string,
): Promise<GutscheinJournal> {
  if (von > bis) throw new GutscheinError(400, '"von" muss vor oder gleich "bis" liegen')

  type JRow = {
    datum: string; typ: string; code: string; nummer: number
    betrag_cent: string; rest_cent_nach: string
    verknuepfter_code: string | null; beleg_nummer: number | null; notiz: string | null
  }
  const rows = await db.execute<JRow>(sql`
    SELECT
      b.created_at                                   AS datum,
      b.typ,
      g.code,
      g.nummer,
      b.betrag_cent,
      b.rest_cent_nach,
      vg.code                                        AS verknuepfter_code,
      be.beleg_nummer                                AS beleg_nummer,
      b.notiz
    FROM gutschein_buchungen b
    JOIN gutscheine g        ON g.id = b.gutschein_id
    LEFT JOIN gutscheine vg  ON vg.id = b.verknuepfter_gutschein_id
    LEFT JOIN belege be      ON be.id = b.beleg_id
    WHERE b.mandant_id = ${mandantId}
      AND (b.created_at AT TIME ZONE 'Europe/Vienna')::date >= ${von}::date
      AND (b.created_at AT TIME ZONE 'Europe/Vienna')::date <= ${bis}::date
    ORDER BY b.created_at DESC
  `)

  const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
  type ORow = { anzahl: string; summe: string; abgelaufen: string }
  const offenRows = await db.execute<ORow>(sql`
    SELECT
      COUNT(*)::int                                                                  AS anzahl,
      COALESCE(SUM(betrag_cent - bezahlt_cent), 0)::bigint                           AS summe,
      COALESCE(SUM(CASE WHEN gueltig_bis IS NOT NULL AND gueltig_bis < ${heute}
                        THEN betrag_cent - bezahlt_cent ELSE 0 END), 0)::bigint      AS abgelaufen
    FROM gutscheine
    WHERE mandant_id = ${mandantId} AND status IN ('aktiv', 'teileingeloest')
  `)
  const o = [...offenRows][0]

  return {
    von,
    bis,
    eintraege: [...rows].map(r => ({
      datum:            new Date(r.datum).toISOString(),
      typ:              r.typ,
      code:             r.code,
      nummer:           r.nummer,
      betragCent:       parseInt(r.betrag_cent, 10),
      restCentNach:     parseInt(r.rest_cent_nach, 10),
      verknuepfterCode: r.verknuepfter_code,
      belegNummer:      r.beleg_nummer,
      notiz:            r.notiz,
    })),
    offen: {
      anzahl:              o ? parseInt(o.anzahl, 10) : 0,
      summeCent:           o ? parseInt(o.summe, 10) : 0,
      davonAbgelaufenCent: o ? parseInt(o.abgelaufen, 10) : 0,
    },
  }
}

const JOURNAL_TYP_LABELS: Record<string, string> = {
  ausstellung:   'Ausstellung',
  einloesung:    'Einlösung',
  restgutschein: 'Restgutschein ausgestellt (Codewechsel)',
  storno:        'Storno',
}

/** CSV fürs Finanzamt/Steuerbüro — Semikolon-getrennt, de-AT-Formate. */
export function erstelleGutscheinJournalCsv(journal: GutscheinJournal): string {
  const fmtDatum  = new Intl.DateTimeFormat('de-AT', {
    timeZone: 'Europe/Vienna',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const euro = (cent: number) => (cent / 100).toFixed(2).replace('.', ',')

  const zeilen: string[] = []
  zeilen.push('Datum;Vorgang;Gutschein-Code;Nr.;Betrag EUR;Restwert danach EUR;Neuer Code (bei Restgutschein);Beleg-Nr.;Notiz')
  for (const e of journal.eintraege) {
    zeilen.push([
      fmtDatum.format(new Date(e.datum)),
      JOURNAL_TYP_LABELS[e.typ] ?? e.typ,
      e.code,
      String(e.nummer),
      euro(e.betragCent),
      euro(e.restCentNach),
      e.verknuepfterCode ?? '',
      e.belegNummer !== null ? String(e.belegNummer) : '',
      (e.notiz ?? '').replace(/;/g, ','),
    ].join(';'))
  }
  zeilen.push('')
  zeilen.push(`Offene Gutscheine (Stichtag ${fmtDatum.format(new Date())});${journal.offen.anzahl} Stück;;;${euro(journal.offen.summeCent)};;davon abgelaufen: ${euro(journal.offen.davonAbgelaufenCent)};;`)
  return '﻿' + zeilen.join('\r\n')
}
