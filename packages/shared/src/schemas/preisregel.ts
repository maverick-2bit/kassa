import { z } from 'zod'

// ---------------------------------------------------------------------------
// Preisregeln — zeitgesteuerte Aktionspreise (Happy Hour)
//
// Eine Regel senkt den Preis um einen Prozentsatz, wenn JETZT innerhalb eines
// ihrer Zeitfenster liegt UND der Tag passt (Wochentag ODER konkretes Datum)
// UND — falls gesetzt — innerhalb des Aktionszeitraums (gueltigVon..gueltigBis).
// Optional nur für bestimmte Warengruppen und/oder Einzel-Artikel.
// Wochentage: 1 = Montag … 7 = Sonntag (ISO-8601).
// ---------------------------------------------------------------------------

export const WochentagSchema = z.number().int().min(1).max(7)

export const WOCHENTAG_LABELS: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
}

const ZeitSchema  = z.string().regex(/^\d{2}:\d{2}$/, 'Uhrzeit im Format HH:MM')
const DatumSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format YYYY-MM-DD')

export const ZeitfensterSchema = z.object({ von: ZeitSchema, bis: ZeitSchema })
export type Zeitfenster = z.infer<typeof ZeitfensterSchema>

const PreisregelBaseSchema = z.object({
  name:          z.string().trim().min(1).max(80),
  aktiv:         z.boolean().default(true),
  /** Wochentage (leer erlaubt, wenn stattdessen konkrete Datumstage gesetzt sind) */
  wochentage:    z.array(WochentagSchema).max(7).default([]),
  /** Konkrete Kalendertage (YYYY-MM-DD), z. B. Feiertage/Events */
  datumTage:     z.array(DatumSchema).max(60).default([]),
  /** Ein oder mehrere Zeitfenster am Tag */
  zeitfenster:   z.array(ZeitfensterSchema).min(1, 'Mindestens ein Zeitfenster').max(10),
  /** Aktionszeitraum (optional): Regel gilt nur zwischen diesen Daten (inklusive) */
  gueltigVon:    DatumSchema.nullable().default(null),
  gueltigBis:    DatumSchema.nullable().default(null),
  rabattProzent: z.number().int().min(1).max(100),
  /** Betroffene Warengruppen (leer = keine Einschränkung über Warengruppen) */
  kategorieIds:  z.array(z.string().uuid()).max(200).default([]),
  /** Betroffene Einzel-Artikel (leer = keine Einschränkung über Artikel).
   *  kategorieIds UND artikelIds leer = gilt für ALLE Artikel. */
  artikelIds:    z.array(z.string().uuid()).max(500).default([]),
})

export const PreisregelInputSchema = PreisregelBaseSchema.refine(
  d => d.wochentage.length > 0 || d.datumTage.length > 0,
  { message: 'Mindestens ein Wochentag oder ein konkretes Datum erforderlich', path: ['wochentage'] },
)
export type PreisregelInput = z.infer<typeof PreisregelInputSchema>

export const PreisregelUpdateSchema = PreisregelBaseSchema.partial()
export type PreisregelUpdate = z.infer<typeof PreisregelUpdateSchema>

export const PreisregelSchema = z.object({
  id:            z.string().uuid(),
  name:          z.string(),
  aktiv:         z.boolean(),
  wochentage:    z.array(WochentagSchema),
  datumTage:     z.array(z.string()),
  zeitfenster:   z.array(ZeitfensterSchema),
  gueltigVon:    z.string().nullable(),
  gueltigBis:    z.string().nullable(),
  rabattProzent: z.number().int(),
  kategorieIds:  z.array(z.string().uuid()),
  artikelIds:    z.array(z.string().uuid()),
  createdAt:     z.string(),
  updatedAt:     z.string(),
})
export type Preisregel = z.infer<typeof PreisregelSchema>

// ---------------------------------------------------------------------------
// Anwendungslogik (geteilt Frontend ↔ Tests): gilt eine Regel jetzt?
// ---------------------------------------------------------------------------

/** Minuten seit Mitternacht aus "HH:MM". */
function zeitZuMinuten(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/** Liegt `jetzt` im Zeitfenster [von, bis)? Unterstützt über Mitternacht (von > bis). */
export function imZeitfenster(vonZeit: string, bisZeit: string, jetzt: Date): boolean {
  const t   = jetzt.getHours() * 60 + jetzt.getMinutes()
  const von = zeitZuMinuten(vonZeit)
  const bis = zeitZuMinuten(bisZeit)
  return von <= bis ? (t >= von && t < bis) : (t >= von || t < bis)
}

/** Liegt `jetzt` in mindestens einem der Zeitfenster? */
export function imAnyZeitfenster(zeitfenster: Zeitfenster[], jetzt: Date): boolean {
  return zeitfenster.some(zf => imZeitfenster(zf.von, zf.bis, jetzt))
}

/** ISO-Wochentag 1=Mo..7=So aus einem Date. */
export function isoWochentag(jetzt: Date): number {
  return jetzt.getDay() === 0 ? 7 : jetzt.getDay()
}

/** Lokales Datum als "YYYY-MM-DD". */
export function datumISO(jetzt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${jetzt.getFullYear()}-${p(jetzt.getMonth() + 1)}-${p(jetzt.getDate())}`
}

/**
 * Gilt die Regel für einen Artikel (mit seiner Kategorie) zum Zeitpunkt `jetzt`?
 * Tag passt, wenn der Wochentag ODER das konkrete Datum passt. Aktionszeitraum
 * (falls gesetzt) begrenzt zusätzlich. Geltungsbereich: sind Warengruppen und
 * Artikel leer, gilt die Regel für ALLE Artikel; sonst muss Artikel ODER
 * Warengruppe passen.
 */
export function regelGiltJetzt(
  regel: Preisregel,
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date,
): boolean {
  if (!regel.aktiv) return false

  // Aktionszeitraum (String-Vergleich funktioniert für YYYY-MM-DD)
  const heute = datumISO(jetzt)
  if (regel.gueltigVon && heute < regel.gueltigVon) return false
  if (regel.gueltigBis && heute > regel.gueltigBis) return false

  // Tag: Wochentag ODER konkretes Datum
  const tagPasst = regel.wochentage.includes(isoWochentag(jetzt)) || regel.datumTage.includes(heute)
  if (!tagPasst) return false

  // Zeit: irgendein Zeitfenster
  if (!imAnyZeitfenster(regel.zeitfenster, jetzt)) return false

  // Geltungsbereich Artikel/Warengruppe
  const hatScope = regel.kategorieIds.length > 0 || regel.artikelIds.length > 0
  if (hatScope) {
    const artikelMatch   = regel.artikelIds.includes(artikelId)
    const kategorieMatch = kategorieId !== null && regel.kategorieIds.includes(kategorieId)
    if (!artikelMatch && !kategorieMatch) return false
  }
  return true
}

/**
 * Höchster gerade gültiger Rabatt-Prozentsatz für einen Artikel (0 = keiner).
 * Bei mehreren passenden Regeln gewinnt der größte Rabatt.
 */
export function aktiverRabattProzent(
  regeln: Preisregel[],
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date = new Date(),
): number {
  let max = 0
  for (const r of regeln) {
    if (regelGiltJetzt(r, artikelId, kategorieId, jetzt) && r.rabattProzent > max) max = r.rabattProzent
  }
  return max
}

/** Wendet den aktuell gültigen Happy-Hour-Rabatt auf einen Basispreis an (kaufmännisch gerundet). */
export function happyHourPreisCent(
  basisPreisCent: number,
  regeln: Preisregel[],
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date = new Date(),
): number {
  const prozent = aktiverRabattProzent(regeln, artikelId, kategorieId, jetzt)
  if (prozent === 0) return basisPreisCent
  return Math.round(basisPreisCent * (100 - prozent) / 100)
}
